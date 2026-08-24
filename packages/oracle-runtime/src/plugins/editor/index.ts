export { EditorPlugin, type EditorPluginOptions } from './editor.plugin.js';
export { EDITOR_AGENT_NAME, EDITOR_AGENT_TOOL_NAME } from './editor-agent.js';
export { createStandaloneEditorTool } from './standalone-editor-tool.js';
export {
  createEditorAccessDeniedTool,
  type EditorAccessDeniedToolOptions,
} from './editor-access-denied-tool.js';
export {
  buildBlocknoteToolsConfig,
  type BlocknoteToolsConfig,
  type BlocknoteToolsMatrixConfig,
} from './editor-config.js';
export {
  createContentTools,
  CONTENT_TOOL_NAMES,
  type ContentToolsOptions,
} from './content-tools.js';
export {
  GRANT_ACCESS_TOOL,
  isEditorFailure,
  type EditorFailure,
  type EditorFailureCode,
} from './failures.js';
