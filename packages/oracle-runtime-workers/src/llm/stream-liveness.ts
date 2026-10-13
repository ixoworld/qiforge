/**
 * Liveness guard for model calls: a `fetch` wrapper that notices a provider
 * which has stopped sending bytes and fails (or retries) the call, instead
 * of letting it hang until the turn deadline.
 *
 * Nothing else bounds a single model call below the turn deadline. The
 * OpenAI SDK's request timeout only covers the wait for response headers
 * (its timer is cleared as soon as `fetch` resolves), so a streamed body
 * that goes quiet is never noticed, and LangChain's retry only reacts to a
 * thrown error. The guard watches the raw body bytes:
 *
 *  - headers: no response within `headersTimeoutMs`;
 *  - first byte: response headers arrived but no body byte within
 *    `idleTimeoutMs` (the returned promise only resolves once the first
 *    byte is in, so a stall here is retried transparently);
 *  - stream: no byte for `idleTimeoutMs` after bytes were forwarded.
 *
 * Any byte counts — SSE comments (OpenRouter's `: OPENROUTER PROCESSING`
 * keep-alives) and Anthropic `ping` events included — so a provider that
 * signals it is working is never cut off. There is no cap on the total
 * duration: a long reply that keeps streaming is legitimate.
 *
 * Most model calls of a turn are streamed (LangChain streams every call
 * inside a `streamEvents` turn). A few are not — the session title, the
 * group-chat summary, the platform model answering for a refused BYO model —
 * and their single JSON body only starts once the generation is done, so for
 * them `headersTimeoutMs` + `idleTimeoutMs` bound the whole generation and a
 * longer one is re-sent and then fails. Those calls are short; this is
 * accepted rather than special-cased.
 *
 * A stall at the headers or first-byte phase re-issues the identical
 * request up to `retries` times (only when the request body can be sent
 * again). A stall after bytes were forwarded cannot be retried
 * transparently — the caller already consumed part of the reply — so the
 * body errors with `ProviderStallError` and the call fails fast.
 *
 * Every timer is cleared when its phase ends, on completion, on error, on
 * cancel and on abort: on workerd a dangling timer keeps the user's Durable
 * Object resident (see `src/plugins/mcp-call-timeout.ts`).
 */
import { AsyncCaller } from '@langchain/core/utils/async_caller';
import type { Logger } from '../plugin-api/types';
import { NOOP_LOGGER } from '../core/utils';

/** Where a stalled call stopped. */
export type StallPhase = 'headers' | 'first-byte' | 'stream';

/** The provider stopped sending bytes (or never started). */
export class ProviderStallError extends Error {
  override readonly name = 'ProviderStallError';
  readonly phase: StallPhase;
  /** The silence budget that ran out (ms). */
  readonly idleMs: number;
  /** Time since the attempt started (ms). */
  readonly elapsedMs: number;
  /** Body bytes received before the stall. */
  readonly bytesSeen: number;
  readonly label: string;

  constructor(init: {
    phase: StallPhase;
    idleMs: number;
    elapsedMs: number;
    bytesSeen: number;
    label: string;
  }) {
    const seconds = Math.round(init.idleMs / 1000);
    super(
      init.phase === 'headers'
        ? `${init.label}: the provider sent no response for ${seconds} s`
        : init.phase === 'first-byte'
          ? `${init.label}: the provider answered but sent no data for ${seconds} s`
          : `${init.label}: the provider stopped sending data mid-reply (no bytes for ${seconds} s after ${init.bytesSeen} bytes)`,
    );
    this.phase = init.phase;
    this.idleMs = init.idleMs;
    this.elapsedMs = init.elapsedMs;
    this.bytesSeen = init.bytesSeen;
    this.label = init.label;
  }
}

/**
 * The `ProviderStallError` in `error` or its `cause` chain — the OpenAI SDK
 * wraps a failed `fetch` in `APIConnectionError` with the original as
 * `cause`, LangChain's middleware errors wrap again.
 */
export function findProviderStall(error: unknown): ProviderStallError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof ProviderStallError) return current;
    if (!current || typeof current !== 'object' || !('cause' in current))
      return null;
    current = current.cause;
  }
  return null;
}

/** The three budgets of one model lane. */
export interface StreamLivenessSettings {
  /** Time to response headers (ms). */
  headersTimeoutMs: number;
  /** Longest silence between body bytes, and before the first one (ms). */
  idleTimeoutMs: number;
  /** Whole-request retries while no body byte has been forwarded. */
  retries: number;
}

/** What the guard reports, for tests and diagnostics. */
export type LivenessEvent =
  | { type: 'first-byte'; afterMs: number; attempt: number }
  | { type: 'retry'; phase: StallPhase; attempt: number }
  | { type: 'stall'; error: ProviderStallError; attempt: number };

export interface LivenessFetchOptions {
  headersTimeoutMs: number;
  idleTimeoutMs: number;
  /** Default 1. */
  retries?: number;
  /** Names the call in logs and in the stall error (e.g. `openrouter main openai/gpt-5`). */
  label: string;
  logger?: Logger;
  /** The fetch that does the work; default the global `fetch`, resolved per call. */
  fetch?: typeof fetch;
  onEvent?: (event: LivenessEvent) => void;
}

