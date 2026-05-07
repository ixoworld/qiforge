import type { BaseMessage } from '@langchain/core/messages';
import type {
  MergedConfig,
  ReadonlyState,
  RuntimeContext,
  SharedAccessors,
  UcanDelegation,
  UserContextData,
} from '../plugin-api/types.js';
import { createScopedEmitter } from '../events/scoped-emitter.js';
import type { AmbientServices } from './ambient.js';

/** Fixed empty `shared` accessors — frozen so callers can't mutate. */
const EMPTY_SHARED: SharedAccessors = Object.freeze({});

/**
 * The user channel passed in via LangGraph's per-run context. Mirrors today's
 * `state.config` + auth headers consumed by the request middleware.
 */
export interface RuntimeUserContext {
  did: string;
  matrixUserId: string;
  ucanDelegation: UcanDelegation;
  timezone?: string;
  currentTime?: string;
}

/** Session info threaded through from `SessionsService`. */
export interface RuntimeSessionContext {
  id: string;
  client: 'portal' | 'matrix' | 'slack';
  wsId?: string;
  requestId: string;
  roomId?: string;
}

/** What LangGraph hands us at invocation time on `runtime.context`. */
export interface RunConfigContext {
  user: RuntimeUserContext;
  session: RuntimeSessionContext;
}

/**
 * The `runtime` argument passed to a tool handler in LangGraph v1. We only
 * read the `context` channel and the optional `signal`.
 */
export interface RunConfig {
  context: RunConfigContext;
  signal?: AbortSignal;
}

/**
 * Minimum shape of the graph state that build-runtime depends on. Real graphs
 * extend this freely.
 */
export interface RuntimeStateInput {
  messages: readonly BaseMessage[];
  userContext?: UserContextData;
  loadedPlugins?: ReadonlySet<string>;
  [key: string]: unknown;
}

/**
 * Build the per-request RuntimeContext exposed to tool handlers, sub-agent
 * handlers and plugin-middleware hooks. Synthesizes user/session from the
 * LangGraph runtime channel, history from state, and the rest from ambient.
 */
export function buildRuntimeContext<TConfig = MergedConfig>(
  runConfig: RunConfig,
  ambient: AmbientServices,
  state: RuntimeStateInput,
): RuntimeContext<TConfig> {
  const session = runConfig.context.session;
  const user = runConfig.context.user;

  const messages: readonly BaseMessage[] = state.messages ?? [];
  const userContext: UserContextData = state.userContext ?? {};
  const loadedPlugins: ReadonlySet<string> =
    state.loadedPlugins ?? new Set<string>();

  const recent = (n: number): BaseMessage[] =>
    n <= 0 ? [] : messages.slice(Math.max(0, messages.length - n));

  const readonlyState: ReadonlyState = {
    ...state,
    messages,
    userContext,
    loadedPlugins,
  };

  const emit = createScopedEmitter(
    { sessionId: session.id, requestId: session.requestId },
    ambient.emit,
  );

  const abortSignal = runConfig.signal ?? new AbortController().signal;

  const delegation = user.ucanDelegation;

  return {
    user,
    session,
    history: {
      messages,
      recent,
      userContext,
      state: readonlyState,
    },
    config: ambient.config as TConfig,
    availablePlugins: ambient.availablePlugins,
    loadedPlugins,
    secrets: {
      getIndex: () => {
        if (!session.roomId) {
          return Promise.resolve({});
        }
        return ambient.secrets.getIndex(session.roomId);
      },
      getValues: (keys: string[]) => {
        if (!session.roomId) {
          return Promise.resolve({});
        }
        return ambient.secrets.getValues(session.roomId, keys);
      },
    },
    matrix: {
      postToRoom: (roomId, content) =>
        ambient.matrix.postToRoom(roomId, content),
      getRoomState: (roomId) => ambient.matrix.getRoomState(roomId),
      getEventById: (roomId, eventId) =>
        ambient.matrix.getEventById(roomId, eventId),
    },
    ucan: {
      hasCapability: (resource, action) =>
        ambient.ucan.hasCapability(delegation, resource, action),
      requireCapability: (resource, action) => {
        ambient.ucan.requireCapability(delegation, resource, action);
      },
      mintInvocation: (target) => ambient.ucan.mintInvocation(user.did, target),
    },
    llm: {
      get: (role, params) => ambient.llm.get(role, params),
    },
    emit,
    logger: ambient.logger,
    abortSignal,
    shared: EMPTY_SHARED,
  };
}

export { EMPTY_SHARED };
