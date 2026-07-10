import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import {
  createDefaultAuthBuilder,
  SANDBOX_RUN_TOOL_NAME,
} from '../sandbox/sandbox-mcp.js';
import type {
  SandboxMcpClientFactory,
  SandboxMcpClientLike,
  SandboxMcpTool,
} from '../sandbox/sandbox.plugin.js';
import type { VfsFileStat } from './vfs-client.js';
import { isTextMime } from './vfs-content.js';
import {
  isAlreadyExistsConflict,
  mapVfsError,
  VfsAuthError,
  VfsHttpError,
} from './vfs-errors.js';
import { buildClient, invalidArgs, validatePath } from './vfs-tools.js';
import type { VfsConfig } from './vfs.plugin.js';

/** Upstream tool name the sandbox MCP surfaces for byte-perfect file writes. */
const SANDBOX_WRITE_FILE_TOOL_NAME = 'sandbox_write_file';

/** Per-call timeout for the sandbox MCP client (matches sandbox.plugin.ts). */
const SANDBOX_MCP_TIMEOUT_MS = 180_000;

/** Only destination the sandbox accepts for `sandbox_write_file` writes. */
const WORKSPACE_DATA_PREFIX = '/workspace/data/';

/** Sentinel echoed by the read command when the source file is absent. */
const NO_FILE_SENTINEL = '__VFS_NOFILE__';

/**
 * Shown when the user hasn't authorized the oracle to use the sandbox — the
 * default auth builder can't mint an `ixo:sandbox` invocation, so there's no
 * `Authorization` header to connect with. Non-throwing degradation.
 */
const SANDBOX_NOT_AUTHORIZED_MESSAGE =
  "You haven't authorized the sandbox yet — grant sandbox access in the portal so I can move files between it and your files.";

export interface CreateVfsSandboxToolsDeps {
  /** Validated VFS config (the subset of merged env the VFS plugin owns). */
  vfsCfg: VfsConfig;
  /** Sandbox MCP base URL — owned by the sandbox plugin, read as a sibling. */
  sandboxMcpUrl: string;
  /** Injected transport for the VFS client in tests. Defaults to global `fetch`. */
  vfsFetchImpl?: typeof fetch;
  /** Retry backoff forwarded to the VFS client. Tests pass `0`. */
  vfsRetryDelayMs?: number;
}

/**
 * Default sandbox MCP-client factory. Wraps a real `MultiServerMCPClient` in
 * the minimal {@link SandboxMcpClientLike} surface the bridge needs, adapting
 * each upstream `DynamicStructuredTool` into a plain {@link SandboxMcpTool}.
 * Tests inject a stub instead so no real MCP connection is opened.
 */
const defaultMcpClientFactory: SandboxMcpClientFactory = (config) => {
  const client = new MultiServerMCPClient(config);
  const wrapper: SandboxMcpClientLike = {
    getTools: async () => {
      const tools = await client.getTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        // The schema is never read by the bridge (we only `invoke`); keep the
        // upstream Zod schema when present, else a permissive placeholder.
        schema: t.schema instanceof z.ZodType ? t.schema : z.unknown(),
        invoke: (input: unknown) => t.invoke(input),
      }));
    },
    close: () => client.close(),
  };
  return wrapper;
};

