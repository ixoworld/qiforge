import {
  BaseEvent,
  shouldHaveSessionId,
  type WithRequiredEventProps,
} from '../base-event/base-event.js';
import { EVENT_NAME, type IReasoningEvent } from './types.js';

export class ReasoningEvent extends BaseEvent<IReasoningEvent> {
  static override readonly eventName = EVENT_NAME;
  readonly eventName = ReasoningEvent.eventName;
  public payload: WithRequiredEventProps<IReasoningEvent>;

  constructor(payload: WithRequiredEventProps<IReasoningEvent>) {
    super();
    shouldHaveSessionId(payload);

    // Validate specific payload properties
    if (typeof payload.reasoning !== 'string') {
      throw new TypeError(
        'ReasoningEvent payload must include a reasoning string.',
      );
    }

    this.payload = payload;
  }

  /**
   * Append additional reasoning text to the current reasoning
   */
  public appendReasoning(reasoning: string): void {
    this.payload.reasoning += reasoning;
  }

  /**
   * Set the reasoning as complete
   */
  public markComplete(): void {
    this.payload.isComplete = true;
  }

  /**
   * Create a new ReasoningEvent with updated reasoning
   */
  public static createChunk(
    sessionId: string,
    requestId: string,
    reasoning: string,
    reasoningDetails?: IReasoningEvent['reasoningDetails'],
    isComplete = false,
  ): ReasoningEvent {
    return new ReasoningEvent({
      sessionId,
      requestId,
      reasoning,
      reasoningDetails,
      isComplete,
      timestamp: new Date().toISOString(),
    });
  }
}
