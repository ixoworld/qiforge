import type { StreamEvent } from '@langchain/core/tracers/log_stream';

/**
 * Minimal `CompiledMainAgent` surface used by `SseStreamRunner` and the
 * batch invoker — `streamEvents` (async iterable of `StreamEvent`) and
 * `invoke` (single result). The runner only reads `event`, `data`,
 * `run_id`, and `name` from each yielded event, so the fixture pins a
 * `StreamEvent[]` and replays them in order.
 */
export interface FakeAgent {
  streamEvents: (input: unknown, cfg: unknown) => AsyncIterable<StreamEvent>;
  invoke: (input: unknown, cfg: unknown) => Promise<{ messages: unknown[] }>;
}

/**
 * Build a fake agent that yields the provided events one-by-one with a
 * microtask boundary between each. The boundary gives callers a chance
 * to call `abortController.abort()` between events and observe the
 * runner break out of its for-await loop on the next iteration.
 */
export function makeFakeAgent(events: StreamEvent[]): FakeAgent {
  return {
    streamEvents(): AsyncIterable<StreamEvent> {
      return (async function* () {
        for (const evt of events) {
          // Microtask boundary — lets tests call `abortController.abort()`
          // between events and observe the runner break out on the next loop.
          await Promise.resolve();
          yield evt;
        }
      })();
    },
    async invoke(): Promise<{ messages: unknown[] }> {
      return { messages: [] };
    },
  };
}

/**
 * Build a fake agent whose stream throws when consumed. Used for the
 * non-abort error branch test.
 */
export function makeThrowingFakeAgent(error: Error): FakeAgent {
  return {
    streamEvents(): AsyncIterable<StreamEvent> {
      return (async function* () {
        await Promise.resolve();
        throw error;

        yield undefined as unknown as StreamEvent;
      })();
    },
    async invoke(): Promise<{ messages: unknown[] }> {
      return { messages: [] };
    },
  };
}
