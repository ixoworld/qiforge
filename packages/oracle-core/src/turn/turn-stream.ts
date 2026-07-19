/**
 * Transport-neutral turn-stream contract.
 *
 * A "turn" is one agent run translated into an ordered stream of typed
 * frames. The Node/express adapter renders frames as SSE lines; a Worker
 * adapter can render the same frames over a WebSocket or Durable Object
 * stream. The wire format each transport produces is its own business —
 * the frame contract is the seam.
 */

/** Version of the frame envelope; bump on breaking payload-shape changes. */
export const TURN_FRAME_VERSION = 1 as const;

export interface TurnFrame {
  v: typeof TURN_FRAME_VERSION;
  /**
   * Monotonic per-turn sequence number starting at 0. Lets a resuming
   * client (or a Durable Object replaying its buffer) detect gaps and
   * duplicates; the SSE adapter doesn't render it today.
   */
  seq: number;
  /** Wire event name (`message`, `tool_call`, `reasoning`, …). */
  event: string;
  payload: unknown;
}

/**
 * Where turn frames go. `write` is async ON PURPOSE: a transport with
 * backpressure (a slow socket, a DO buffer at capacity) awaits it, and the
 * turn loop pauses instead of buffering unboundedly.
 */
export interface TurnStreamSink {
  write(frame: TurnFrame): Promise<void>;
  /**
   * Terminal signal. Called exactly once when the turn loop ends —
   * `error` present when the turn failed. Transports translate this into
   * their own terminal wire event; sinks must tolerate `close` after a
   * transport-level disconnect.
   */
  close(error?: Error): Promise<void>;
}
