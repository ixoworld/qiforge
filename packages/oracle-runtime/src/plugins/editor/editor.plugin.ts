import type { MatrixClient } from 'matrix-js-sdk';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { EDITOR_AGENT_TOOL_NAME } from './editor-agent.js';
import {
  buildBlocknoteToolsConfig,
  type BlocknoteToolsConfig,
} from './editor-config.js';
import { createStandaloneEditorTool } from './standalone-editor-tool.js';

/**
 * Constructor options for `EditorPlugin`. Pass `matrixClient` when the host app
 * already owns a long-lived matrix-js-sdk client — every editor surface will
 * reuse it instead of constructing the internal singleton.
 */
export interface EditorPluginOptions {
  matrixClient?: MatrixClient;
}

/**
 * Internal parse schema. These three env vars already live in the runtime's
 * core base env schema — re-declaring them via `OraclePlugin.configSchema`
 * would make the schema composer warn about duplicate ownership on every boot.
 * Keep this schema LOCAL: it extracts typed values from the already-validated
 * `ctx.config` but is not exposed as the plugin's public configSchema.
 */
const matrixConfigSchema = z.object({
  MATRIX_BASE_URL: z.string().min(1),
  MATRIX_ORACLE_ADMIN_USER_ID: z.string().min(1),
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: z.string().min(1),
});

const manifest: PluginManifest = {
  title: 'Documents',
  summary:
    "Reads and edits the content of the user's editor documents — prose, " +
    'structure, and ordering.',
  whenToUse: [
    'User asks to read, summarize, or explain the document they have open.',
    'User asks to write, rewrite, shorten, expand, or restructure document content.',
    'User asks to fix wording, insert a section, reorder sections, or delete content.',
    'User names a document in their workspace and wants it read or edited.',
  ],
  whenNotToUse: [
    'Building or configuring flows, action blocks, or forms — this surface edits content only.',
    'Running or executing anything inside a document.',
    'IXO entity lookups (use Domain Indexer) — documents are pages, not entities.',
    'Web search or scraping (use Firecrawl); long-term user memory (use Memory).',
  ],
  examples: [
    {
      user: 'Summarize this page.',
      thought:
        'Delegate to the document assistant with the open room. It reads the document and returns a summary.',
      tool: EDITOR_AGENT_TOOL_NAME,
    },
    {
      user: 'Rename the "Introduction" heading to "Getting Started".',
      thought:
        'Content edit — delegate with the exact old and new text so the assistant can locate the block and replace the text.',
      tool: EDITOR_AGENT_TOOL_NAME,
    },
  ],
  tags: ['editor', 'documents', 'pages', 'blocknote', 'content'],
  category: 'data',
  // On-demand so ordinary chats carry no editor Tier-1 entry or gated tools.
  // Document sessions still work with zero load steps: `AgentBuilder` seeds
  // `loadedPlugins` with this plugin's name whenever the request carries an
  // `editorRoomId`/`spaceId`, so the capability gate exposes
  // `call_editor_agent` exactly when a document is in scope.
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

/**
 * Document content plugin. Contributes one tool, `call_editor_agent`, on every
 * request: it targets the document the user has open (`state.editorRoomId`)
 * by default and any `room_id` the agent names per call.
 *
 * Access is enforced per call inside the tool with `isUserInRoom`: the oracle
 * acts with an admin Matrix identity, so "the user's documents" is always
 * computed from the user's membership, never from what the admin can see.
 */
export class EditorPlugin extends OraclePlugin {
  static readonly NAME = 'editor';

  readonly name = EditorPlugin.NAME;

  readonly version = '2.0.0';

  readonly manifest = manifest;

  // Intentionally no `configSchema` — the Matrix env vars the editor needs are
  // owned by the core base env schema. See `matrixConfigSchema` above.

  private readonly matrixClient?: MatrixClient;

  constructor(options: EditorPluginOptions = {}) {
    super();
    this.matrixClient = options.matrixClient;
  }

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    // Always bound. One tool covers every case: it targets the open document
    // by default and any `room_id` the agent names, so a page created mid-turn
    // (`create_page_room`) can be written into while another document is open.
    //
    // Not gated on `state.editorRoomId` or `state.spaceId` either — tools are
    // resolved once per request, so a room that only exists after the turn
    // starts is never in state. Access is enforced per call inside the tool
    // (`isUserInRoom(room_id, user)`, fail closed); space membership never
    // implied rights over a document, and the room need not live in that space.
    try {
      return [
        createStandaloneEditorTool({
          toolsConfig: parseToolsConfig(rtCtx.config, this.matrixClient),
        }),
      ];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      rtCtx.logger.error(`[editor] failed to build standalone tool: ${detail}`);
      return [];
    }
  }
}
