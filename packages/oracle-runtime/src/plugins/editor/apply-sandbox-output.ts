import {
  MultiServerMCPClient,
  type ClientConfig,
} from '@langchain/mcp-adapters';
import { z } from 'zod';

import { tool as pluginTool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import {
  createDefaultAuthBuilder,
  parseOracleSecrets,
  SANDBOX_RUN_TOOL_NAME,
  type SandboxAuthBuilder,
  type SandboxHeaderInputs,
} from '../sandbox/sandbox-mcp.js';
import {
  editBlock,
  getBlockDetail,
  simplifyBlockForAgent,
} from './blocknote-helper.js';
import type { BlocknoteToolsConfig } from './blocknote-tools.js';
import { resolveEditorMatrixClient } from './editor-mx.js';
import { MatrixProviderManager, type AppConfig } from './provider.js';

/** Resolve a dot-notation path on an object (e.g. "data.credentials"). */
function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((cur: unknown, key) => {
    if (cur == null || typeof cur !== 'object') return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Parse the result returned by the sandbox `sandbox_run` MCP tool.
 *
 * The LangChain MCP adapter may return:
 *  - A plain JSON string  `"{ \"output\": \"...\", ... }"`
 *  - An MCP content array  `{ content: [{ type: "text", text: "..." }] }`
 *  - An already-parsed object
 */
function parseSandboxResult(raw: unknown): {
  output: string;
  success: boolean;
  error?: string;
  exitCode?: number;
} {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as ReturnType<typeof parseSandboxResult>;
  }

  if (
    typeof raw === 'object' &&
    raw !== null &&
    'content' in raw &&
    Array.isArray((raw as Record<string, unknown>).content)
  ) {
    const blocks = (raw as { content: Array<{ type: string; text: string }> })
      .content;
    const textBlock = blocks.find((b) => b.type === 'text');
    if (textBlock) {
      return JSON.parse(textBlock.text) as ReturnType<typeof parseSandboxResult>;
    }
  }

  return raw as ReturnType<typeof parseSandboxResult>;
}

const applySandboxOutputToBlockSchema = z.object({
  filePath: z
    .string()
    .describe(
      'Absolute path to the JSON file in the sandbox (e.g. /workspace/data/output/result.json)',
    ),
  blockId: z
    .string()
    .describe('The exact UUID of the block to update (get from list_blocks)'),
  fieldMapping: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Optional mapping from source JSON field names to block prop names. ' +
        'Use "." as source key to map the entire file content as one value. ' +
        'Use dot-notation in target to nest into JSON-string props (e.g. "inputs.credential"). ' +
        'Example flat: {"jwt_token": "kycCredential"}. ' +
        'Example nested: {".": "inputs.credential", "roomId": "inputs.roomId"}. ' +
        'If omitted, source field names are used as top-level block prop names directly.',
    ),
  jsonPath: z
    .string()
    .optional()
    .describe(
      'Optional dot-notation path to extract a nested object from the JSON before applying. ' +
        'Example: "result.credentials" extracts obj.result.credentials. ' +
        'If omitted, the top-level JSON object is used.',
    ),
  text: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Optional text content to set on the block. null keeps existing, empty string clears.',
    ),
});

