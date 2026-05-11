import {
  MultiServerMCPClient,
  type ClientConfig,
} from '@langchain/mcp-adapters';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type {
  SandboxAuthBuilder,
  SandboxHeaderInputs,
} from './sandbox-mcp.js';
import { parseOracleSecrets } from './sandbox-mcp.js';

/**
 * Minimal MCP-client surface the sandbox tool relies on. Declared
 * structurally so tests can supply a lightweight stub without faking the
 * full `MultiServerMCPClient` API. The real client (constructed by the
 * default factory) satisfies this shape — see the matching getTools/close
 * methods on `@langchain/mcp-adapters`.
 */
export interface SandboxMcpClientLike {
  getTools(): Promise<
    Array<{ name: string; invoke(input: unknown): Promise<unknown> }>
  >;
  close(): Promise<void>;
}

/** Tool name surfaced to the agent (matches today's sandbox MCP). */
export const SANDBOX_RUN_TOOL_NAME = 'sandbox_run';

/**
 * Permissive schema for `sandbox_run`. The real argument validation lives in
 * the sandbox MCP server itself — exposing its full Zod schema here would
 * require an MCP connection at plugin-build time, before we hold any user
 * credentials. Accepting an arbitrary record keeps tool binding cheap; the
 * sandbox surfaces a clean error if the agent passes garbage.
 */
const sandboxRunArgsSchema = z.record(z.string(), z.unknown());

export interface CreateSandboxRunToolOptions {
  /** Resolved at boot from the plugin's configSchema. */
  sandboxMcpUrl: string;
  /** Optional skills-service URL — minted as a parallel UCAN if set. */
  skillsServiceUrl?: string;
  /** Raw `ORACLE_SECRETS` env value (parsed lazily per call). */
  oracleSecretsRaw: string;
  /** Header builder — split out so tests can stub UCAN minting deterministically. */
  authBuilder: SandboxAuthBuilder;
  /** Factory for the MCP client — overridable in tests. */
  mcpClientFactory?: (config: ClientConfig) => SandboxMcpClientLike;
  /** Tool description shown to the agent. */
  description?: string;
}

/**
 * The default {@link CreateSandboxRunToolOptions.description} mirrors what
 * the sandbox MCP server advertises today: a runtime to execute python /
 * shell scripts in an ephemeral sandboxed container.
 */
const DEFAULT_DESCRIPTION =
  'Execute code (python, shell) in the oracle sandbox. ' +
  'Oracle operator secrets (x-os-*) and per-user secrets (x-us-*) are ' +
  'injected as HTTP headers on each call.';

const DEFAULT_MCP_TIMEOUT_MS = 180_000;

/**
 * Build the `sandbox_run` tool. The returned {@link PluginTool} performs
 * three things on every invocation:
 *
 *   1. mints fresh UCAN headers (sandbox + skills) via {@link SandboxAuthBuilder}
 *   2. layers operator + per-room user secrets as `x-os-*` / `x-us-*` headers
 *   3. opens a `MultiServerMCPClient`, looks up `sandbox_run`, forwards args
 *
 * The MCP client is short-lived (one per invocation). This is the same
 * pattern as today's `apps/app/src/graph/agents/main-agent.ts:738+` lazy
 * enriched client — it just runs *every* call instead of memoising on the
 * first one. Per-call cost is dominated by the sandbox round-trip; the MCP
 * adapter setup is negligible.
 */
export function createSandboxRunTool(
  opts: CreateSandboxRunToolOptions,
): PluginTool {
  const mcpClientFactory =
    opts.mcpClientFactory ?? ((config) => new MultiServerMCPClient(config));

  return {
    name: SANDBOX_RUN_TOOL_NAME,
    description: opts.description ?? DEFAULT_DESCRIPTION,
    schema: sandboxRunArgsSchema,
    handler: async (args, ctx: RuntimeContext) => {
      const oracleSecrets = parseOracleSecrets(opts.oracleSecretsRaw);

      const userSecretIndex = await ctx.secrets.getIndex();
      const userSecretKeys = Object.keys(userSecretIndex);
      const userSecrets: Record<string, string> =
        userSecretKeys.length > 0
          ? await ctx.secrets.getValues(userSecretKeys)
          : {};

      const inputs: SandboxHeaderInputs = {
        sandboxMcpUrl: opts.sandboxMcpUrl,
        skillsServiceUrl: opts.skillsServiceUrl,
        oracleSecrets,
        userSecrets,
      };

      const headers = await opts.authBuilder(inputs, ctx);

      const client = mcpClientFactory({
        mcpServers: {
          sandbox: {
            type: 'http',
            url: opts.sandboxMcpUrl,
            transport: 'http',
            headers,
          },
        },
        defaultToolTimeout: DEFAULT_MCP_TIMEOUT_MS,
        useStandardContentBlocks: true,
      });

      try {
        const tools = await client.getTools();
        const sandboxRun = tools.find((t) => t.name === SANDBOX_RUN_TOOL_NAME);
        if (!sandboxRun) {
          throw new Error(
            `[sandbox] MCP server at ${opts.sandboxMcpUrl} did not expose a ` +
              `"${SANDBOX_RUN_TOOL_NAME}" tool. ` +
              `Available tools: ${tools.map((t) => t.name).join(', ') || '(none)'}.`,
          );
        }
        return await sandboxRun.invoke(args);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
