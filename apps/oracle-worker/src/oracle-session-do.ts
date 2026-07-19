import {
  TURN_FRAME_VERSION,
  type TurnFrame,
  type TurnStreamSink,
} from '@ixo/oracle-core';
import type { SpikeDurableObjectState } from './cf-types.js';

/**
 * Durable Object stub for one oracle session. COMPILE SPIKE ONLY: it proves
 * the transport-neutral turn seam (`TurnStreamSink`, versioned frames with
 * monotonic sequence numbers) compiles against a workerd-shaped host with
 * zero Node dependencies. It accepts no traffic — `fetch` answers 503 like
 * every other route — and buffers frames in memory only.
 *
 * The real adapter (Phase 5) keys DOs by oracle+user+thread, persists
 * checkpoints per the DataPolicy, serializes hibernation state, and streams
 * frames over hibernatable WebSockets.
 */
export class OracleSessionDO {
  private readonly frames: TurnFrame[] = [];

  constructor(private readonly state: SpikeDurableObjectState) {}

  /** The seam the Phase 5 adapter will hand to `handleTurn`. */
  buildSink(): TurnStreamSink {
    return {
      write: async (frame) => {
        if (frame.v !== TURN_FRAME_VERSION) {
          throw new Error(
            `Unsupported turn-frame version ${String(frame.v)} (expected ${TURN_FRAME_VERSION}).`,
          );
        }
        this.frames.push(frame);
      },
      close: async () => {
        this.frames.length = 0;
      },
    };
  }

  fetch(): Response {
    return Response.json(
      {
        error: 'oracle-worker is a fail-closed compile spike',
        detail: `session DO ${this.state.id.toString()} accepts no traffic; see apps/oracle-worker/README.md`,
      },
      { status: 503 },
    );
  }
}