const APPLY_SANDBOX_OUTPUT_DESCRIPTION = `Reads a JSON file from the sandbox and writes its values directly to a block's properties — bypassing LLM text generation entirely.

**When to use:**
- After a skill execution produces a JSON output file with long/opaque values (JWTs, credentials, tokens, base64 data, long URLs)
- When you need exact byte-perfect transfer of values to block properties
- Any value longer than ~200 characters that would be truncated if passed through edit_block manually

**Workflow:**
1. Run the skill in sandbox (sandbox_run) — ensure it writes output to a JSON file
2. Call list_blocks (via Editor Agent) to get the target block UUID
3. Call this tool with the output file path and block UUID
4. Values are transferred server-side without LLM generation

**Examples:**

Direct transfer (all fields as top-level props):
  {"filePath": "/workspace/data/output/result.json", "blockId": "uuid-here"}

With field mapping (flat):
  {"filePath": "/workspace/data/output/result.json", "blockId": "uuid-here", "fieldMapping": {"jwt_token": "kycCredential", "url": "kycUrl"}}

Nest into action block inputs (dot-notation target — use this for action blocks):
  {"filePath": "/workspace/data/output/credential.json", "blockId": "uuid-here", "fieldMapping": {".": "inputs.credential"}}

Multiple fields into inputs:
  {"filePath": "/workspace/data/output/result.json", "blockId": "uuid-here", "fieldMapping": {"credential": "inputs.credential", "roomId": "inputs.roomId"}}

Extract nested object:
  {"filePath": "/workspace/data/output/result.json", "blockId": "uuid-here", "jsonPath": "data.credentials"}

**IMPORTANT for action blocks:** Action block inputs are stored as a JSON string in the \`inputs\` prop. Use dot-notation targets like \`inputs.credential\` to nest values correctly. Do NOT use direct transfer (no fieldMapping) on action blocks — it will spread fields as top-level props instead of into inputs.`;

/** Minimal MCP-client surface — mirrors sandbox plugin's structural typing. */
export interface SandboxMcpClientLike {
  getTools(): Promise<
    Array<{ name: string; invoke(input: unknown): Promise<unknown> }>
  >;
  close(): Promise<void>;
}

export interface CreateApplySandboxOutputToolOptions {
  sandboxMcpUrl: string;
  skillsServiceUrl?: string;
  oracleSecretsRaw: string;
  /** Override the auth builder — primarily for tests. */
  authBuilder?: SandboxAuthBuilder;
  /** Override the MCP client factory — primarily for tests. */
  mcpClientFactory?: (config: ClientConfig) => SandboxMcpClientLike;
  /** Blocknote tools config (provides Matrix admin credentials). */
  toolsConfig: BlocknoteToolsConfig;
  /** Editor room ID (Y.Doc owner). */
  editorRoomId: string;
}

const DEFAULT_MCP_TIMEOUT_MS = 180_000;

/**
 * Build the `apply_sandbox_output_to_block` plugin tool. Reuses the sandbox
 * plugin's exported auth builder for UCAN minting + secret injection so the
 * editor plugin never duplicates that wiring; the MCP client is short-lived
 * per call, matching the sandbox plugin's own behaviour.
 */
