import type { TopicMatrixReader } from './topic-matrix';
export async function withTopicReadBudget<T>(
  reader: TopicMatrixReader,
  fetcher: typeof fetch,
  run: (reader: TopicMatrixReader, fetcher: typeof fetch) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Topic verification exceeded the ten second budget'));
    }, 10000);
  });
  const active = () => {
    if (controller.signal.aborted)
      throw new Error('Topic verification budget expired');
  };
  const bounded: TopicMatrixReader = {
    state: async (room) => {
      active();
      const value = await reader.state(room);
      active();
      return value;
    },
    event: async (room, id) => {
      active();
      const value = await reader.event(room, id);
      active();
      return value;
    },
    history: async (room, root) => {
      active();
      const value = await reader.history(room, root);
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
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
