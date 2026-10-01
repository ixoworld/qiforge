/**
 * Identity of the `call_editor_agent` tool, and the per-room provider config
 * behind it. The tool itself lives in `standalone-editor-tool.ts`: one tool
 * that targets the open document by default and any `room_id` on request.
 */

import { computeSubAgentToolName } from '../../graph/subagent-as-tool.js';
import type { BlocknoteToolsConfig } from './editor-config.js';
import type { AppConfig, MatrixRoomConfig } from './provider.js';

/** Display name the tool name is derived from. */
export const EDITOR_AGENT_NAME = 'Editor Agent';

/**
 * The tool name the main agent sees for the document surface. Derived through
 * `computeSubAgentToolName` so it stays stable for the prompt composer, which
 * checks this name before injecting the document-mode prompts: telling the
 * model a document is open without this tool bound makes it narrate its
 * delegation as user-facing text instead of calling anything.
 */
export const EDITOR_AGENT_TOOL_NAME =
  computeSubAgentToolName(EDITOR_AGENT_NAME);

/** Compose the per-room provider config from the plugin's boot-time config. */
export function buildAppConfig(
  base: BlocknoteToolsConfig,
  room: MatrixRoomConfig,
): AppConfig {
  return {
    matrix: { ...base.matrix, room },
    provider: { ...base.provider },
    blocknote: { ...base.blocknote },
  };
}
