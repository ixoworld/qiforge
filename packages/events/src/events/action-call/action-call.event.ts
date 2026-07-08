import {
  BaseEvent,
  shouldHaveSessionId,
  type WithRequiredEventProps,
} from '../base-event/base-event.js';
import { EVENT_NAME, type IActionCallEvent } from './types.js';

export class ActionCallEvent extends BaseEvent<IActionCallEvent> {
  constructor(public payload: WithRequiredEventProps<IActionCallEvent>) {
    payload.status = payload.status ?? 'isRunning';
    super();
    shouldHaveSessionId(payload);
  }
  public eventName = EVENT_NAME;

  static eventName = EVENT_NAME;
}
