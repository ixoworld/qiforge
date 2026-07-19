import type { MatrixClient } from 'matrix-js-sdk';
import { z } from 'zod';
import { isUserInRoom } from '../../matrix/room-membership.js';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { SandboxPlugin } from '../sandbox/index.js';
import { createApplySandboxOutputTool } from './apply-sandbox-output.js';
import {
  buildBlocknoteToolsConfig,
  type BlocknoteToolsConfig,
} from './blocknote-tools.js';
import {
  createEditorSubAgent,
  EDITOR_AGENT_TOOL_NAME,
} from './editor-agent.js';
import { createStandaloneEditorTool } from './standalone-editor-tool.js';

/**
 * Constructor options for `EditorPlugin`. Pass `matrixClient` when the host
 * app already owns a long-lived matrix-js-sdk client — every editor tool
 * will reuse it instead of constructing the internal singleton.
 */
export interface EditorPluginOptions {
  matrixClient?: MatrixClient;
}

/**
 * Internal parse schema for `parseToolsConfig`. These 3 env vars already
 * live in the runtime's core base env schema — re-declaring them via
 * `OraclePlugin.configSchema` would make schema-composer warn about
 * duplicate ownership ("editor wins") on every boot. Keep this schema
 * LOCAL: used to extract typed values from the already-validated
 * `ctx.config`, but NOT exposed as the plugin's public configSchema.
 */
const matrixConfigSchema = z.object({
  MATRIX_BASE_URL: z.string(),
  MATRIX_ORACLE_ADMIN_USER_ID: z.string(),
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: z.string(),
});

const siblingEnvSchema = z.object({
  SANDBOX_MCP_URL: z.url().optional(),
  SKILLS_CAPSULES_BASE_URL: z.url().optional(),
  ORACLE_SECRETS: z.string().optional(),
});

const manifest: PluginManifest = {
  title: 'Editor',
  summary:
    "Reads and edits BlockNote pages — collaborative documents in the user's workspace.",
  whenToUse: [
    'User asks to read, summarize, or edit a page in their workspace.',
    'User wants to update specific blocks (status, properties, content) on a page.',
    'User wants to create a new page or update an existing one.',
    'A skill produced output (URLs, credentials, status values) that should land on specific blocks.',
  ],
  whenNotToUse: [
    'IXO entity lookups (use Domain Indexer) — pages are documents, not entities.',
    'Web search or scraping (use Firecrawl).',
    'Long-term user memory (use Memory).',
  ],
  examples: [
    {
      user: 'Summarize the current page.',
      thought:
        'Delegate to the Editor sub-agent with the active room. It will read the page and return a summary.',
      tool: EDITOR_AGENT_TOOL_NAME,
    },
    {
      user: 'Set the status block to completed.',
      thought:
        'Page edit — delegate with explicit block target + new value. Never paraphrase block IDs or status names.',
      tool: EDITOR_AGENT_TOOL_NAME,
    },
  ],
  tags: ['editor', 'blocknote', 'pages', 'documents'],
  category: 'data',
  // On-demand so ordinary chats carry no editor Tier-1 entry or gated tools.
  // Editor sessions still work with zero load steps: `AgentBuilder` seeds
  // `loadedPlugins` with this plugin's name whenever the request carries an
  // `editorRoomId`/`spaceId`, so the capability gate exposes
  // `call_editor_agent` exactly when a page is open.
  visibility: 'on-demand',
  stability: 'stable',
};

function parseToolsConfig(
  cfg: Record<string, unknown>,
  matrixClient?: MatrixClient,
): BlocknoteToolsConfig {
  const parsed = matrixConfigSchema.parse(cfg);
  return {
    ...buildBlocknoteToolsConfig({
      baseUrl: parsed.MATRIX_BASE_URL,
      userId: parsed.MATRIX_ORACLE_ADMIN_USER_ID,
      accessToken: parsed.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN,
    }),
    matrixClient,
  };
}

