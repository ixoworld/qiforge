/**
 * Plugin authoring surface. A plugin written against `@ixo/oracle-runtime`
 * that uses tools / sub-agents / middlewares / manifest / configSchema /
 * autoDetect / getSharedState compiles unchanged against this module; the
 * only Node-specific hook (`getNestModules`) is replaced by `getRoutes`.
 */
export { OraclePlugin } from './oracle-plugin';
export type {
  PluginEnv,
  PluginRoute,
  PluginRouteMethod,
} from './oracle-plugin';
export { defineOraclePlugin } from './define-plugin';
export type { DefineOraclePluginInput } from './define-plugin';
export { tool } from './tool-helper';
export type { ToolHelperOptions } from './tool-helper';
export { UcanMintUnavailableError } from './ucan-errors';
export type {
  ActionCallEventPayload,
  AgentMiddleware,
  AuthExcludedRoute,
  BrowserToolCallEventPayload,
  ChatOpenAIFields,
  CommerceContext,
  CommerceEngagement,
  CommerceEngagementStatus,
  CommerceGateFailure,
  CommerceGateFailureReason,
  CommerceInProgressEngagement,
  CommerceMode,
  CommercePaymentOutcome,
  Logger,
  ManifestExample,
  MatrixEvent,
  MergedConfig,
  MessageCacheInvalidationPayload,
  ModelRole,
  OracleConfig,
  OracleIdentity,
  OraclePromptConfig,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  ReadonlyState,
  ReasoningEventPayload,
  RenderComponentEventPayload,
  RoomStateSnapshot,
  RouterEventPayload,
  RuntimeContext,
  SecretIndex,
  SharedAccessors,
  ToolCallEventPayload,
  UcanDelegation,
  UserContextData,
} from './types';
