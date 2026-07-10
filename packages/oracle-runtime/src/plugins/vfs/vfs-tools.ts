import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import { vfsBearer } from './vfs-auth.js';
import {
  VfsClient,
  type VfsBatchItemResult,
  type VfsSearchHit,
  type VfsTreeEntry,
} from './vfs-client.js';
import { readForAgent } from './vfs-content.js';
import {
  VfsAuthError,
  VfsHttpError,
  isAlreadyExistsConflict,
  isWriteConflict,
  mapVfsError,
} from './vfs-errors.js';
import type { VfsConfig } from './vfs.plugin.js';

export interface CreateVfsToolsDeps {
  cfg: VfsConfig;
  /** Injected transport for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Retry backoff forwarded to {@link VfsClient}. Tests pass `0`. */
  retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Client-side validation (mirrors the VFS so a bad path never round-trips).
// ---------------------------------------------------------------------------

export function validatePath(path: string): string | null {
  if (path.length === 0) return 'path is required';
  if (path.length > 1024) return 'path must be at most 1024 characters';
  if (!path.startsWith('/')) return 'path must be absolute (start with "/")';
  if (path === '/') return null;
  if (path.includes('\0')) return 'path must not contain a null byte';
  if (path.includes('//')) return 'path must not contain "//"';
  if (path.endsWith('/')) return 'path must not end with "/"';
  for (const seg of path.slice(1).split('/')) {
    if (seg === '.' || seg === '..') {
      return 'path must not contain "." or ".." segments';
    }
  }
  return null;
}

const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  sh: 'application/x-sh',
};

function guessMime(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  return EXT_MIME[ext] ?? 'text/plain';
}

// ---------------------------------------------------------------------------
// Output formatting (compact strings — a tool message carries text only).
// ---------------------------------------------------------------------------

function formatHits(hits: VfsSearchHit[], semantic: boolean): string {
  const header = semantic
    ? ''
    : '(semantic search unavailable — showing lexical matches only)\n';
  if (hits.length === 0) return `${header}No matching files.`;
  const lines = hits.map((h, i) => {
    const range =
      h.lineStart !== undefined
        ? ` (lines ${h.lineStart}${h.lineEnd !== undefined && h.lineEnd !== h.lineStart ? `-${h.lineEnd}` : ''})`
        : '';
    return `${i + 1}. ${h.path}${range}`;
  });
  return `${header}Found ${hits.length} file(s):\n${lines.join('\n')}\n\nUse vfs_read to see the lines before answering or editing.`;
}

function formatEntries(path: string, entries: VfsTreeEntry[]): string {
  if (entries.length === 0) return `\`${path}\` is empty or does not exist.`;
  const lines = entries.map(
    (e) => `- ${e.path}${e.type === 'folder' ? '/' : ''}`,
  );
  return `Contents of \`${path}\`:\n${lines.join('\n')}`;
}

function summarizeBatch(
  results: VfsBatchItemResult[],
  verb: string,
  total: number,
): string {
  if (results.length === 0) return `${verb} ${total} item(s).`;
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return `${verb} ${results.length} item(s).`;
  const ok = results.length - failed.length;
  const details = failed
    .map(
      (r) =>
        `- ${r.path ?? r.id ?? '?'}: ${r.error ?? `status ${r.status ?? '?'}`}`,
    )
    .join('\n');
  return `${verb} ${ok} of ${results.length}. Failed:\n${details}`;
}

// ---------------------------------------------------------------------------
// Shared handler plumbing.
// ---------------------------------------------------------------------------

/**
 * Mount prefix of the VFS worker's file API (`app.route('/api/fs', fsRoutes)`).
 * `VFS_BASE_URL` is the worker host (used bare for did:web resolution, which
 * reads only the origin); the file endpoints (`/tree`, `/files`, `/glob`, …)
 * live under this prefix — mirroring how the store client appends
 * `/api/delegations` to its host.
 */
const VFS_API_BASE_PATH = '/api/fs';

export function buildClient(
  ctx: RuntimeContext,
  deps: CreateVfsToolsDeps,
): VfsClient {
  return new VfsClient({
    baseUrl: `${deps.cfg.VFS_BASE_URL.replace(/\/+$/, '')}${VFS_API_BASE_PATH}`,
    timeoutMs: deps.cfg.VFS_REQUEST_TIMEOUT_MS,
    signal: ctx.abortSignal,
    fetchImpl: deps.fetchImpl,
    retryDelayMs: deps.retryDelayMs,
    mint: (ability) => vfsBearer(ctx, deps.cfg, ability),
  });
}

