import { EVENT_NAMES } from '@ixo/oracle-core/events/event-names';
import type {
  ActionCallEventPayload,
  BrowserToolCallEventPayload,
  MessageCacheInvalidationPayload,
  ReasoningEventPayload,
  RenderComponentEventPayload,
  RouterEventPayload,
  ToolCallEventPayload,
} from '../plugin-api/types.js';
import type {
  EmitAdapter,
  RawEventPayload,
} from '../runtime-context/ambient.js';

/** Identity of the current request — every emitted event carries these. */
export interface ScopeKeys {
  sessionId: string;
  requestId: string;
}

/** The seven typed emitter methods a RuntimeContext exposes via `ctx.emit`. */
export interface ScopedEmitter {
  toolCall(payload: ToolCallEventPayload): void;
  actionCall(payload: ActionCallEventPayload): void;
  renderComponent(payload: RenderComponentEventPayload): void;
  reasoning(payload: ReasoningEventPayload): void;
  browserToolCall(payload: BrowserToolCallEventPayload): void;
  router(payload: RouterEventPayload): void;
  messageCacheInvalidation(payload: MessageCacheInvalidationPayload): void;
}

export { EVENT_NAMES } from '@ixo/oracle-core/events/event-names';

/**
 * Build a scoped emitter that injects the current `sessionId`/`requestId`
 * onto every emitted payload before forwarding to the underlying sink.
 */
export function createScopedEmitter(
  scope: ScopeKeys,
  sink: EmitAdapter,
): ScopedEmitter {
  const send = (eventName: string, payload: RawEventPayload): void => {
    sink.emit(eventName, {
      ...payload,
      sessionId: scope.sessionId,
      requestId: scope.requestId,
    });
  };

  return {
    toolCall: (payload) => send(EVENT_NAMES.toolCall, payload),
    actionCall: (payload) => send(EVENT_NAMES.actionCall, payload),
    renderComponent: (payload) => send(EVENT_NAMES.renderComponent, payload),
    reasoning: (payload) => send(EVENT_NAMES.reasoning, payload),
    browserToolCall: (payload) => send(EVENT_NAMES.browserToolCall, payload),
    router: (payload) => send(EVENT_NAMES.router, payload),
    messageCacheInvalidation: (payload) =>
      send(EVENT_NAMES.messageCacheInvalidation, payload),
  };
}
