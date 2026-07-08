import {
  BaseEvent,
  shouldHaveSessionId,
  type WithRequiredEventProps,
} from '../base-event/base-event.js';

interface IMessageCacheInvalidation {
  status?: 'isRunning' | 'done';
}

export class MessageCacheInvalidationEvent extends BaseEvent<IMessageCacheInvalidation> {
  constructor(
    public payload: WithRequiredEventProps<IMessageCacheInvalidation>,
  ) {
    payload.status = payload.status ?? 'done';
    super();
    shouldHaveSessionId(payload);
  }
  public eventName = 'message_cache_invalidation';

  static eventName = 'message_cache_invalidation' as const;
}