/**
 * Run a tool body, converting a {@link VfsHttpError} / {@link VfsAuthError}
 * into the agent-facing string. Any other throw is logged and returned as a
 * generic failure — a tool never throws out to the graph.
 */
/**
 * The oracle's own DID (from the `ORACLE_DID` env), surfaced to the user in the
 * no-access / 403 message so they can paste it into the portal's "Recipient
 * DID" field when granting the agent access. Absent → the message omits it.
 */
function readOracleDid(ctx: RuntimeContext): string | undefined {
  const parsed = z
    .object({ ORACLE_DID: z.string().min(1) })
    .safeParse(ctx.config);
  return parsed.success ? parsed.data.ORACLE_DID : undefined;
}

async function guard(
  ctx: RuntimeContext,
  info: { path?: string },
  fn: () => Promise<string>,
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VfsHttpError || err instanceof VfsAuthError) {
      return mapVfsError(err, { ...info, oracleDid: readOracleDid(ctx) });
    }
    ctx.logger.warn(
      `[vfs] unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'Filesystem request failed.';
  }
}

/** Retry a mutation once on a `409 modified concurrently` (spec §7). */
async function withConflictRetry<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isWriteConflict(err)) return op();
    throw err;
  }
}

export function invalidArgs(err: z.ZodError): string {
  return `Invalid arguments: ${err.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  q: z
    .string()
    .min(1)
    .max(512)
    .describe('What to look for, in natural language.'),
  path: z
    .string()
    .optional()
    .describe(
      'Folder to search under. Defaults to the whole filesystem ("/").',
    ),
});

const grepSchema = z.object({
  q: z
    .string()
    .min(1)
    .max(512)
    .describe('The exact word or identifier to find inside files.'),
  path: z
    .string()
    .optional()
    .describe('Folder to search under. Defaults to "/".'),
});

const globSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .max(512)
    .describe('A glob over paths, e.g. "/notes/*.md" or "**/*.pdf".'),
});

const listSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('Folder to list. Defaults to the root ("/").'),
});

const readSchema = z.object({
  path: z.string().describe('Absolute path of the file to read.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'First line to return (1-based) when paging a long text file. Defaults to 1.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Max lines to return (capped by the oracle).'),
});

const writeSchema = z.object({
  path: z.string().describe('Absolute path of the file to create.'),
  content: z.string().describe('The full text content of the file.'),
  mimeType: z
    .string()
    .optional()
    .describe('Content type. Inferred from the extension when omitted.'),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Only set true when the user explicitly asked to replace an existing file.',
    ),
});

const editSchema = z.object({
  path: z.string().describe('Absolute path of the file to edit.'),
  oldString: z
    .string()
    .min(1)
    .describe(
      'Exact text to replace. Must match once unless replaceAll is set.',
    ),
  newString: z.string().describe('Replacement text.'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a unique match.'),
});

const moveSchema = z.object({
  from: z.string().describe('Absolute source path.'),
  to: z.string().describe('Absolute destination path.'),
});

const deleteSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(1000)
    .describe('Absolute paths to move to trash.'),
});