const DEFAULT_RETRIES = 1;

/**
 * The SDK request timeout to pair with a guard: longer than the guard can
 * take before its promise settles (every attempt waiting out both budgets),
 * so the guard — never the SDK — decides a stall, and the SDK timer stays a
 * backstop that replaces its 10-minute default.
 */
export function livenessRequestTimeoutMs(
  settings: StreamLivenessSettings,
): number {
  return (
    (settings.retries + 1) *
      (settings.headersTimeoutMs + settings.idleTimeoutMs) +
    5_000
  );
}

/** A body `fetch` can send again unchanged. */
function isReplayableBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams ||
    (typeof Blob !== 'undefined' && body instanceof Blob)
  );
}

/** The caller's abort reason, as the error the aborted call fails with. */
function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    reason === undefined ? 'The operation was aborted.' : String(reason),
    'AbortError',
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A caller-supplied `configuration.fetch` (plugins may pass one through
 * `ctx.llm.get(role, { configuration })`), as a typed fetch the guard can
 * wrap; `undefined` when absent or not a function.
 */
export function asFetch(value: unknown): typeof fetch | undefined {
  if (typeof value !== 'function') return undefined;
  return async (input, init) => {
    const result: unknown = await Reflect.apply(value, undefined, [
      input,
      init,
    ]);
    if (!(result instanceof Response))
      throw new TypeError('configuration.fetch did not return a Response');
    return result;
  };
}

/**
 * Build a `fetch` that enforces the liveness budgets on every request it
 * makes (see the module docblock).
 */
