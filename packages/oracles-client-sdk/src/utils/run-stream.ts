/**
 * Consume a turn's SSE stream as a **durable run** (Workers runtime,
 * `docs/plans/durable-runs.md` in @ixo/oracle-runtime-workers):
 *
 *   - the first frame is `run` `{ runId }` (also the `x-run-id` header), and
 *     every frame carries its sequence number as the SSE `id:`;
 *   - the `done` frame — never the connection closing — ends the turn;
 *   - when the connection drops before `done` (network, tab suspended, a
 *     proxy timeout, the runtime host restarting), the client re-joins the
 *     run with `GET /runs/:runId?after=<last id>` and receives exactly the
 *     frames it missed, then the live tail;
 *   - a `run` frame with `resumed: true` means the runtime restarted and
 *     picked the turn up again; its `partialLength` is the reply text it
 *     kept, and the text shown is cut back to it before the continuation
 *     is appended (the last frames before a restart may never have been
 *     persisted, and the model does not repeat what was kept);
 *   - a `done` frame with `partialText` (an interrupted / aborted / failed
 *     run) carries the reply text the runtime kept, which replaces the
 *     text shown;
 *   - a POST is never repeated once the runtime accepted it: repeating it
 *     would send the message again;
 *   - a frame whose id is not above the cursor was already applied (the
 *     runtime only replays frames after `after`) and is skipped;
 *   - a POST or a re-join refused for its credentials (401/403) renews them
 *     (`onUnauthorized`, stage 1: a fresh invocation) and is sent again; a
 *     second refusal renews them once more (stage 2: a fresh delegation,
 *     then a fresh invocation) and sends it a last time. A refused request
 *     was never processed (the runtime authenticates before it reaches the
 *     user's object), so the repeat cannot send a message twice. A re-join
 *     still refused ends the stream `unauthorized` instead of spending the
 *     re-join budget on it; a POST still refused throws
 *     `StreamRunStartError` with the refusal's status.
 *
 * Against a runtime without durable runs (no `run` frame, no `x-run-id`)
 * this degrades to the previous behaviour: the stream ends when the
 * connection ends.
 */
import {
  isCredentialRefusalResponse,
  withAuthRenewal,
  type RenewAuth,
} from './auth-renewal.js';
import { parseSSEStream, type SSEEvent } from './sse-parser.js';

/** The run as seen so far, handed to `onEvent` after each frame is applied. */
export interface RunStreamState {
  requestId: string | null;
  runId: string | null;
  /** Highest frame id seen (the cursor a re-join sends). */
  lastId: number;
  /** The reply text as a client following the protocol displays it. */
  text: string;
  /** Times the runtime announced a resumed attempt. */
  resumed: number;
}

export interface StreamRunInput {
  /**
   * Start the turn: `POST /messages/:sessionId` with the turn body. Called
   * again only after a refusal of its credentials, so it should build its
   * credentials per call.
   */
  start: () => Promise<Response>;
  /**
   * Re-join a run after a cursor: `GET /runs/:runId?after=<seq>`. Called
   * once per attempt, so it should build its credentials per call.
   */
  join: (runId: string, after: number) => Promise<Response>;
  /**
   * The POST or a re-join was refused for its credentials (401/403): renew
   * them so the next attempt sends fresh ones. Stage 1 follows a first
   * refusal, stage 2 a refusal of the attempt renewed by stage 1; resolve
   * `false` when nothing could be renewed. Without it the first refusal
   * is final.
   */
  onUnauthorized?: RenewAuth;
  onEvent: (
    event: SSEEvent,
    state: Readonly<RunStreamState>,
  ) => void | Promise<void>;
  /** The user's own abort: stops re-joining and returns `ended: 'aborted'`. */
  signal?: AbortSignal;
  /** Re-join attempts after a drop before giving up (default 12). */
  maxRejoins?: number;
  /** Delay before re-join attempt n (default 500 ms, 1 s, 2 s, 4 s, 8 s, then 8 s). */
  rejoinDelayMs?: (attempt: number) => number;
  /** A drop happened; the client will re-join (for logging / UI). */
  onDisconnect?: (info: {
    runId: string;
    after: number;
    attempt: number;
  }) => void;
  /** A turn that was already running when the client attached (`resume`). */
  resume?: { runId: string; after?: number };
}

