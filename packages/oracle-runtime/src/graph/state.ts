import { type BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { UserContextData } from '../plugin-api/types.js';

/**
 * Per-user preferences stored alongside the thread state. Mirrors the apps/app
 * shape but is kept loose so plugins can extend the contract via declaration
 * merging without touching this schema.
 */
export interface UserPreferences {
  agentName?: string;
  language?: string;
  tone?: string;
  formality?: string;
  customInstructions?: string;
  [key: string]: unknown;
}

/** Browser-side tool descriptor injected per request from the client. */
export interface BrowserToolCall {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** AG-UI action descriptor injected per request from the client. */
export interface AgAction {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  hasRender?: boolean;
}

/**
 * Master annotation state for the runtime's main agent. Mirrors the inlined
 * state schema previously living in apps/app — the runtime is the single
 * source of truth now.
 *
 * Plugin-owned state (e.g. `editorRoomId`, `spaceId`) stays in this schema
 * for now to preserve behaviour parity. Plugins read it through their own
 * middlewares; the runtime never branches on these fields directly.
 */
export const MainAgentGraphState = Annotation.Root({
  config: Annotation<{
    wsId?: string;
    did: string;
  }>({
    default: () => ({ did: '', wsId: '' }),
    reducer: (prev, curr) => ({ ...prev, ...curr }),
  }),

  client: Annotation<'portal' | 'matrix' | 'slack'>({
    default: () => 'portal',
    reducer: (_, curr) => curr,
  }),

  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  editorRoomId: Annotation<string | undefined>({
    default: () => undefined,
    reducer: (_, curr) => curr,
  }),

  /** Session run selected in `editorRoomId`; forwarded from request metadata. */
  sessionRunId: Annotation<string | undefined>({
    default: () => undefined,
    reducer: (_, curr) => curr,
  }),

  spaceId: Annotation<string | undefined>({
    default: () => undefined,
    reducer: (_, curr) => curr,
  }),

  currentEntityDid: Annotation<string | undefined>({
    default: () => undefined,
    reducer: (_, curr) => curr,
  }),

  browserTools: Annotation<BrowserToolCall[] | undefined>({
    default: () => [],
    reducer: (_, curr) => curr,
  }),

  agActions: Annotation<AgAction[] | undefined>({
    default: () => [],
    reducer: (_, curr) => curr,
  }),

  userContext: Annotation<UserContextData>({
    default: () => ({}),
    reducer: (prev, curr) => ({ ...prev, ...curr }),
  }),

  userPreferences: Annotation<UserPreferences | undefined>({
    default: () => undefined,
    reducer: (_, curr) => curr,
  }),

  /**
   * Names of plugins the agent has loaded for this thread via
   * `load_capability`. Set-union reducer: plugins are added, never removed.
   */
  loadedPlugins: Annotation<string[]>({
    reducer: (current, update) =>
      Array.from(new Set([...(current ?? []), ...(update ?? [])])),
    default: () => [],
  }),
});

export type TMainAgentGraphState = typeof MainAgentGraphState.State;
