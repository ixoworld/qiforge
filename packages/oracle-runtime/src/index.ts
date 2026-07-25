export { createOracleApp } from './bootstrap/index.js';
export type {
  OracleApp,
  CreateOracleAppOptions,
  BundledFeatureName,
  PluginStatusReport,
  PluginStatusChangeEvent,
} from './bootstrap/index.js';

export { OraclePlugin } from './plugin-api/oracle-plugin.js';
export { defineOraclePlugin } from './plugin-api/define-plugin.js';
export { tool } from './plugin-api/tool-helper.js';
export { acquireToolLock } from './utils/tool-lock.js';

export type {
  PluginManifest,
  ManifestExample,
  PluginContext,
  RuntimeContext,
  PluginTool,
  PluginSubAgent,
  AuthExcludedRoute,
  OracleConfig,
  OraclePromptConfig,
  OracleIdentity,
  MergedConfig,
  Logger,
  ModelRole,
  ChatOpenAIFields,
  UcanDelegation,
  SecretIndex,
  RoomStateSnapshot,
  MatrixEvent,
  UserContextData,
  ReadonlyState,
  SharedAccessors,
  ToolCallEventPayload,
  ActionCallEventPayload,
  RenderComponentEventPayload,
  ReasoningEventPayload,
  BrowserToolCallEventPayload,
  RouterEventPayload,
  MessageCacheInvalidationPayload,
} from './plugin-api/types.js';

export type { AgentMiddleware } from 'langchain';
export { z } from 'zod';

export {
  createSubagentAsTool,
  createToolValidationMiddleware,
  createToolRepetitionGuardMiddleware,
  createPageContextMiddleware,
  createSafetyGuardrailMiddleware,
  createSummarizationMiddleware,
} from './graph/index.js';
export type {
  AgentSpec,
  SubagentToolOptions,
  ToolValidationMiddlewareOptions,
  ToolRepetitionGuardMiddlewareOptions,
  PageContextMiddlewareOptions,
  SafetyGuardrailMiddlewareOptions,
  SummarizationMiddlewareOptions,
} from './graph/index.js';

export { buildPluginContext } from './runtime-context/build-plugin.js';
export type { BuildPluginContextInput } from './runtime-context/build-plugin.js';

export { buildRuntimeContext } from './runtime-context/build-runtime.js';
export type {
  RunConfig,
  RunConfigContext,
  RuntimeUserContext,
  RuntimeSessionContext,
  RuntimeStateInput,
} from './runtime-context/build-runtime.js';

export { createScopedEmitter, EVENT_NAMES } from './events/scoped-emitter.js';
export type { ScopedEmitter, ScopeKeys } from './events/scoped-emitter.js';

export {
  getModelForRole,
  getProviderChatModel,
  getProviderConfig,
  getLLMProvider,
  type ProviderModelRole,
} from './llm/index.js';

export {
  pluginManifestSchema,
  manifestExampleSchema,
  manifestCategorySchema,
  manifestVisibilitySchema,
  manifestStabilitySchema,
  validateManifest,
  validateExamplesAgainstTools,
  renderTier1,
  mergeManifestOverride,
} from './manifest/index.js';
export type {
  ManifestValidationResult,
  Tier1Entry,
  Tier1Input,
  Tier1Output,
  PluginManifestOverride,
} from './manifest/index.js';

export {
  memoryPlugin,
  portalPlugin,
  firecrawlPlugin,
  domainIndexerPlugin,
  composioPlugin,
  sandboxPlugin,
  skillsPlugin,
  editorPlugin,
  aguiPlugin,
  slackPlugin,
  tasksPlugin,
  creditsPlugin,
  callsPlugin,
  userPreferencesPlugin,
  vfsPlugin,
  BUNDLED_PLUGINS,
} from './plugins/index.js';

// Plugin classes — for hosts that need to instantiate with custom args
// (Redis, Matrix clients, etc.). The bundled `*Plugin` singletons above
// cover the no-arg case; pass your own instance via `plugins: [...]` to
// `createOracleApp` to override.
export * from './plugins/agui/index.js';
export * from './plugins/codex/index.js';
export * from './plugins/composio/index.js';
export * from './plugins/credits/index.js';
export * from './plugins/domain-indexer/index.js';
export * from './plugins/editor/index.js';
export * from './plugins/firecrawl/index.js';
export * from './plugins/flows/index.js';
export * from './plugins/matrix-group-chats/index.js';
export * from './plugins/memory/index.js';
export * from './plugins/portal/index.js';
export * from './plugins/sandbox/index.js';
export * from './plugins/skills/index.js';
export * from './plugins/slack/index.js';
export * from './plugins/user-preferences/index.js';
export * from './plugins/vfs/index.js';
