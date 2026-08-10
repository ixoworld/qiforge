import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import {
  getSandboxBridge,
  hasShellUnsafeChars,
  inferMimeFromPath,
  isUnderWorkspaceData,
  readSandboxFile,
  readSandboxResult,
  writeSandboxFile,
  type SandboxBridge,
} from '../sandbox/sandbox-bridge.js';
import type { SandboxMcpClientFactory } from '../sandbox/sandbox.plugin.js';
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
  mcpClientFactory?: SandboxMcpClientFactory,
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

      const bridge = await getSandboxBridge(
        ctx,
        deps.sandboxMcpUrl,
        mcpClientFactory,
      );
      if ('error' in bridge) return bridge.error;

      return runTransfer(ctx, bridge, { path: vfsPath }, async () => {
        const read = await readSandboxFile(bridge, sandboxPath);
        if ('error' in read) return read.error;

        const bytes = read.bytes;
        const mime = inferMimeFromPath(vfsPath);
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

      const bridge = await getSandboxBridge(
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

        const write = await writeSandboxFile(
          bridge,
          sandboxPath,
          isText ? buf.toString('utf8') : buf.toString('base64'),
          isText ? 'utf8' : 'base64',
        );
        if ('error' in write) return write.error;

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
