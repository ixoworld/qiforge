import type { AgentMiddleware } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { ReactAgent } from 'langchain';
import { z } from 'zod';
import type {
  ChatOpenAIFields,
  MergedConfig,
  ModelRole,
  OracleIdentity,
} from '../plugin-api/types';
import type { Registries } from './registries';
import type { AmbientServices, RunConfigContext } from './runtime-context';
import type { TMainAgentGraphState } from './state';

/** The 6 internal registries the runtime composes. */
export type MainAgentRegistries = Registries;

export const mainAgentRequestContextSchema = z.object({
  user: z.object({
    did: z.string(),
    matrixUserId: z.string(),
    ucanDelegation: z.any(),
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
  history: z
    .object({
      userContext: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /**
   * Per-request model override, already validated against the catalog
   * allow-list (`isAllowedModel`). Absent → the agent uses the default
   * `main` model.
   */
  model: z.string().optional(),
});

/** Per-request shape — exposes only what the main-agent build needs. */
export type MainAgentRequestContext = z.infer<
  typeof mainAgentRequestContextSchema
>;

/**
 * Optional hooks the consuming host provides to keep host-specific behaviour
 * (model selection, prompt section snippets) out of the runtime.
 */
export interface MainAgentHooks {
  /** Optional model resolver. Default: `ambient.llm.get`. */
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
  /** Degraded-services notice appended to the system prompt body. */
  degradedServicesBlock?: string;
  /**
   * Host middlewares appended after the always-on stack and the plugins'
   * (e.g. the Matrix `work_status` card driver, which needs a per-object
   * producer the core cannot construct).
   */
  middlewares?: AgentMiddleware[];
}

export interface MainAgentArgs {
  registries: MainAgentRegistries;
  identity: OracleIdentity;
  config: MergedConfig;
  requestCtx: MainAgentRequestContext;
  ambient: AmbientServices;
  state: Partial<TMainAgentGraphState>;
  availablePlugins: ReadonlySet<string>;
  /**
   * Checkpointer for the user's thread state. On Workers the Durable Object
   * owns it (SQLite over DO storage) and passes it in per turn; omit for a
   * stateless build (tests).
   */
  checkpointer?: BaseCheckpointSaver;
  /**
   * The turn's abort signal. Forwarded to the request-time plugin hooks
   * (`getRequestTools` / `getRequestSubAgents`) through their `RuntimeContext`
   * so a cancelled turn also cancels the network calls those hooks make. The
   * caller still passes the same signal to `agent.invoke` / `agent.stream`.
   */
  abortSignal?: AbortSignal;
  /** Provider of a BYO turn (`runtime.context.byo`); absent on platform turns. */
  byoProvider?: string;
  hooks?: MainAgentHooks;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CompiledMainAgent = ReactAgent<any>;

/** What `createMainAgent` resolves to. */
export interface MainAgentBuildResult {
  /** The compiled LangChain agent — call `invoke` / `stream` on it. */
  agent: CompiledMainAgent;
  /** The composed system prompt the agent was built with (diagnostics). */
  systemPrompt: string;
  /** Names of every tool bound to the agent, in binding order. */
  boundToolNames: string[];
  /**
   * The request's `{ user, session }` channel. Tools already fall back to it,
   * but pass it as `context` in the `invoke` / `stream` config so LangChain
   * middlewares and sub-agents see the same channel the Node runtime provides.
   */
  context: RunConfigContext;
}
