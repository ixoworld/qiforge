import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { VfsClient } from './vfs-client.js';

function client(fetchImpl: typeof fetch): VfsClient {
  return new VfsClient({
    baseUrl: 'https://vfs.test/api/fs',
    mint: vi.fn(async () => ({ bearer: 'B' })),
    timeoutMs: 1000,
    fetchImpl,
    retryDelayMs: 0,
  });
}

const json201 = (): Response =>
  new Response(JSON.stringify({ id: 'f1', path: 'oracle-data/e/k.db.gz' }), {
    status: 201,
  });

async function drain(body: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!body) return 0;
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

describe('VfsClient streaming', () => {
  it('createStream sends a streamed body with content-length and re-opens it on 401', async () => {
    const opens = vi.fn(() => Readable.from([Buffer.alloc(1024, 7)]));
    const seen: Array<{
      url: string;
      init: RequestInit & { duplex?: string };
    }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request: RequestInit & { duplex?: string } = init ?? {};
        seen.push({ url: String(input), init: request });
        const bodyBytes =
          request.body instanceof ReadableStream
            ? await drain(request.body)
            : 0;
        if (seen.length === 1)
          return new Response('unauthorized', { status: 401 });
        return new Response(
          JSON.stringify({
            id: 'f1',
            path: 'oracle-data/e/k.db.gz',
            cid: 'bafy',
            size: bodyBytes,
          }),
          { status: 201 },
        );
      },
    );

    const stat = await client(fetchImpl).createStream('oracle-data/e/k.db.gz', {
      open: opens,
      sizeBytes: 1024,
      mime: 'application/gzip',
    });

    expect(stat).toMatchObject({ id: 'f1', cid: 'bafy', size: 1024 });
    expect(opens).toHaveBeenCalledTimes(2);
    expect(seen[1]?.init.duplex).toBe('half');
    expect(new Headers(seen[1]?.init.headers).get('content-length')).toBe(
      '1024',
    );
    expect(new Headers(seen[1]?.init.headers).get('content-type')).toBe(
      'application/gzip',
    );
    expect(seen[1]?.url).toBe(
      'https://vfs.test/api/fs/files?path=oracle-data%2Fe%2Fk.db.gz',
    );
  });

  it('closes the opened body stream when the server answers before reading it', async () => {
    // An auth middleware rejecting a large upload responds immediately; the
    // fetch implementation never cancels the request stream, so the fd behind
    // it stays open unless the client closes it itself.
    const source = Readable.from([Buffer.alloc(1024, 7)]);
    const fetchImpl = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    );

    await expect(
      client(fetchImpl).createStream('oracle-data/e/k.db.gz', {
        open: () => source,
        sizeBytes: 1024,
        mime: 'application/gzip',
      }),
    ).rejects.toThrow();

    expect(source.destroyed).toBe(true);
  });

  it('sends credentials: omit so a 401 on a streamed body stays observable', async () => {
    // With the default credentials mode undici re-sends a 401 with
    // credentials, which needs a replayable body — a stream has none, so the
    // whole call rejects and the re-mint retry below can never run.
    const seen: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init);
        return json201();
      },
    );
    await client(fetchImpl).createStream('oracle-data/e/k.db.gz', {
      open: () => Readable.from([Buffer.from('gz')]),
      sizeBytes: 2,
      mime: 'application/gzip',
    });
    expect(seen[0]?.credentials).toBe('omit');
  });

  it('contentStreamByPath streams the body and surfaces the hash headers', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from('gzip-bytes'), {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            'content-length': '10',
            'x-vfs-content-hash': 'deadbeef',
            'x-vfs-cid': 'bafyq',
          },
        }),
    );
    const result = await client(fetchImpl).contentStreamByPath(
      'oracle-data/e/k.db.gz',
    );
    if (!result) throw new Error('expected a content stream');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('gzip-bytes');
    expect(result).toMatchObject({
      sizeBytes: 10,
      contentHash: 'deadbeef',
      cid: 'bafyq',
      mimeType: 'application/gzip',
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://vfs.test/api/fs/content?path=oracle-data%2Fe%2Fk.db.gz',
    );
  });

  it('contentStreamByPath returns null on 404', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not found', { status: 404 }),
    );
    expect(await client(fetchImpl).contentStreamByPath('missing')).toBeNull();
  });

  it('purge posts to /batch/purge', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ results: [{ id: 'f1', ok: true, status: 200 }] }),
          { status: 200 },
        ),
    );
    expect(await client(fetchImpl).purge(['f1'])).toEqual([
      { id: 'f1', ok: true, status: 200, path: undefined, error: undefined },
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://vfs.test/api/fs/batch/purge',
    );
  });
});