export function createApplySandboxOutputTool(
  opts: CreateApplySandboxOutputToolOptions,
): PluginTool {
  const authBuilder = opts.authBuilder ?? createDefaultAuthBuilder();
  const mcpClientFactory =
    opts.mcpClientFactory ?? ((config) => new MultiServerMCPClient(config));

  return pluginTool(
    async (rawArgs, ctx: RuntimeContext) => {
      const parsed = applySandboxOutputToBlockSchema.parse(rawArgs);
      const { filePath, blockId, fieldMapping, jsonPath, text } = parsed;

      // ── 1. Read file from sandbox via short-lived MCP client ──────────
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

      const headers = await authBuilder(inputs, ctx);

      let fileContent: string;
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
          return JSON.stringify({
            success: false,
            error: `Sandbox MCP server at ${opts.sandboxMcpUrl} did not expose a "${SANDBOX_RUN_TOOL_NAME}" tool.`,
          });
        }

        const execResult = await sandboxRun.invoke({
          code: `cat "${filePath}"`,
        });
        const parsedExec = parseSandboxResult(execResult);

        if (
          !parsedExec.success ||
          (parsedExec.exitCode != null && parsedExec.exitCode !== 0)
        ) {
          return JSON.stringify({
            success: false,
            error: `Failed to read sandbox file: ${parsedExec.error || 'Unknown error'}`,
            exitCode: parsedExec.exitCode,
          });
        }

        fileContent = parsedExec.output;
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Sandbox file read failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        await client.close().catch(() => undefined);
      }

      // ── 2. Parse JSON ──────────────────────────────────────────────────
      let data: Record<string, unknown>;
      try {
        const json: unknown = JSON.parse(fileContent.trim());

        let target: unknown = json;
        if (jsonPath) {
          target = resolvePath(json, jsonPath);
          if (target == null || typeof target !== 'object') {
            return JSON.stringify({
              success: false,
              error: `jsonPath "${jsonPath}" did not resolve to an object (got ${typeof target})`,
            });
          }
        }

        if (typeof target !== 'object' || target === null || Array.isArray(target)) {
          return JSON.stringify({
            success: false,
            error: `Expected a JSON object but got ${Array.isArray(target) ? 'array' : typeof target}`,
          });
        }

        // Pre-existing structural cast (kept verbatim from the lifted
        // helper): after the typeof+Array guards `target` is structurally a
        // non-null object; the runtime checks above are the actual guarantee.
        data = target as Record<string, unknown>;
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // ── 3. Apply field mapping ────────────────────────────────────────
      let updates: Record<string, unknown>;

      if (fieldMapping && Object.keys(fieldMapping).length > 0) {
        updates = {};
        const warnings: string[] = [];

        for (const [sourceKey, targetProp] of Object.entries(fieldMapping)) {
          const sourceValue = sourceKey === '.' ? data : data[sourceKey];
          if (sourceValue === undefined && sourceKey !== '.') {
            warnings.push(
              `Source field "${sourceKey}" not found in sandbox output`,
            );
            continue;
          }

          if (targetProp.includes('.')) {
            const dotIdx = targetProp.indexOf('.');
            const parentProp = targetProp.slice(0, dotIdx);
            const nestedKey = targetProp.slice(dotIdx + 1);

            if (!updates[`__nested__${parentProp}`]) {
              updates[`__nested__${parentProp}`] = {};
            }
            (updates[`__nested__${parentProp}`] as Record<string, unknown>)[
              nestedKey
            ] = sourceValue;
          } else {
            updates[targetProp] = sourceValue;
          }
        }

        for (const key of Object.keys(updates)) {
          if (key.startsWith('__nested__')) {
            const parentProp = key.slice('__nested__'.length);
            updates[parentProp] = updates[key];
            delete updates[key];
          }
        }

        if (Object.keys(updates).length === 0) {
          return JSON.stringify({
            success: false,
            error: 'No mapped fields found in sandbox output',
            warnings,
            availableFields: Object.keys(data),
          });
        }

        if (warnings.length > 0) {
          ctx.logger.warn(`Field mapping warnings: ${warnings.join(', ')}`);
        }
      } else {
        updates = { ...data };
      }

      // ── 4. Write to block via Y.js ────────────────────────────────────
      const matrixClient = await resolveEditorMatrixClient({
        baseUrl: opts.toolsConfig.matrix.baseUrl,
        userId: opts.toolsConfig.matrix.userId,
        accessToken: opts.toolsConfig.matrix.accessToken,
        matrixClient: opts.toolsConfig.matrixClient,
      });

      const appConfig: AppConfig = {
        matrix: {
          ...opts.toolsConfig.matrix,
          room: { type: 'id', value: opts.editorRoomId },
        },
        provider: { ...opts.toolsConfig.provider },
        blocknote: { ...opts.toolsConfig.blocknote },
      };

      const providerManager = new MatrixProviderManager(
        matrixClient,
        appConfig,
      );

      try {
        const { doc } = await providerManager.init();

        const attributes =
          Object.keys(updates).length > 0 ? { props: updates } : {};

        editBlock(doc, {
          blockId,
          attributes,
          text: text === null || text === undefined ? undefined : text,
          docName: 'document',
        });

        const updatedBlock = getBlockDetail(doc, blockId, true);
        const simplified = updatedBlock
          ? simplifyBlockForAgent(updatedBlock)
          : null;

        return JSON.stringify({
          success: true,
          message: `Applied ${Object.keys(updates).length} field(s) from sandbox to block ${blockId}`,
          appliedFields: Object.keys(updates),
          block: simplified,
        });
      } catch (error) {
        ctx.logger.error(
          `Error applying sandbox output to block: ${error instanceof Error ? error.message : String(error)}`,
        );
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await providerManager.dispose();
      }
    },
    {
      name: 'apply_sandbox_output_to_block',
      description: APPLY_SANDBOX_OUTPUT_DESCRIPTION,
      schema: applySandboxOutputToBlockSchema,
    },
  );
}
