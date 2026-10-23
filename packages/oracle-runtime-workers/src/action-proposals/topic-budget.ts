import { TopicReadUnavailable, typedTopicError } from './topic-errors';
import type { TopicMatrixReader } from './topic-matrix';
export const TOPIC_READ_BUDGET_MS = 10_000;
export async function withTopicReadBudget<T>(
  reader: TopicMatrixReader,
  fetcher: typeof fetch,
  run: (reader: TopicMatrixReader, fetcher: typeof fetch) => Promise<T>,
  /** An outer budget (the alarm tick's): its abort ends this read too. */
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + TOPIC_READ_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (error: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new TopicReadUnavailable(
          'Topic verification exceeded the ten second budget',
        ),
      );
    }, TOPIC_READ_BUDGET_MS);
  });
  const onOuterAbort = () => {
    controller.abort();
    rejectDeadline(
      new TopicReadUnavailable('Topic verification budget expired'),
    );
  };
  if (outer?.aborted) onOuterAbort();
  else outer?.addEventListener('abort', onOuterAbort, { once: true });
  const active = () => {
    if (controller.signal.aborted)
      throw new TopicReadUnavailable('Topic verification budget expired');
  };
  const bounded: TopicMatrixReader = {
    state: async (room) => {
      active();
      const value = await reader.state(room);
      active();
      return value;
    },
    event: async (room, id, opts) => {
      active();
      const value = await reader.event(room, id, {
        ...opts,
        deadlineAt: Math.min(opts?.deadlineAt ?? Infinity, deadlineAt),
      });
      active();
      return value;
    },
    history: async (room, root, opts) => {
      active();
      const value = await reader.history(room, root, {
        ...opts,
        deadlineAt: Math.min(opts?.deadlineAt ?? Infinity, deadlineAt),
      });
      active();
      return value;
    },
  };
  const fetchBounded: typeof fetch = (input, init) => {
    active();
    return fetcher(input, { ...init, signal: controller.signal }).then(
      (response) => {
        active();
        return response;
      },
    );
  };
  try {
    return await Promise.race([run(bounded, fetchBounded), deadline]);
  } catch (error) {
    // The budget is where every authority read ends: whatever leaves it is
    // a conflict, unavailable, or a bug.
    throw typedTopicError(error);
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
    controller.abort();
  }
}
