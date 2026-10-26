import { ImportError } from './contract';

export function publicUrl(raw: string, originOnly = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportError(503, 'invalid_destination_url');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !host.includes('.') ||
    host.endsWith('.') ||
    host.includes(':') ||
    /^[\d.]+$/.test(host) ||
    /(?:^|\.)(localhost|local|internal|localhost\.localdomain)$/.test(host) ||
    (originOnly && raw !== url.origin)
  )
    throw new ImportError(503, 'invalid_destination_url');
  return url;
}

export async function boundedBytes(
  response: Response,
  maxBytes = 262_144,
): Promise<Uint8Array> {
  if (!response.body) throw new ImportError(503, 'empty_response');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) throw new ImportError(503, 'response_too_large');
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export async function boundedJson(response: Response): Promise<unknown> {
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await boundedBytes(response),
    ),
  );
}

export async function noRedirectFetch(
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetcher(url, {
    ...init,
    redirect: 'manual',
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImportError(503, 'redirect_refused');
  }
  return response;
}
