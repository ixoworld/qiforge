/**
 * Editor plugin barrel — statically LIGHT by contract.
 *
 * This barrel is re-exported from `src/plugins/index.ts`, which is evaluated
 * at Worker module scope. Nothing here may (transitively) import
 * `@ixo/matrix-crdt` / `@blocknote/server-util` / `@ixo/editor`: vscode-lib
 * (inside matrix-crdt) schedules a timer at module-evaluation time, which
 * workerd forbids in global scope. The heavy tool chain
 * (`standalone-editor-tool`, `content-tools`, `provider`, `blocknote-bridge`,
 * `editor-mx`, `content-session`) is reached only via `await import()` inside
 * `EditorPlugin.getRequestTools` — import those modules directly (not through
 * this barrel) if you need them, and only from a request context.
 */
export { EditorPlugin, type EditorPluginOptions } from './editor.plugin';
export { EDITOR_AGENT_NAME, EDITOR_AGENT_TOOL_NAME } from './editor-agent';
export {
  createEditorAccessDeniedTool,
  type EditorAccessDeniedToolOptions,
} from './editor-access-denied-tool';
export {
  buildBlocknoteToolsConfig,
  type BlocknoteToolsConfig,
  type BlocknoteToolsMatrixConfig,
} from './editor-config';
export {
  GRANT_ACCESS_TOOL,
  isEditorFailure,
  type EditorFailure,
  type EditorFailureCode,
} from './failures';
export { isUserInRoom, invalidateRoomMembership } from './room-membership';
