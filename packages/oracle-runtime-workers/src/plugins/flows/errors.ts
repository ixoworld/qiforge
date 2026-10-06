/**
 * Uniform error model (spec §6.1). Tools never throw to the agent; expected
 * failures come back as `{ ok: false, error: { code, message } }` with
 * friendly, leak-safe messages. Invalid tool input (a zod parse failure,
 * including a size limit) is `validation_failed` with the schema's messages.
 */
import { z } from 'zod';

export type FlowErrorCode =
  | 'no_flow_ref'
  | 'not_in_room'
  | 'flow_not_found'
  | 'validation_failed'
  | 'step_not_found'
  | 'referenced'
  | 'unknown_action'
  | 'needs_access'
  /**
   * A write the homeserver never acknowledged (server errors, a network
   * failure, or the wait ran out): it may or may not have been saved. The
   * same code the editor uses, so the runtime keeps the write's claim and
   * does not blindly run the identical write again.
   */
  | 'write_not_saved'
  | 'error';

export class FlowError extends Error {
  constructor(
    readonly code: FlowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FlowError';
  }
}

export interface ToolErrorResult {
  ok: false;
  error: { code: FlowErrorCode; message: string };
}

/** Normalize any thrown value into the structured tool-error result. */
export function toToolError(err: unknown): ToolErrorResult {
  if (err instanceof FlowError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  if (err instanceof z.ZodError) {
    const message = err.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      )
      .join(' ');
    return { ok: false, error: { code: 'validation_failed', message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'error', message } };
}
