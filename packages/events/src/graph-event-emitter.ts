import { rootEventEmitter } from './root-event-emitter/root-event-emitter.js';
import { type DefaultEventsMap, type Server } from 'socket.io';
import {
  BrowserToolCallEvent,
  ReasoningEvent,
  RenderComponentEvent,
  ActionCallEvent,
} from './events/index.js';
import { MessageCacheInvalidationEvent } from './events/message-cache-invalidation/index.js';
import { RouterEvent } from './events/router-event/router.event.js';
import { ToolCallEvent } from './events/tool-call/tool-call.event.js';

export class GraphEventEmitter {
  static registerEventHandlers(
    server: Server<DefaultEventsMap, DefaultEventsMap>,
    frontendDispatch?: (
      kind: 'browser_tool_call' | 'action_call',
      data: unknown,
    ) => void,
  ): () => void {
    const detach = [
      RouterEvent,
      ToolCallEvent,
      RenderComponentEvent,
      MessageCacheInvalidationEvent,
      ReasoningEvent,
    ].map((event) => event.registerEventHandlers(server));
    if (frontendDispatch) {
      const browser = (data: unknown) =>
        frontendDispatch('browser_tool_call', data);
      const action = (data: unknown) => frontendDispatch('action_call', data);
      rootEventEmitter.on(BrowserToolCallEvent.eventName, browser);
      rootEventEmitter.on(ActionCallEvent.eventName, action);
      detach.push(
        () =>
          rootEventEmitter.removeListener(
            BrowserToolCallEvent.eventName,
            browser,
          ),
        () =>
          rootEventEmitter.removeListener(ActionCallEvent.eventName, action),
      );
    } else {
      detach.push(
        BrowserToolCallEvent.registerEventHandlers(server),
        ActionCallEvent.registerEventHandlers(server),
      );
    }
    return () => detach.forEach((remove) => remove());
  }
}