/** Live sandbox `sandbox_run` + `sandbox_write_file` handles plus a closer. */
interface SandboxBridge {
  run: SandboxMcpTool;
  writeFile: SandboxMcpTool;
  /** Always safe — swallows and logs any close error. */
  close: () => Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** MIME map skewed toward binary outputs; unknown extensions stay opaque. */
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  sh: 'application/x-sh',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function inferMime(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

function isUnderWorkspaceData(path: string): boolean {
  return path.startsWith(WORKSPACE_DATA_PREFIX);
}

/**
 * `true` when a sandbox path can't be safely single-quoted into a shell
 * command (`sandbox_run`). We reject rather than risk breaking the command.
 */
function hasShellUnsafeChars(path: string): boolean {
  return path.includes("'") || path.includes('\n') || path.includes('\0');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface SandboxOutcome {
  /** `false` when the envelope reports `success:false` or a non-zero exit. */
  ok: boolean;
  /** Captured stdout when the envelope exposes it, else the whole result. */
  output: string;
  /** The stringified result, for surfacing in an error message. */
  text: string;
}

/**
 * Read a sandbox MCP result defensively. The upstream returns either a JSON
 * envelope (`{ success, exitCode, output, ... }`) or a bare string; both are
 * handled. `output` is the captured stdout when present, otherwise the whole
 * stringified result.
 *
 * ASSUMPTION (verify against a live sandbox): stdout lives in the `output`
 * field and `success` / `exitCode` are top-level — the shape the sandbox
 * manifest documents.
 */
function readSandboxResult(result: unknown): SandboxOutcome {
  const text = typeof result === 'string' ? result : safeStringify(result);

  let envelope: unknown = isRecord(result) ? result : undefined;
  if (typeof result === 'string') {
    try {
      envelope = JSON.parse(result);
    } catch {
      envelope = undefined;
    }
  }

  let output: string | undefined;
  let success: boolean | undefined;
  let exitCode: number | undefined;
  if (isRecord(envelope)) {
    if (typeof envelope.output === 'string') output = envelope.output;
    if (typeof envelope.success === 'boolean') success = envelope.success;
    if (typeof envelope.exitCode === 'number') exitCode = envelope.exitCode;
  }

  const failedByFlag = success === false || /"success"\s*:\s*false/i.test(text);
  const failedByExit = exitCode !== undefined && exitCode !== 0;
  return { ok: !failedByFlag && !failedByExit, output: output ?? text, text };
}

/**
 * Mint sandbox auth headers, connect an MCP client, and resolve the two tools
 * the bridge needs. Non-throwing: every failure comes back as `{ error }` with
 * an agent-facing message. On success the caller MUST `close()` in a finally.
 */
async function getSandboxTools(
  rtCtx: RuntimeContext,
  sandboxMcpUrl: string,
  mcpClientFactory: SandboxMcpClientFactory,
): Promise<SandboxBridge | { error: string }> {
  let headers: Record<string, string>;
  try {
    headers = await createDefaultAuthBuilder()(
      { sandboxMcpUrl, oracleSecrets: {}, userSecrets: {} },
      rtCtx,
    );
  } catch (err) {
    rtCtx.logger.warn(
      `[vfs] sandbox auth failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { error: SANDBOX_NOT_AUTHORIZED_MESSAGE };
  }

  if (!headers.Authorization) {
    return { error: SANDBOX_NOT_AUTHORIZED_MESSAGE };
  }

  const client = mcpClientFactory({
    mcpServers: {
      sandbox: {
        type: 'http',
        url: sandboxMcpUrl,
        transport: 'http',
        headers,
      },
    },
    defaultToolTimeout: SANDBOX_MCP_TIMEOUT_MS,
    useStandardContentBlocks: true,
  });

  const close = async (): Promise<void> => {
    try {
      await client.close();
    } catch (err) {
      rtCtx.logger.warn(
        `[vfs] failed to close sandbox MCP client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  let tools: SandboxMcpTool[];
  try {
    tools = await client.getTools();
  } catch (err) {
    await close();
    rtCtx.logger.warn(
      `[vfs] could not list sandbox tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { error: 'Could not connect to the sandbox right now.' };
  }

  const run = tools.find((t) => t.name === SANDBOX_RUN_TOOL_NAME);
  const writeFile = tools.find((t) => t.name === SANDBOX_WRITE_FILE_TOOL_NAME);
  if (!run || !writeFile) {
    await close();
    return {
      error:
        'The sandbox is not exposing the file tools needed to move files right now.',
    };
  }

  return { run, writeFile, close };
}

/**
 * Run a transfer body, mapping VFS auth/HTTP errors to their agent-facing
 * string and any other throw to a short generic message, then close the
 * sandbox bridge. A handler never throws out to the graph.
 */
async function runTransfer(
  ctx: RuntimeContext,
  bridge: SandboxBridge,
  info: { path?: string },
  fn: () => Promise<string>,
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VfsHttpError || err instanceof VfsAuthError) {
      return mapVfsError(err, info);
    }
    ctx.logger.warn(
      `[vfs] sandbox transfer failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'The file transfer failed.';
  } finally {
    await bridge.close();
  }
}

const sandboxToVfsSchema = z.object({
  sandboxPath: z
    .string()
    .min(1)
    .describe(
      'Absolute path of the file inside the sandbox to save, e.g. /workspace/data/output/report.pdf or /workspace/output/export.csv.',
    ),
  vfsPath: z
    .string()
    .min(1)
    .describe(
      "Absolute destination path in the user's files, e.g. /reports/q3.pdf. The extension sets the stored file type.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Replace an existing file at vfsPath instead of failing. Default false.',
    ),
  deleteSource: z
    .boolean()
    .optional()
    .describe(
      'Delete the sandbox file after a successful save (move instead of copy). Default false.',
    ),
});

const vfsToSandboxSchema = z.object({
  vfsPath: z
    .string()
    .min(1)
    .describe(
      "Absolute path of the user's file to bring in, e.g. /data/sales.csv.",
    ),
  sandboxPath: z
    .string()
    .min(1)
    .describe(
      'Absolute destination in the sandbox. Must be under /workspace/data/, e.g. /workspace/data/input/sales.csv.',
    ),
  deleteSource: z
    .boolean()
    .optional()
    .describe(
      'Move the file to trash after copying it into the sandbox. Default false (copy).',
    ),
});

/**
 * Build the two sandbox↔VFS bridge tools. Each reads the bytes on one side and
 * writes them on the other entirely server-side — the file content never
 * passes through the LLM. The sandbox MCP client is built on demand inside the
 * handler and always closed, so an unused bridge adds zero per-turn overhead.
 */
export function createVfsSandboxTools(
  deps: CreateVfsSandboxToolsDeps,
  mcpClientFactory: SandboxMcpClientFactory = defaultMcpClientFactory,
): PluginTool[] {
  const vfsClient = (ctx: RuntimeContext) =>
    buildClient(ctx, {
      cfg: deps.vfsCfg,
      fetchImpl: deps.vfsFetchImpl,
      retryDelayMs: deps.vfsRetryDelayMs,
    });

  const sandboxToVfs = tool(
    async (raw, ctx) => {
      const parsed = sandboxToVfsSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { sandboxPath, vfsPath } = parsed.data;
      const overwrite = parsed.data.overwrite ?? false;
      const deleteSource = parsed.data.deleteSource ?? false;

      if (hasShellUnsafeChars(sandboxPath)) {
        return `The sandbox path contains characters I can't safely handle (quotes or newlines). Rename it and try again.`;
      }
      const vfsErr = validatePath(vfsPath);
      if (vfsErr) return `Invalid destination path: ${vfsErr}`;

      const bridge = await getSandboxTools(
        ctx,
        deps.sandboxMcpUrl,
        mcpClientFactory,
      );
      if ('error' in bridge) return bridge.error;

      return runTransfer(ctx, bridge, { path: vfsPath }, async () => {
        const read = readSandboxResult(
          await bridge.run.invoke({
            code: `test -f '${sandboxPath}' && base64 -w0 '${sandboxPath}' || echo ${NO_FILE_SENTINEL}`,
          }),
        );
        if (!read.ok) {
          return `Couldn't read \`${sandboxPath}\` from the sandbox: ${truncate(read.text)}`;
        }
        const stdout = read.output.trim();
        if (stdout === NO_FILE_SENTINEL) {
          return `No file at \`${sandboxPath}\` in the sandbox.`;
        }

        const bytes = Buffer.from(stdout, 'base64');
        const mime = inferMime(vfsPath);
        const client = vfsClient(ctx);

        let created: VfsFileStat;
        try {
          created = await client.create(vfsPath, bytes, mime);
        } catch (err) {
          if (!isAlreadyExistsConflict(err)) throw err;
          if (!overwrite) {
            return `A file already exists at \`${vfsPath}\` (set overwrite to replace it).`;
          }
          const stat = await client.statByPath(vfsPath);
          if (!stat) {
            throw new VfsHttpError({
              status: 404,
              message: `No such file at ${vfsPath}`,
              raw: '',
            });
          }
          created = await client.replace(stat.id, bytes, mime);
        }

        let deletedSource = false;
        let note: string | undefined;
        if (deleteSource) {
          const rm = readSandboxResult(
            await bridge.run.invoke({ code: `rm -f '${sandboxPath}'` }),
          );
          deletedSource = rm.ok;
          if (!rm.ok) note = 'could not delete the sandbox source file';
        }

        return JSON.stringify({
          ok: true,
          vfsPath,
          bytes: bytes.length,
          cid: created.id || undefined,
          movedFromSandbox: sandboxPath,
          deletedSource,
          ...(note ? { note } : {}),
        });
      });
    },
    {
      name: 'sandbox_to_vfs',
      description:
        "Save a file the sandbox produced (a generated report, export, chart, dataset under /workspace/…) into the user's permanent files so it persists and is searchable. Copies by default; set deleteSource to move.",
      schema: sandboxToVfsSchema,
    },
  );

  const vfsToSandbox = tool(
    async (raw, ctx) => {
      const parsed = vfsToSandboxSchema.safeParse(raw);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { vfsPath, sandboxPath } = parsed.data;
      const deleteSource = parsed.data.deleteSource ?? false;

      if (!isUnderWorkspaceData(sandboxPath)) {
        return `The sandbox destination must be under /workspace/data/ (got \`${sandboxPath}\`). Pick something like /workspace/data/input/<name>.`;
      }
      const vfsErr = validatePath(vfsPath);
      if (vfsErr) return `Invalid source path: ${vfsErr}`;

      const bridge = await getSandboxTools(
        ctx,
        deps.sandboxMcpUrl,
        mcpClientFactory,
      );
      if ('error' in bridge) return bridge.error;

      return runTransfer(ctx, bridge, { path: vfsPath }, async () => {
        const client = vfsClient(ctx);
        const stat = await client.statByPath(vfsPath);
        if (!stat) return `No such file at \`${vfsPath}\`.`;

        const { bytes, mimeType } = await client.contentBytes(stat.id);
        const buf = Buffer.from(bytes);
        const isText = isTextMime(mimeType || stat.mimeType || '');

        const write = readSandboxResult(
          await bridge.writeFile.invoke(
            isText
              ? {
                  path: sandboxPath,
                  content: buf.toString('utf8'),
                  encoding: 'utf8',
                }
              : {
                  path: sandboxPath,
                  content: buf.toString('base64'),
                  encoding: 'base64',
                },
          ),
        );
        if (!write.ok) {
          return `Couldn't write \`${sandboxPath}\` in the sandbox: ${truncate(write.text)}`;
        }

        let deletedSource = false;
        let note: string | undefined;
        if (deleteSource) {
          const results = await client.trash([stat.id]);
          deletedSource = !results.some((r) => !r.ok);
          note = deletedSource
            ? 'source moved to the files trash (recoverable)'
            : 'could not move the source to trash';
        }

        return JSON.stringify({
          ok: true,
          sandboxPath,
          bytes: buf.length,
          movedFromVfs: vfsPath,
          deletedSource,
          ...(note ? { note } : {}),
        });
      });
    },
    {
      name: 'vfs_to_sandbox',
      description:
        "Bring one of the user's files into the sandbox (under /workspace/data/) so code in `sandbox_run` can process it. Copies by default; set deleteSource to move it out of the files (to trash).",
      schema: vfsToSandboxSchema,
    },
  );

  return [sandboxToVfs, vfsToSandbox];
}
