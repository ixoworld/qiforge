const MAX_RESPONSE_BYTES = 256 * 1024;

export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super('Decision provider returned a non-success HTTP status.');
  }
}

export function validateEndpoint(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      'Decision endpoint must be HTTPS without credentials, query or fragment.',
    );
  }
}

/** Bounded response reads, no redirects, no retries, and no upstream error bodies. */
export async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  sourceSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new DOMException('Decision cancelled.', 'AbortError'));
  if (sourceSignal?.aborted) cancel();
  sourceSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException('Decision timed out.', 'TimeoutError')),
    30_000,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stopRead = () => {
    void reader?.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener('abort', stopRead, { once: true });
  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ProviderHttpError(response.status);
    }
    if (!response.body)
      throw new Error('Decision provider returned an empty response.');
    reader = response.body.getReader();
    let bytes = 0;
    let json = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      controller.signal.throwIfAborted();
      const part = await reader.read();
      controller.signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error('Decision response exceeds the byte limit.');
      json += decoder.decode(part.value, { stream: true });
    }
    json += decoder.decode();
    // JSON.parse errors can echo response content; only the adapter's safe
    // error escapes this transport, without a cause or provider body.
    return JSON.parse(json);
  } finally {
    clearTimeout(timer);
    sourceSignal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', stopRead);
    void reader?.cancel().catch(() => undefined);
  }
}