export interface StreamRunResult extends RunStreamState {
  /**
   * How the stream ended. `unauthorized`: the runtime refused to let this
   * client re-join the run after both renewal stages (or for a reason new
   * credentials cannot fix, or with nothing left to renew). The run itself
   * goes on; its reply lands in the transcript.
   */
  ended: 'done' | 'aborted' | 'disconnected' | 'error' | 'unauthorized';
  /** The `done` frame's data, when one was received. */
  done?: Record<string, unknown>;
}

const DEFAULT_MAX_REJOINS = 12;
const defaultDelay = (attempt: number): number =>
  Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1));

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError'))
  );
}

/** Apply a frame to the state (cursor, run id, text) before it is handed out. */
function applyFrame(state: RunStreamState, event: SSEEvent): void {
  if (typeof event.id === 'number' && event.id > state.lastId)
    state.lastId = event.id;
  switch (event.event) {
    case 'run':
      state.runId ??= event.data.runId;
      state.requestId ??= event.data.requestId;
      if (event.data.resumed) {
        state.resumed += 1;
        if (typeof event.data.partialLength === 'number')
          state.text = state.text.slice(
            0,
            Math.max(0, event.data.partialLength),
          );
      }
      break;
    case 'message':
      state.text += event.data.content;
      break;
    case 'done':
      if (
        typeof event.data.partialText === 'string' &&
        event.data.status !== 'finished'
      )
        state.text = event.data.partialText;
      break;
    default:
      break;
  }
}

/** An error thrown by the caller's `onEvent`, kept apart from a dropped read. */
class FrameHandlerError extends Error {
  constructor(readonly handlerError: unknown) {
    super('the frame handler failed');
  }
}

/**
 * Read one SSE response to its end. Returns `done` when the `done` frame
 * arrived, `dropped` when the body ended (or threw) before it. An error
 * thrown by `onEvent` is rethrown as is: it is the caller's failure, not
 * the connection's, and re-joining would not fix it.
 */
