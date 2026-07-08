import { type WithRequiredEventProps } from '../events/base-event/base-event.js';
import { ActionCallEvent } from '../events/action-call/action-call.event.js';
import { BrowserToolCallEvent } from '../events/browser-tool-call/browser-tool-call.event.js';
import { MessageCacheInvalidationEvent } from '../events/message-cache-invalidation/index.js';
import { ReasoningEvent } from '../events/reasoning-event/index.js';
import { RenderComponentEvent } from '../events/render-component/render-component.event.js';
import { RouterEvent } from '../events/router-event/router.event.js';
import { ToolCallEvent } from '../events/tool-call/tool-call.event.js';

// Import interfaces to avoid circular references
import { type IActionCallEvent } from '../events/action-call/types.js';
import { type IBrowserToolCallEvent } from '../events/browser-tool-call/types.js';
import { type IReasoningEvent } from '../events/reasoning-event/types.js';
import { type IToolCallEvent } from '../events/tool-call/types.js';

export type AllEvents =
  | RouterEvent
  | ToolCallEvent
  | RenderComponentEvent
  | MessageCacheInvalidationEvent
  | BrowserToolCallEvent
  | ReasoningEvent
  | ActionCallEvent;
export const AllEventsAsClass = [
  RouterEvent,
  ToolCallEvent,
  RenderComponentEvent,
  MessageCacheInvalidationEvent,
  BrowserToolCallEvent,
  ReasoningEvent,
  ActionCallEvent,
];

// Fix circular references by using actual interfaces
export type ToolCallEventPayload = WithRequiredEventProps<IToolCallEvent>;
export type RouterEventPayload = WithRequiredEventProps<{ step: string }>;
export type RenderComponentEventPayload = WithRequiredEventProps<{
  componentName: string;
  args?: Record<string, unknown>;
  status?: 'isRunning' | 'done';
  eventId?: string;
}>;
export type MessageCacheInvalidationEventPayload = WithRequiredEventProps<{
  status?: 'isRunning' | 'done';
}>;
export type BrowserToolCallEventPayload =
  WithRequiredEventProps<IBrowserToolCallEvent>;
export type ReasoningEventPayload = WithRequiredEventProps<IReasoningEvent>;
export type ActionCallEventPayload = WithRequiredEventProps<IActionCallEvent>;

export type EventNames = {
  ToolCall: ToolCallEvent['eventName'];
  RouterUpdate: RouterEvent['eventName'];
  RenderComponent: RenderComponentEvent['eventName'];
  MessageCacheInvalidation: MessageCacheInvalidationEvent['eventName'];
  BrowserToolCall: BrowserToolCallEvent['eventName'];
  Reasoning: ReasoningEvent['eventName'];
  ActionCall: ActionCallEvent['eventName'];
};

export type { WithRequiredEventProps } from '../events/base-event/base-event.js';

// Export interfaces for external consumers
export type { IActionCallEvent } from '../events/action-call/types.js';
export type { IBrowserToolCallEvent } from '../events/browser-tool-call/types.js';
export type { IReasoningEvent } from '../events/reasoning-event/types.js';
export type { IToolCallEvent } from '../events/tool-call/types.js';
