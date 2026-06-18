/**
 * Uniform error model (spec §6.1). Tools never throw to the agent; expected
 * failures come back as `{ ok: false, error: { code, message } }` with
 * friendly, leak-safe messages.
 */
export type FlowErrorCode =
  | 'no_flow_ref'
  | 'not_in_room'
  | 'flow_not_found'
  | 'validation_failed'
  | 'step_not_found'
  | 'referenced'
  | 'unknown_action'
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
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'error', message } };
}