const shareSchema = z.object({
  path: z.string().describe('Absolute path of the file or folder to publish.'),
  public: z
    .boolean()
    .optional()
    .describe('true to publish (default), false to unpublish.'),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Build the ten VFS tools. Each handler validates args + path client-side,
 * builds a {@link VfsClient} that resolves auth per call, and returns a
 * compact string. Auth/HTTP failures come back as {@link mapVfsError} strings,
 * never throws.
 */
export function createVfsTools(deps: CreateVfsToolsDeps): PluginTool[] {
  const client = (ctx: RuntimeContext) => buildClient(ctx, deps);

  const searchTool = tool(
    async (raw, ctx) => {
      const parsed = searchSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const path = parsed.data.path ?? '/';
      const pathErr = validatePath(path);
      if (pathErr) return `Invalid path: ${pathErr}`;
      return guard(ctx, {}, async () => {
        const { results, semantic } = await client(ctx).search(
          parsed.data.q,
          path,
        );
        return formatHits(results, semantic);
      });
    },
    {
      name: 'vfs_search',
      description:
        "Find files by meaning across the user's filesystem. Use for questions and paraphrases ('the doc about pricing'). Returns file paths + cited line ranges. Follow with `vfs_read` to see the actual lines before answering or editing.",
      schema: searchSchema,
    },
  );

  const grepTool = tool(
    async (raw, ctx) => {
      const parsed = grepSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const path = parsed.data.path ?? '/';
      const pathErr = validatePath(path);
      if (pathErr) return `Invalid path: ${pathErr}`;
      return guard(ctx, {}, async () => {
        const hits = await client(ctx).grep(parsed.data.q, path);
        return formatHits(hits, true);
      });
    },
    {
      name: 'vfs_grep',
      description:
        'Find files containing an exact word or identifier. Use when you know a literal term; use `vfs_search` for concepts.',
      schema: grepSchema,
    },
  );

  const globTool = tool(
    async (raw, ctx) => {
      const parsed = globSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      return guard(ctx, {}, async () => {
        const matches = await client(ctx).glob(parsed.data.pattern);
        if (matches.length === 0) return 'No files match that pattern.';
        return `${matches.length} match(es):\n${matches.map((m) => m.path).join('\n')}`;
      });
    },
    {
      name: 'vfs_glob',
      description:
        'Find files by name or path pattern (glob), e.g. `/notes/*.md` or `**/*.pdf`. Use when you know part of the name or extension; use `vfs_search` for meaning and `vfs_grep` for exact text inside files.',
      schema: globSchema,
    },
  );

  const listTool = tool(
    async (raw, ctx) => {
      const parsed = listSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const path = parsed.data.path ?? '/';
      const pathErr = validatePath(path);
      if (pathErr) return `Invalid path: ${pathErr}`;
      return guard(ctx, {}, async () => {
        const entries = await client(ctx).list(path);
        return formatEntries(path, entries);
      });
    },
    {
      name: 'vfs_list',
      description:
        'List the files and folders under a path. Use to explore what the user has before searching, or to confirm a path exists.',
      schema: listSchema,
    },
  );

  const readTool = tool(
    async (raw, ctx) => {
      const parsed = readSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const pathErr = validatePath(parsed.data.path);
      if (pathErr) return `Invalid path: ${pathErr}`;
      const offset = parsed.data.offset ?? 1;
      const limit = Math.min(
        parsed.data.limit ?? deps.cfg.VFS_MAX_READ_LINES,
        deps.cfg.VFS_MAX_READ_LINES,
        5000,
      );
      return guard(ctx, { path: parsed.data.path }, () =>
        readForAgent(client(ctx), ctx, parsed.data.path, offset, limit),
      );
    },
    {
      name: 'vfs_read',
      description:
        "Read a file's contents by path. Text files come back a window of numbered lines at a time (default first 2000; page with `offset` when `hasMore`). Images and PDFs are read too — described/transcribed for you. Always read before editing or answering from a file; do not guess its contents. Reading an image costs an extra step, so read it only when you need to see it.",
      schema: readSchema,
    },
  );

  const writeTool = tool(
    async (raw, ctx) => {
      const parsed = writeSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { path, content, overwrite } = parsed.data;
      const pathErr = validatePath(path);
      if (pathErr) return `Invalid path: ${pathErr}`;
      const mime = parsed.data.mimeType ?? guessMime(path);
      const c = client(ctx);
      return guard(ctx, { path }, async () => {
        try {
          const created = await c.create(path, content, mime);
          return `Created \`${created.path || path}\`.`;
        } catch (err) {
          if (!isAlreadyExistsConflict(err)) throw err;
          if (!overwrite) {
            return `A file already exists at \`${path}\`. Ask the user before overwriting it.`;
          }
          // Replace the existing file, retrying once if another writer raced us.
          return withConflictRetry(async () => {
            const stat = await c.statByPath(path);
            if (!stat) {
              throw new VfsHttpError({
                status: 404,
                message: `No such file at ${path}`,
                raw: '',
              });
            }
            await c.replace(stat.id, content, mime);
            return `Replaced \`${path}\`.`;
          });
        }
      });
    },
    {
      name: 'vfs_write',
      description:
        "Create a new text file at a path (or, only when the user asked to replace it, overwrite an existing one). Announce what you're creating. If the path already exists and the user did not ask to overwrite, stop and ask.",
      schema: writeSchema,
    },
  );

  const editTool = tool(
    async (raw, ctx) => {
      const parsed = editSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { path, oldString, newString, replaceAll } = parsed.data;
      const pathErr = validatePath(path);
      if (pathErr) return `Invalid path: ${pathErr}`;
      const c = client(ctx);
      return guard(ctx, { path }, () =>
        withConflictRetry(async () => {
          const stat = await c.statByPath(path);
          if (!stat) {
            throw new VfsHttpError({
              status: 404,
              message: `No such file at ${path}`,
              raw: '',
            });
          }
          const result = await c.edit(
            stat.id,
            oldString,
            newString,
            replaceAll ?? false,
          );
          const n = result.replacements;
          return n !== undefined && n > 1
            ? `Edited \`${path}\` (${n} replacements).`
            : `Edited \`${path}\`.`;
        }),
      );
    },
    {
      name: 'vfs_edit',
      description:
        'Change an exact string in a file. `oldString` must match once (or set `replaceAll`). Read the file first so `oldString` is exact. Prefer this over rewriting the whole file.',
      schema: editSchema,
    },
  );

  const moveTool = tool(
    async (raw, ctx) => {
      const parsed = moveSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { from, to } = parsed.data;
      const fromErr = validatePath(from);
      if (fromErr) return `Invalid "from" path: ${fromErr}`;
      const toErr = validatePath(to);
      if (toErr) return `Invalid "to" path: ${toErr}`;
      const c = client(ctx);
      return guard(ctx, { path: from }, () =>
        withConflictRetry(async () => {
          // The worker addresses moves by file id, not source path — resolve it.
          const stat = await c.statByPath(from);
          if (!stat) {
            throw new VfsHttpError({
              status: 404,
              message: `No such file at ${from}`,
              raw: '',
            });
          }
          const results = await c.move([{ id: stat.id, destinationPath: to }]);
          const failed = results.find((r) => !r.ok);
          if (failed) {
            return `Couldn't move \`${from}\` to \`${to}\`: ${failed.error ?? `status ${failed.status ?? '?'}`}.`;
          }
          return `Moved \`${from}\` to \`${to}\`.`;
        }),
      );
    },
    {
      name: 'vfs_move',
      description:
        'Move or rename a file or folder. Confirm destructive actions with the user first.',
      schema: moveSchema,
    },
  );

  const deleteTool = tool(
    async (raw, ctx) => {
      const parsed = deleteSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      for (const p of parsed.data.paths) {
        const err = validatePath(p);
        if (err) return `Invalid path "${p}": ${err}`;
      }
      const c = client(ctx);
      return guard(ctx, {}, async () => {
        const resolved = await Promise.all(
          parsed.data.paths.map(async (p) => ({
            path: p,
            stat: await c.statByPath(p),
          })),
        );
        const missing = resolved
          .filter((x) => x.stat === null)
          .map((x) => x.path);
        const ids = resolved.flatMap((x) => (x.stat ? [x.stat.id] : []));
        if (ids.length === 0) {
          return `No such file(s): ${parsed.data.paths.join(', ')}.`;
        }
        const results = await c.trash(ids);
        let summary = summarizeBatch(results, 'Moved to trash', ids.length);
        if (missing.length > 0) {
          summary += `\nNot found (skipped): ${missing.join(', ')}.`;
        }
        return summary;
      });
    },
    {
      name: 'vfs_delete',
      description:
        'Move a file or folder to trash (recoverable). Confirm destructive actions with the user first. Deletes go to trash, not permanent.',
      schema: deleteSchema,
    },
  );

  const shareTool = tool(
    async (raw, ctx) => {
      const parsed = shareSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { path } = parsed.data;
      const pub = parsed.data.public ?? true;
      const pathErr = validatePath(path);
      if (pathErr) return `Invalid path: ${pathErr}`;
      const c = client(ctx);
      return guard(ctx, { path }, async () => {
        const stat = await c.statByPath(path);
        const result = stat
          ? await c.setFilePublic(stat.id, pub)
          : await c.setFolderPublic(path, pub);
        if (!pub) return `\`${path}\` is no longer public.`;
        return result.publicUrl
          ? `\`${path}\` is now public: ${result.publicUrl}`
          : `\`${path}\` is now public.`;
      });
    },
    {
      name: 'vfs_share',
      description:
        'Publish a file or folder so anyone with the link can download it, and return the link. Only when the user asks to share/make public — publishing is visible to anyone with the link.',
      schema: shareSchema,
    },
  );

  return [
    searchTool,
    grepTool,
    globTool,
    listTool,
    readTool,
    writeTool,
    editTool,
    moveTool,
    deleteTool,
    shareTool,
  ];
}
