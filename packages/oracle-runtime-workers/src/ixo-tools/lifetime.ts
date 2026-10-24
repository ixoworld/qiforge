export const IXO_TOOLS_TIMEOUT_MS = 30_000;

function cancelled(): DOMException {
  return new DOMException('IXO request cancelled', 'AbortError');
}

export async function runIxoOperation<T>(
  caller: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (caller?.aborted) throw cancelled();
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException('IXO request timed out', 'TimeoutError'),
      ),
    IXO_TOOLS_TIMEOUT_MS,
  );
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => {
      const reason: unknown = controller.signal.reason;
      reject(reason instanceof Error ? reason : cancelled());
    };
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  caller?.addEventListener('abort', abort, { once: true });
  try {
    if (caller?.aborted) abort();
    controller.signal.throwIfAborted();
    const result = await Promise.race([work(controller.signal), aborted]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timeout);
    caller?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export function lifetimeFetch(
  fetcher: typeof fetch,
  lifetime: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    lifetime.throwIfAborted();
    const sourceSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = sourceSignal
      ? AbortSignal.any([lifetime, sourceSignal])
      : lifetime;
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw cancelled();
    }
    return response;
  };
}
