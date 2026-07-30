import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { ReactAgent } from 'langchain';
import { z } from 'zod';
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

export const mainAgentRequestContextSchema = z.object({
  user: z.object({
    did: z.string(),
    matrixUserId: z.string(),
    ucanDelegation: z.any(), // You may prefer a stricter schema for UCAN later.
    timezone: z.string().optional(),
    currentTime: z.string().optional(),
  }),
  session: z.object({
    id: z.string(),
    client: z.enum(['portal', 'matrix', 'slack']),
    requestId: z.string(),
    wsId: z.string().optional(),
    roomId: z.string().optional(),
  }),
  history: z.object({
    userContext: z.record(z.string(), z.unknown()).optional(),
  }),
  /**
   * Per-request model override, already validated against the catalog
   * allow-list (or, for `byo:` ids, against the BYO catalog + the user's
   * connected credential). Absent → the agent uses the default `main` model.
   */
  model: z.string().optional(),
  /**
   * Present when this turn runs on the user's own credential (BYO). Carries
   * only non-secret flags — the credential itself lives in the request-scoped
   * LLM adapter closure and never enters context, state, or traces. Consumed
   * by the credits middleware to skip deduction on BYO turns.
   */
  byo: z
    .object({
      provider: z.enum([
        'chatgpt',
        'openai',
        'anthropic',
        'gemini',
        'deepseek',
      ]),
      active: z.literal(true),
    })
    .optional(),
});
/** Per-request shape — exposes only what the main-agent build needs. */
export type MainAgentRequestContext = z.infer<
  typeof mainAgentRequestContextSchema
>;

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