async function consume(
  response: Response,
  state: RunStreamState & { done?: Record<string, unknown> },
  onEvent: StreamRunInput['onEvent'],
  signal: AbortSignal | undefined,
): Promise<'done' | 'dropped' | 'aborted'> {
  if (!response.body) return 'dropped';
  const reader = response.body.getReader();
  try {
    for await (const event of parseSSEStream(reader)) {
      if (signal?.aborted) return 'aborted';
      // Already applied (the cursor only ever moves forward).
      if (typeof event.id === 'number' && event.id <= state.lastId) continue;
      applyFrame(state, event);
      try {
        await onEvent(event, state);
      } catch (error) {
        throw new FrameHandlerError(error);
      }
      if (event.event === 'done') {
        state.done = event.data as Record<string, unknown>;
        return 'done';
      }
    }
    return signal?.aborted ? 'aborted' : 'dropped';
  } catch (error) {
    if (error instanceof FrameHandlerError) {
      if (signal?.aborted) return 'aborted';
      throw error.handlerError;
    }
    if (isAbortError(error) || signal?.aborted) return 'aborted';
    return 'dropped';
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export async function streamRun(
  input: StreamRunInput,
): Promise<StreamRunResult> {
  const state: RunStreamState & { done?: Record<string, unknown> } = {
    requestId: null,
    runId: input.resume?.runId ?? null,
    lastId: input.resume?.after ?? 0,
    text: '',
    resumed: 0,
  };
  const maxRejoins = input.maxRejoins ?? DEFAULT_MAX_REJOINS;
  const delayOf = input.rejoinDelayMs ?? defaultDelay;

  /** Send a request, renewing its credentials (both stages) while they are refused. */
  const withRenewal = async (
    attempt: () => Promise<Response>,
  ): Promise<Response> =>
    (
      await withAuthRenewal({
        attempt,
        isRefused: isCredentialRefusalResponse,
        renew: input.onUnauthorized,
        signal: input.signal,
        discard: cancelBody,
      })
    ).outcome;

  /**
   * One re-join, with the two renewal stages when it is refused for its
   * credentials. The stages are spent per refusal: a re-join that gets
   * through earns the next refusal (a long turn outlives several
   * credentials) its own renewal, starting again at stage 1.
   */
  const join = async (runId: string): Promise<Response | 'unauthorized'> => {
    const response = await withRenewal(() => input.join(runId, state.lastId));
    if (!isAuthRefusal(response)) return response;
    cancelBody(response);
    return 'unauthorized';
  };

  let outcome: 'done' | 'dropped' | 'aborted' | 'unauthorized';
  if (input.resume) {
    const response = await join(input.resume.runId);
    if (response === 'unauthorized') {
      const { done: _done, ...rest } = state;
      return { ...rest, ended: 'unauthorized' };
    }
    state.requestId = response.headers.get('x-request-id');
    if (!response.ok) {
      const { done: _done, ...rest } = state;
      return { ...rest, ended: 'error' };
    }
    outcome = await consume(response, state, input.onEvent, input.signal);
  } else {
    const response = await withRenewal(input.start);
    state.requestId = response.headers.get('x-request-id');
    if (!response.ok && input.signal?.aborted) {
      // The user stopped the turn while its credentials were renewed.
      cancelBody(response);
      const { done: _done, ...rest } = state;
      return { ...rest, ended: 'aborted' };
    }
    if (!response.ok) {
      // A failed start has no run; the caller reads the error body.
      const message = await response.text().catch(() => '');
      throw new StreamRunStartError(response.status, message);
    }
    state.runId = response.headers.get('x-run-id') ?? state.runId;
    outcome = await consume(response, state, input.onEvent, input.signal);
  }

  let attempt = 0;
  while (outcome === 'dropped' && state.runId && attempt < maxRejoins) {
    if (input.signal?.aborted) {
      outcome = 'aborted';
      break;
    }
    attempt += 1;
    input.onDisconnect?.({ runId: state.runId, after: state.lastId, attempt });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delayOf(attempt));
      input.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
    if (input.signal?.aborted) {
      outcome = 'aborted';
      break;
    }
    let response: Response | 'unauthorized';
    try {
      response = await join(state.runId);
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted) {
        outcome = 'aborted';
        break;
      }
      continue; // network still down: next attempt
    }
    if (response === 'unauthorized') {
      outcome = 'unauthorized';
      break;
    }
    if (response.status === 404) break; // the run is gone (retention / wiped)
    if (!response.ok) continue;
    state.requestId = response.headers.get('x-request-id') ?? state.requestId;
    outcome = await consume(response, state, input.onEvent, input.signal);
  }

  const { done, ...rest } = state;
  return {
    ...rest,
    ended:
      outcome === 'done' || outcome === 'aborted' || outcome === 'unauthorized'
        ? outcome
        : 'disconnected',
    ...(done ? { done } : {}),
  };
}

/** The request was refused for its credentials, renewable or not. */
function isAuthRefusal(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Make sure an error thrown out of a turn carries the request id it belongs
 * to (the UI shows it as the request reference and de-duplicates by it).
 * Non-Error throwables are wrapped; an existing `requestId` is kept.
 */
export function withRequestId(
  error: unknown,
  requestId: string | null,
): Error & { requestId?: string | null } {
  const streamError: Error & { requestId?: string | null } =
    error instanceof Error ? error : new Error(String(error));
  if (!('requestId' in streamError)) streamError.requestId = requestId;
  return streamError;
}

export class StreamRunStartError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`turn request failed with ${status}`);
    this.name = 'StreamRunStartError';
  }
}
