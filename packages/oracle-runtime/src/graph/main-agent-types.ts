import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { ReactAgent } from 'langchain';
import type {
  ChatOpenAIFields,
  MergedConfig,
  ModelRole,
  OracleIdentity,
} from '../plugin-api/types.js';
import type { ConfigSchemaRegistry } from '../registries/config-schema-registry.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { MiddlewareRegistry } from '../registries/middleware-registry.js';
import type { SharedStateRegistry } from '../registries/shared-state-registry.js';
import type { SubAgentRegistry } from '../registries/subagent-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import type { TMainAgentGraphState } from './state.js';

/** The 6 internal registries the runtime composes. */
export interface MainAgentRegistries {
  tools: ToolRegistry;
  subAgents: SubAgentRegistry;
  middlewares: MiddlewareRegistry;
  manifests: ManifestRegistry;
  configSchema: ConfigSchemaRegistry;
  sharedState: SharedStateRegistry;
}

/** Per-request shape — exposes only what the main-agent build needs. */
export interface MainAgentRequestContext {
  user: {
    did: string;
    timezone?: string;
    currentTime?: string;
  };
  session: {
    id: string;
    client: 'portal' | 'matrix' | 'slack';
    roomId?: string;
  };
  history: {
    userContext: Record<string, unknown> | undefined;
  };
}

/**
 * Optional hooks the consuming app provides to keep platform-specific behaviour
 * (model selection, checkpointer wiring, secret injection) out of the runtime.
 *
 * Sandbox-tool secret-wrapping (today: `wrappedSandboxTools`) deliberately
 * lives outside this hook surface — the sandbox plugin owns it once it lands.
 */
export interface MainAgentHooks {
  /** Resolve a checkpointer for a user. Mirrors apps/app's per-user SQLite store. */
  checkpointerForUser?: (userDid: string) => Promise<BaseCheckpointSaver>;
  /** Optional model resolver. Default: `ambient.llm.get('main')`. */
  resolveModel?: (
    role: ModelRole,
    params?: ChatOpenAIFields,
  ) => ReturnType<AmbientServices['llm']['get']>;
  /** Look up a human-readable page title for the page-context middleware. */
  getRoomTitle?: (roomId: string) => Promise<string | undefined>;
  /** Cheap classification model used by the safety-guardrail middleware. */
  safetyModel?: BaseChatModel;
  /** Tool names whose `ToolMessage` outputs should be stripped between turns. */
  validationSkipToolNames?: string[];
  /** Operational-mode block — overridden when a richer mode applies. */
  operationalMode?: string;
  /** Editor block — populated by the editor plugin. */
  editorSection?: string;
  /** Composio guidance block — populated by the composio plugin. */
  composioContext?: string;
  /** Per-key secret bullet list (e.g. `- _USER_SECRET_FOO`). */
  userSecretsContext?: string;
  /** Degraded-services notice appended to the system prompt body. */
  degradedServicesBlock?: string;
}

export interface MainAgentArgs {
  registries: MainAgentRegistries;
  identity: OracleIdentity;
  config: MergedConfig;
  requestCtx: MainAgentRequestContext;
  ambient: AmbientServices;
  state: Partial<TMainAgentGraphState>;
  availablePlugins: ReadonlySet<string>;
  hooks?: MainAgentHooks;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CompiledMainAgent = ReactAgent<any>;