export function createLivenessFetch(
  options: LivenessFetchOptions,
): typeof fetch {
  const logger = options.logger ?? NOOP_LOGGER;
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const { headersTimeoutMs, idleTimeoutMs, label } = options;
  // Never keep the bare global: workerd rejects `fetch` invoked with a
  // foreign `this`, and a test may stub the global after this is built.
  const baseFetch: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const attemptOnce = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    attempt: number,
  ): Promise<Response> => {
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (callerSignal?.aborted)
      return Promise.reject(abortReasonOf(callerSignal));
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Rejects the step in flight (headers wait or a body read). */
    let failPending: ((reason: Error) => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bytesSeen = 0;
    let finished = false;

    const clearTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const onCallerAbort = (): void => {
      if (!callerSignal) return;
      clearTimer();
      const reason = abortReasonOf(callerSignal);
      controller.abort(reason);
      if (reader) void reader.cancel(reason).catch(() => undefined);
      failPending?.(reason);
    };
    /** The attempt is over (done, failed, cancelled): drop every hook. */
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimer();
      failPending = undefined;
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    const stall = (phase: StallPhase, budgetMs: number): ProviderStallError => {
      const error = new ProviderStallError({
        phase,
        idleMs: budgetMs,
        elapsedMs: Date.now() - started,
        bytesSeen,
        label,
      });
      options.onEvent?.({ type: 'stall', error, attempt });
      controller.abort(error);
      if (reader) void reader.cancel(error).catch(() => undefined);
      return error;
    };

    /** One body read, bounded by the idle budget. */
    const readChunk = (
      phase: 'first-byte' | 'stream',
    ): Promise<ReadableStreamReadResult<Uint8Array>> =>
      new Promise((resolve, reject) => {
        const active = reader;
        if (!active) {
          reject(new Error('liveness guard: no body reader'));
          return;
        }
        if (callerSignal?.aborted) {
          reject(abortReasonOf(callerSignal));
          return;
        }
        failPending = reject;
        timer = setTimeout(() => {
          timer = undefined;
          reject(stall(phase, idleTimeoutMs));
        }, idleTimeoutMs);
        active.read().then(
          (result) => {
            clearTimer();
            if (callerSignal?.aborted) reject(abortReasonOf(callerSignal));
            else resolve(result);
          },
          (error: unknown) => {
            clearTimer();
            reject(toError(error));
          },
        );
      });

    const run = async (): Promise<Response> => {
      // ── headers ──
      const response = await new Promise<Response>((resolve, reject) => {
        let settled = false;
        failPending = (reason) => {
          settled = true;
          reject(reason);
        };
        timer = setTimeout(() => {
          timer = undefined;
          settled = true;
          reject(stall('headers', headersTimeoutMs));
        }, headersTimeoutMs);
        baseFetch(input, { ...init, signal: controller.signal }).then(
          (res) => {
            clearTimer();
            if (settled) {
              // Answered after the guard gave up: release the body.
              void res.body?.cancel().catch(() => undefined);
              return;
            }
            settled = true;
            resolve(res);
          },
          (error: unknown) => {
            clearTimer();
            if (settled) return;
            settled = true;
            reject(toError(error));
          },
        );
      });
      if (!response.body) {
        finish();
        return response;
      }

      // ── first byte ──
      reader = response.body.getReader();
      const firstChunks: Uint8Array[] = [];
      let ended = false;
      while (bytesSeen === 0) {
        const result = await readChunk('first-byte');
        if (result.done) {
          ended = true;
          break;
        }
        if (result.value.byteLength === 0) continue;
        bytesSeen += result.value.byteLength;
        firstChunks.push(result.value);
      }
      const firstByteMs = Date.now() - started;
      if (bytesSeen > 0) {
        options.onEvent?.({
          type: 'first-byte',
          afterMs: firstByteMs,
          attempt,
        });
        logger.debug?.(`[llm] ${label}: first byte after ${firstByteMs} ms`);
      }
      if (ended) finish();

      // ── stream ──
      const upstream = reader;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          for (const chunk of firstChunks) streamController.enqueue(chunk);
          if (ended) streamController.close();
        },
        async pull(streamController) {
          try {
            const result = await readChunk('stream');
            // The consumer cancelled while this read was pending: the
            // controller is gone, nothing more to do.
            if (finished) return;
            if (result.done) {
              finish();
              streamController.close();
              return;
            }
            bytesSeen += result.value.byteLength;
            streamController.enqueue(result.value);
          } catch (error) {
            finish();
            if (error instanceof ProviderStallError)
              logger.warn(
                `[llm] ${label}: no bytes for ${Math.round(idleTimeoutMs / 1000)} s after ${bytesSeen} bytes (${Math.round(error.elapsedMs / 1000)} s into the call); failing it — a stall mid-reply is not retried`,
              );
            throw error;
          }
        },
        cancel(reason) {
          finish();
          return upstream.cancel(reason);
        },
      });
      const wrapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      if (response.url)
        Object.defineProperty(wrapped, 'url', { value: response.url });
      return wrapped;
    };

    return run().catch((error: unknown) => {
      finish();
      throw error;
    });
  };

  return async (input, init) => {
    const replayable =
      isReplayableBody(init?.body) &&
      !(input instanceof Request && input.body !== null);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await attemptOnce(input, init, attempt);
      } catch (error) {
        const retry =
          error instanceof ProviderStallError &&
          error.phase !== 'stream' &&
          attempt <= retries &&
          replayable &&
          !init?.signal?.aborted &&
          !(input instanceof Request && input.signal.aborted);
        if (!retry) {
          if (error instanceof ProviderStallError)
            logger.warn(
              `[llm] ${label}: ${error.phase === 'headers' ? 'no response' : 'no bytes'} for ${Math.round(error.idleMs / 1000)} s; giving up after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
            );
          throw error;
        }
        logger.warn(
          `[llm] ${label}: ${error.phase === 'headers' ? 'no response' : 'no bytes'} for ${Math.round(error.idleMs / 1000)} s, retrying (attempt ${attempt + 1})`,
        );
        options.onEvent?.({
          type: 'retry',
          phase: error.phase,
          attempt: attempt + 1,
        });
      }
    }
  };
}

/**
 * LangChain's default retry rule (the one `AsyncCaller` applies when no
 * handler is given), reachable only from a subclass.
 */
class DefaultRetryRule extends AsyncCaller {
  static handler(): ((error: unknown) => unknown) | undefined {
    return new DefaultRetryRule({}).onFailedAttempt;
  }
}

/**
 * `onFailedAttempt` for a guarded model: a stall the guard already gave up
 * on is not retried again by LangChain (the guard owns stall retries, so
 * `LLM_STREAM_RETRIES` is the whole budget); everything else follows
 * LangChain's default rule.
 */
export function stallAwareFailedAttemptHandler(): (error: unknown) => unknown {
  const fallback = DefaultRetryRule.handler();
  return (error) => {
    if (findProviderStall(error)) throw error;
    return fallback?.(error);
  };
}

/**
 * The `ChatOpenAI` fields every guarded model gets: the SDK timeout as a
 * backstop behind the guard, and the stall-aware retry rule. Spread them
 * before the caller's params so an explicit caller value still wins.
 */
export function livenessModelFields(settings: StreamLivenessSettings): {
  timeout: number;
  onFailedAttempt: (error: unknown) => unknown;
} {
  return {
    timeout: livenessRequestTimeoutMs(settings),
    onFailedAttempt: stallAwareFailedAttemptHandler(),
  };
}

/**
 * The guarded `configuration.fetch` for one model: wraps the caller's own
 * `configuration.fetch` when one was passed, else `base` (default: the
 * global fetch).
 */
export function livenessFetchFor(args: {
  settings: StreamLivenessSettings;
  label: string;
  logger?: Logger;
  /** `params.configuration.fetch`, as the caller passed it. */
  callerFetch?: unknown;
  base?: typeof fetch;
}): typeof fetch {
  const inner = asFetch(args.callerFetch) ?? args.base;
  return createLivenessFetch({
    ...args.settings,
    label: args.label,
    ...(args.logger ? { logger: args.logger } : {}),
    ...(inner ? { fetch: inner } : {}),
  });
}
