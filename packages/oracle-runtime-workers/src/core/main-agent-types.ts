import type { ContextBudget } from './context-budget';
import type { ContextGuardEvent } from './middlewares/context-guard';
import type { ResultCapConfig } from './middlewares/result-cap';
import type { ReadResultOutcome } from '../do/result-store';
import type { AgentMiddleware } from 'langchain';
import type { TurnBudget } from './turn-budget';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { ReactAgent } from 'langchain';
import { z } from 'zod';
import type {
  ChatOpenAIFields,
  MergedConfig,
  ModelRole,
  OracleIdentity,
  PluginTool,
} from '../plugin-api/types';
import type { DeliveryProfile } from '../delivery/types';
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
    client: z.enum(['portal', 'matrix', 'slack', 'channel']),
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
  /**
   * Middlewares applied to the main agent AND to every sub-agent's inner
   * graph (a sub-agent's own tool calls go through them too): the
   * write-ahead tool marks of durable runs and the result cap live here.
   */
  toolMiddlewares?: AgentMiddleware[];
  /**
   * The tool-execution middleware (budget, scheduling, write claims). It
   * must see a tool's own thrown error, so on the main agent it is placed
   * innermost — inside the retry middlewares, which turn a thrown error into
   * an error ToolMessage — and each retry attempt passes through it. Every
   * sub-agent gets it after `toolMiddlewares`.
   */
  toolExecution?: AgentMiddleware;
  /**
   * The turn's result cap (result-cap.ts), applied inside every wrapped
   * tool — plugin, meta and sub-agent inner tools — so a large result is
   * truncated and saved before it becomes a ToolMessage or an SSE frame.
   */
  resultCap?: ResultCapConfig;
  /**
   * The provider rejected a request as too long (context-guard.ts): learn
   * the limit it named. Resolves to the new window when there is one.
   */
  onContextOverflow?: (error: unknown) => Promise<number | undefined>;
  /**
   * What the context guard did to a request (a prune, an overflow retry, a
   * refusal): the host keeps per-session counters for diagnostics.
   */
  onContextEvent?: (event: ContextGuardEvent) => void;
  /**
   * Pages through a tool result the result cap saved whole; when present
   * the model gets the `read_result` tool.
   */
  readResult?: (
    id: string,
    offset: number,
    length: number,
  ) => Promise<ReadResultOutcome>;
  /**
   * Tools the host binds for this turn only, outside every plugin and the
   * capability gate (chat delivery's `create_artifact`). `returnDirect` ends
   * the run once the tool has answered, without another model call.
   */
  turnTools?: Array<{ tool: PluginTool; returnDirect?: boolean }>;
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
   * Plugins the capability router chose for this turn. The gate admits their
   * tools and tool handlers see them as loaded, but they are never written
   * to the graph's `loadedPlugins` channel: the preload lasts one turn.
   */
  preloadedPlugins?: ReadonlySet<string>;
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
  /**
   * The turn's context budget (context-budget.ts): drives when the history
   * is summarized, how large a request may be, and the `read_result` chunk
   * size. Omitted → the legacy fixed thresholds (tests, stateless builds).
   */
  contextBudget?: ContextBudget;
  /**
   * The turn's resource budget (turn-budget.ts). Model calls are charged by
   * the metered LLM adapter and tool calls by the host's tool-execution
   * middleware; the build itself only uses it to skip a summary after the
   * deadline. Omitted → unbudgeted (tests, stateless builds).
   */
  turnBudget?: TurnBudget;
  /**
   * Where the reply lands (chat delivery). A `chat` profile adds the surface
   * section to the prompt; tools see it as `ctx.session.surface`. Omitted →
   * a Portal turn.
   */
  delivery?: DeliveryProfile;
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
   * The effect of every bound tool (`read` may run again on a resumed
   * turn, `write` never does). Declared by the plugin, else by name.
   */
  toolEffects: Map<string, 'read' | 'write'>;
  /** Names of the sub-agent dispatch tools (`call_*_agent`): scheduled in their own lane. */
  subAgentToolNames: ReadonlySet<string>;
  /**
   * The request's `{ user, session }` channel. Tools already fall back to it,
   * but pass it as `context` in the `invoke` / `stream` config so LangChain
   * middlewares and sub-agents see the same channel the Node runtime provides.
   */
  context: RunConfigContext;
}
