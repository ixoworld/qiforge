import type { MatrixClient } from 'matrix-js-sdk';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { EDITOR_AGENT_TOOL_NAME } from './editor-agent';
import {
  buildBlocknoteToolsConfig,
  type BlocknoteToolsConfig,
} from './editor-config';

// This module must stay statically LIGHT: constructing `new EditorPlugin()`
// happens at Worker module scope (src/plugins/index.ts), and the tool's
// module graph (`standalone-editor-tool` → content-tools → provider →
// @ixo/matrix-crdt → vscode-lib, plus @blocknote/server-util) schedules a
// timer during module evaluation (vscode-lib's `IdleValue`/`runWhenIdle`),
// which workerd forbids in global scope. The chain is therefore reached only
// through `await import()` inside `getRequestTools`, which runs per turn
// inside a Durable Object request context where timers are allowed.

/**
 * Constructor options for `EditorPlugin`. Pass `matrixClient` when the host
 * (or a test) already owns a long-lived matrix-js-sdk client — every editor
 * surface will reuse it instead of constructing the internal singleton.
 */
export interface EditorPluginOptions {
  matrixClient?: MatrixClient;
}

/**
 * The editor's own polling client needs a device token. It never comes from
 * the env: the gateway keeps a dedicated crypto-less device for plugins and
 * hands its credentials out through `ctx.matrix.botCredentials()`. If that
 * fails the plugin logs and contributes no tools rather than failing the
 * whole request build.
 */

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
  visibility: 'on-demand',
  stability: 'stable',
};

function toolsConfigFor(
  creds: { baseUrl: string; userId: string; accessToken: string },
  matrixClient?: MatrixClient,
): BlocknoteToolsConfig {
  return {
    ...buildBlocknoteToolsConfig(creds),
    matrixClient,
  };
}

/**
 * Document content plugin. Contributes one tool, `call_editor_agent`, on every
 * request: it targets the document the user has open (`state.editorRoomId`)
 * by default and any `room_id` the agent names per call.
 *
 * Access is enforced per call inside the tool with `isUserInRoom` (via the
 * gateway Durable Object): the oracle acts with an admin Matrix identity, so
 * "the user's documents" is always computed from the user's membership, never
 * from what the admin can see.
 */
export class EditorPlugin extends OraclePlugin {
  static readonly NAME = 'editor';

  readonly name = EditorPlugin.NAME;

  readonly version = '2.0.0';

  readonly manifest = manifest;

  // Intentionally no `configSchema` — the Matrix env vars the editor needs are
  // owned by the core env schema. See `matrixConfigSchema` above.

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
      const toolsConfig = toolsConfigFor(
        await rtCtx.matrix.botCredentials(),
        this.matrixClient,
      );
      // Lazy on purpose — see the module header. The module registry caches
      // the import, so only the first turn in an isolate pays for it.
      const { createStandaloneEditorTool } =
        await import('./standalone-editor-tool');
      return [createStandaloneEditorTool({ toolsConfig })];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      rtCtx.logger.error(`[editor] failed to build standalone tool: ${detail}`);
      return [];
    }
  }
}
