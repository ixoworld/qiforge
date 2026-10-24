import { z } from 'zod';
import type { EvidenceSource, HostFacts } from '@ixo/agent-tools';
import type { SourceConfig } from './ports.js';

export class SourceFailure extends Error {
  constructor(readonly status: 'unauthorized' | 'unavailable') {
    super(status);
  }
}
export const instant = z.iso.datetime({ offset: true });
export const revision = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const MAX_BYTES = 1_000_000;
export async function boundedText(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new SourceFailure('unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        chunks.push(value);
      }
      if (size > MAX_BYTES) throw new SourceFailure('unavailable');
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('')}`;
}
export function available(
  context: HostFacts,
  value: unknown,
  evidence: readonly unknown[],
): unknown {
  return { version: 1, status: 'available', scope: context, value, evidence };
}
export function evidence(
  source: EvidenceSource,
  reference: string,
  revision: string,
  observedAt: string,
) {
  return {
    source,
    reference,
    revision,
    observedAt,
    freshness: 'current' as const,
  };
}
export async function guarded(
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await action();
  } catch (error) {
    return {
      version: 1,
      status: error instanceof SourceFailure ? error.status : 'unavailable',
    };
  }
}

type Service = keyof SourceConfig['origins'];
export function createSourceHttp(config: SourceConfig) {
  const fetcher = config.fetch ?? globalThis.fetch.bind(globalThis);
  const origins = Object.fromEntries(
    Object.entries(config.origins).map(([name, value]) => {
      const url = new URL(value);
      if (
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          ))
      ) {
        throw new TypeError('Source bindings must be HTTPS origins');
      }
      return [name, url.origin];
    }),
  );
  async function raw(
    service: Service,
    context: HostFacts,
    path: string,
    body?: unknown,
    action: 'read' | 'quote' | 'list' = 'read',
  ): Promise<Response> {
    if (context.network !== config.network)
      throw new SourceFailure('unauthorized');
    const origin = origins[service];
    if (!origin) throw new SourceFailure('unavailable');
    const url = new URL(path, origin);
    if (url.origin !== origin || !path.startsWith('/') || path.startsWith('//'))
      throw new SourceFailure('unavailable');
    const expectedDid = `did:web:${new URL(origin).host.replaceAll(':', '%3A')}`;
    const docResponse = await fetcher(`${origin}/.well-known/did.json`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const doc = z
      .object({ id: z.literal(expectedDid) })
      .parse(JSON.parse(await boundedText(docResponse)));
    if (doc.id !== expectedDid) throw new SourceFailure('unavailable');
    const token = await (service === 'yellowcard'
      ? config.authority.yellowcard(
          context,
          action === 'quote' ? 'quote' : 'read',
        )
      : service === 'vfs'
        ? config.authority.vfs(context, action === 'list' ? 'list' : 'read')
        : config.authority[service](context));
    if (!token) throw new SourceFailure('unauthorized');
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Auth-Type': 'ucan',
        'Content-Type': 'application/json',
        'x-room-id': context.roomId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if ([401, 403, 404].includes(response.status))
      throw new SourceFailure('unauthorized');
    if (!response.ok) throw new SourceFailure('unavailable');
    return response;
  }
  async function request(
    service: Service,
    context: HostFacts,
    path: string,
    body?: unknown,
    action: 'read' | 'quote' | 'list' = 'read',
  ): Promise<unknown> {
    return JSON.parse(
      await boundedText(await raw(service, context, path, body, action)),
    );
  }
  return { request, raw, fetcher };
}
export type SourceHttp = ReturnType<typeof createSourceHttp>;
