import { z } from 'zod';
import { tool as pluginTool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { SandboxMcpTool } from './sandbox.plugin.js';

const sandboxWriteBlobSchema = z.object({
  blobId: z
    .string()
    .describe(
      'The blobId returned by the tool that produced the value (e.g. mint_invocation). Format: `blob_<16 hex chars>`.',
    ),
  path: z
    .string()
    .describe(
      'Destination path in the sandbox, e.g. `/workspace/data/<skill>/ucan_token`. Must be under /workspace/data/.',
    ),
});

const SANDBOX_WRITE_BLOB_DESCRIPTION = `Write a server-stored blob to a file in the sandbox without ever paste-relaying the value through the LLM.

Use this whenever a tool returns a \`blobId\` (e.g. \`mint_invocation\`'s response). Pass the blobId + the destination path; the runtime looks the value up server-side and calls sandbox_write_file with its content. The long opaque value (base64 CARs, JWTs, etc.) never enters the LLM context — eliminates string-corruption-in-relay as a failure mode.

Inputs:
  - blobId: short hex identifier returned by the producing tool (format \`blob_<16 hex chars>\`).
  - path: destination path in the sandbox. Must be under \`/workspace/data/\` (the sandbox enforces this; writes elsewhere are rejected).

Returns: \`{ success: true, path, bytesWritten }\` on success, \`{ success: false, error }\` on failure. Common errors: blob not found (re-mint and retry — for invocations this can happen on a multi-replica deployment if the lookup lands on a different process), invalid blobId format, path outside /workspace/data/.`;

export interface CreateSandboxWriteBlobToolParams {
  /** Upstream MCP `sandbox_write_file` tool — looked up once per request from
   * the MCP client's tool list. Required; without it the wrapper has nothing
   * to forward to. */
  sandboxWriteFileTool: SandboxMcpTool;
}

/**
 * `sandbox_write_blob` — companion to `mint_invocation`. Takes a `blobId`
 * (server-side stored long string) and a sandbox path; looks up the blob in
 * the `BlobStore` and calls the underlying `sandbox_write_file` MCP tool
 * with the value. The LLM only ever passes the short blobId + path — long
 * base64 strings (UCAN CARs etc.) never enter its context, so they can't be
 * corrupted in transit.
 *
 * The plugin must only register this tool when the upstream `sandbox_write_file`
 * tool exists AND the request has a known user DID — without either the
 * wrapper degrades into an always-failing stub, which is worse than absent.
 */
export function createSandboxWriteBlobTool(
  params: CreateSandboxWriteBlobToolParams,
): PluginTool {
  return pluginTool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { blobId, path } = sandboxWriteBlobSchema.parse(rawArgs);

      if (!ctx.blobStore.isValidBlobId(blobId)) {
        return JSON.stringify({
          success: false,
          error: `Invalid blobId format. Expected blob_<16 hex chars>, got "${blobId}".`,
        });
      }
      if (typeof path !== 'string' || !path.startsWith('/workspace/data/')) {
        return JSON.stringify({
          success: false,
          error: `path must be under /workspace/data/. Got: "${path}".`,
        });
      }

      const userDid = ctx.user.did;
      const blob = await ctx.blobStore.get({ userDid, blobId });
      if (!blob) {
        return JSON.stringify({
          success: false,
          error: `Blob "${blobId}" not found (expired, never existed, or owned by another user). Re-mint and retry — for single-use invocations this is expected if the blob's TTL elapsed.`,
        });
      }

      try {
        const result = await params.sandboxWriteFileTool.invoke({
          path,
          content: blob.value,
          encoding: 'utf8',
        });
        return JSON.stringify({
          success: true,
          path,
          bytesWritten: blob.value.length,
          blobName: blob.name,
          note: typeof result === 'string' ? result : undefined,
        });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `sandbox_write_file failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    {
      name: 'sandbox_write_blob',
      description: SANDBOX_WRITE_BLOB_DESCRIPTION,
      schema: sandboxWriteBlobSchema,
    },
  );
}
