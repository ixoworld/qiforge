import {
  BaseEvent,
  shouldHaveSessionId,
  type WithRequiredEventProps,
} from '../base-event/base-event.js';
import { EVENT_NAME, type IToolCallEvent } from './types.js';

export class ToolCallEvent extends BaseEvent<IToolCallEvent> {
  constructor(public payload: WithRequiredEventProps<IToolCallEvent>) {
    payload.status = payload.status ?? 'isRunning';
    super();
    shouldHaveSessionId(payload);
  }
  public eventName = EVENT_NAME;

  static eventName = EVENT_NAME;
}
