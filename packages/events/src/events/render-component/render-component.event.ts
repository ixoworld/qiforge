import {
  BaseEvent,
  shouldHaveSessionId,
  type WithRequiredEventProps,
} from '../base-event/base-event.js';

interface IRenderComponentEvent<
  Props extends Record<string, unknown> = Record<string, unknown>,
> {
  componentName: string;
  args?: Props;
  status?: 'isRunning' | 'done';
  eventId?: string;
}

export class RenderComponentEvent<
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends BaseEvent<IRenderComponentEvent<Props>> {
  constructor(
    public payload: WithRequiredEventProps<IRenderComponentEvent<Props>>,
  ) {
    payload.status = payload.status ?? 'isRunning';
    super();
    shouldHaveSessionId(payload);
  }
  public eventName = 'render_component';

  static eventName = 'render_component' as const;
}