function readEditorRoomId(rtCtx: RuntimeContext): string | undefined {
  const value = rtCtx.history.state.editorRoomId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSpaceId(rtCtx: RuntimeContext): string | undefined {
  const value = rtCtx.history.state.spaceId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildUserMatrixId(rtCtx: RuntimeContext): string | undefined {
  // Mirrors today's apps/app pattern: derive `@did-ixo-...:homeserver` from
  // the canonical user DID + base URL when no explicit Matrix ID is wired in.
  const did = rtCtx.user.did;
  if (!did) return undefined;
  const matrixId = rtCtx.user.matrixUserId;
  return matrixId || undefined;
}

/**
 * Editor plugin. Behaviour by state:
 *
 *   - `state.editorRoomId` set → editor sub-agent (`call_editor_agent`)
 *     bound to that room; plus `apply_sandbox_output_to_block` when the
 *     sandbox plugin is also loaded.
 *   - `state.spaceId` set without `editorRoomId` → standalone
 *     `call_editor_agent` tool that accepts a `room_id` argument per call.
 *   - neither set → no contributions; the agent has no editor surface.
 */
export class EditorPlugin extends OraclePlugin {
  static readonly NAME = 'editor';

  readonly name = EditorPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest = manifest;

  // Intentionally no `configSchema` — the matrix env vars editor needs are
  // owned by the core base env schema. See `matrixConfigSchema` above.

  private readonly matrixClient?: MatrixClient;

  constructor(options: EditorPluginOptions = {}) {
    super();
    this.matrixClient = options.matrixClient;
  }

  override async getRequestSubAgents(
    rtCtx: RuntimeContext,
  ): Promise<PluginSubAgent[]> {
    const editorRoomId = readEditorRoomId(rtCtx);
    if (!editorRoomId) return [];

    // The editor operates on `editorRoomId` with the oracle's admin Matrix
    // identity. `editorRoomId` came from the request, so verify the
    // authenticated user is actually a member of that room before binding the
    // sub-agent to it — otherwise a user could read/edit any room id they pass.
    if (!(await isUserInRoom(editorRoomId, rtCtx.user.matrixUserId))) {
      rtCtx.logger.warn(
        `[editor] user ${rtCtx.user.did} is not a member of room ${editorRoomId} — refusing to bind editor sub-agent`,
      );
      return [];
    }

    const toolsConfig = parseToolsConfig(rtCtx.config, this.matrixClient);

    try {
      const subAgent = await createEditorSubAgent({
        room: editorRoomId,
        mode: 'edit',
        toolsConfig,
        userMatrixId: buildUserMatrixId(rtCtx),
        spaceId: readSpaceId(rtCtx),
        // Gate mint_invocation on whether the oracle has a signing key. Without
        // one, the tool can't mint anything — better to omit it than register
        // a tool that returns "Oracle has no UCAN signing key configured" on
        // every call.
        ucanService: rtCtx.ucan.hasSigningKey() ? rtCtx.ucan : undefined,
        blobStore: rtCtx.blobStore,
        userDid: rtCtx.user.did,
      });
      return [subAgent];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      rtCtx.logger.error(`[editor] failed to build sub-agent: ${detail}`);
      return [];
    }
  }

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    const tools: PluginTool[] = [];
    const editorRoomId = readEditorRoomId(rtCtx);
    const spaceId = readSpaceId(rtCtx);

    if (!editorRoomId && !spaceId) {
      return tools;
    }

    const toolsConfig = parseToolsConfig(rtCtx.config, this.matrixClient);

    // Standalone editor tool — only when a space is in scope but no specific
    // editor session is active. The agent supplies `room_id` per call.
    if (!editorRoomId && spaceId) {
      tools.push(
        createStandaloneEditorTool({
          toolsConfig,
          spaceId,
          userMatrixId: buildUserMatrixId(rtCtx),
        }),
      );
    }

    // apply_sandbox_output_to_block — only with both an editor session AND
    // a loaded sandbox plugin (it brokers UCAN headers for the MCP call).
    // Same room-ownership guard as the sub-agent path: the tool writes to
    // `editorRoomId` with the admin identity, so the requesting user must be
    // a member of it.
    if (
      editorRoomId &&
      rtCtx.availablePlugins.has(SandboxPlugin.NAME) &&
      (await isUserInRoom(editorRoomId, rtCtx.user.matrixUserId))
    ) {
      const siblings = siblingEnvSchema.safeParse(rtCtx.config);
      const sandboxMcpUrl = siblings.success
        ? siblings.data.SANDBOX_MCP_URL
        : undefined;

      if (sandboxMcpUrl) {
        tools.push(
          createApplySandboxOutputTool({
            sandboxMcpUrl,
            skillsServiceUrl: siblings.success
              ? siblings.data.SKILLS_CAPSULES_BASE_URL
              : undefined,
            oracleSecretsRaw: siblings.success
              ? (siblings.data.ORACLE_SECRETS ?? '')
              : '',
            toolsConfig,
            editorRoomId,
          }),
        );
      }
    }

    return tools;
  }
}
