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
  ): void {
    RouterEvent.registerEventHandlers(server);
    ToolCallEvent.registerEventHandlers(server);
    RenderComponentEvent.registerEventHandlers(server);
    MessageCacheInvalidationEvent.registerEventHandlers(server);
    BrowserToolCallEvent.registerEventHandlers(server);
    ActionCallEvent.registerEventHandlers(server);
    ReasoningEvent.registerEventHandlers(server);
  }
}
