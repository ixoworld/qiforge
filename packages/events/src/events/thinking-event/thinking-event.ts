import {
  BaseEvent,
  type WithRequiredEventProps,
} from '../base-event/base-event.js';

/**
 * Payload for the ThinkingEvent.
 * Includes the standard required properties and a message field.
 */
export type ThinkingEventPayload = WithRequiredEventProps<{
  message: string; // Or potentially a status indicator
}>;

/**
 * Represents a 'thinking' event, typically used to indicate
 * an LLM or background process is working.
 */
export class ThinkingEvent extends BaseEvent<ThinkingEventPayload> {
  static override readonly eventName = 'thinking';
  readonly eventName = ThinkingEvent.eventName;
  public payload: ThinkingEventPayload;

  constructor(payload: ThinkingEventPayload) {
    super(); // Call base constructor checks

    // Validate specific payload properties if needed
    if (typeof payload.message !== 'string') {
      throw new TypeError(
        'ThinkingEvent payload must include a non-empty message string.',
      );
    }

    this.payload = payload;
  }

  public appendMessage(message: string): void {
    this.payload.message += message;
  }
}
