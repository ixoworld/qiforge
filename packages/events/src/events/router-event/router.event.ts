import {
  BaseEvent,
  shouldHaveSessionId,
  type WithRequiredEventProps,
} from '../base-event/base-event.js';

interface IRouterEvent {
  step: string;
}

export class RouterEvent extends BaseEvent<IRouterEvent> {
  constructor(public payload: WithRequiredEventProps<IRouterEvent>) {
    super();
    shouldHaveSessionId(payload);
  }
  public eventName = 'router.update';

  static eventName = 'router.update' as const;

  public updateStep(step: string): void {
    this.payload.step = step;
  }
}
