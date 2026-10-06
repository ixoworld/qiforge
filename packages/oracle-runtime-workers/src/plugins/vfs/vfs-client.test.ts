import { describe, expect, it } from 'vitest';
import { VfsClient, type VfsMintFn } from './vfs-client';
import { VfsContentTooLargeError, VfsHttpError } from './vfs-errors';

interface Call {
  url: string;
  method: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeClient(
  respond: (call: Call, signal: AbortSignal | undefined) => Promise<Response>,
  opts: { timeoutMs?: number; signal?: AbortSignal; mint?: VfsMintFn } = {},
): { client: VfsClient; calls: Call[]; mints: number[] } {
  const calls: Call[] = [];
  const mints: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: String(input), method: init?.method ?? 'GET' };
    calls.push(call);
    return respond(call, init?.signal ?? undefined);
  };
  const client = new VfsClient({
    baseUrl: 'https://vfs.example/api/fs',
    timeoutMs: opts.timeoutMs ?? 5_000,
    signal: opts.signal,
    retryDelayMs: 0,
    fetchImpl,
    mint:
      opts.mint ??
      (async () => {
        mints.push(mints.length);
        return { bearer: `b${mints.length}` };
      }),
  });
  return { client, calls, mints };
}

/** A 200 whose body stream never produces a byte and never ends. */
function stalledBody(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
    }),
    {
      status: 200,
    },
  );
}

describe('VfsClient.statByPath', () => {
  const files = [
    { id: 'f-other', path: '/a/b', mimeType: 'text/plain', size: 1 },
    { id: 'f-q', path: '/a/?', mimeType: 'text/plain', size: 1 },
  ];

  it('resolves only the entry whose path equals the requested path', async () => {
    const { client } = makeClient(async () => json({ files }));
    expect((await client.statByPath('/a/?'))?.id).toBe('f-q');
  });

  it('returns null when a wildcard path only matches other files', async () => {
    const { client } = makeClient(async () => json({ files }));
    expect(await client.statByPath('/a/*')).toBeNull();
  });

  it('widens the glob page to the worker maximum for a path with wildcard characters', async () => {
    const { client, calls } = makeClient(async () => json({ files: [] }));
    await client.statByPath('/notes/why?.md');
    await client.statByPath('/notes/plain.md');
    expect(new URL(calls[0]?.url ?? '').searchParams.get('limit')).toBe('200');
    expect(new URL(calls[1]?.url ?? '').searchParams.has('limit')).toBe(false);
  });

  /** A `/glob` that pages `entries` by `offset` / `limit` like the worker. */
  function pagedGlob(entries: Array<{ id: string; path: string }>) {
    return async (call: Call) => {
      const params = new URL(call.url).searchParams;
      const offset = Number(params.get('offset') ?? 0);
      const limit = Number(params.get('limit') ?? 50);
      return json({ files: entries.slice(offset, offset + limit) });
    };
  }

  it('pages past earlier wildcard matches to find the literal file', async () => {
    // `?` sorts after the digits, so the literal name comes after f000…f999.
    const entries = [
      ...Array.from({ length: 1000 }, (_, i) => ({
        id: `n${i}`,
        path: `/logs/f${String(i).padStart(3, '0')}.txt`,
      })),
      { id: 'literal', path: '/logs/f???.txt' },
    ];
    const { client, calls } = makeClient(pagedGlob(entries));

    expect((await client.statByPath('/logs/f???.txt'))?.id).toBe('literal');
    expect(calls).toHaveLength(6);
  });

  it('stops at the first short page when the literal file does not exist', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      id: `n${i}`,
      path: `/logs/f${String(i).padStart(3, '0')}.txt`,
    }));
    const { client, calls } = makeClient(pagedGlob(entries));

    expect(await client.statByPath('/logs/f???.txt')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('refuses rather than answers "not found" when the matches exceed what can be searched', async () => {
    const entries = Array.from({ length: 6000 }, (_, i) => ({
      id: `n${i}`,
      path: `/logs/f${String(i).padStart(4, '0')}.txt`,
    }));
    const { client, calls } = makeClient(pagedGlob(entries));

    await expect(client.statByPath('/logs/f????.txt')).rejects.toMatchObject({
      status: 400,
    });
    expect(calls).toHaveLength(25);
  });

  it('refuses a path that resolves to more than one file', async () => {
    const { client } = makeClient(async () =>
      json({
        files: [
          { id: 'x1', path: '/dup.md' },
          { id: 'x2', path: '/dup.md' },
        ],
      }),
    );
    await expect(client.statByPath('/dup.md')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('ignores entries without a path instead of assuming they match', async () => {
    const { client } = makeClient(async () =>
      json({ files: [{ id: 'nopath' }] }),
    );
    expect(await client.statByPath('/a.md')).toBeNull();
  });
});

describe('VfsClient transport', () => {
  it('retries an idempotent GET once on 503, then succeeds', async () => {
    let n = 0;
    const { client, calls } = makeClient(async () =>
      ++n === 1 ? new Response('down', { status: 503 }) : json({ nodes: [] }),
    );
    expect(await client.list('/')).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('retries an idempotent GET at most once', async () => {
    const { client, calls } = makeClient(
      async () => new Response('down', { status: 503 }),
    );
    await expect(client.list('/')).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(2);
  });

  it('retries a GET once after a network error', async () => {
    let n = 0;
    const { client, calls } = makeClient(async () => {
      if (++n === 1) throw new TypeError('connection reset');
      return json({ nodes: [] });
    });
    expect(await client.list('/')).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('never retries a write on 5xx', async () => {
    const { client, calls } = makeClient(
      async () => new Response('boom', { status: 500 }),
    );
    await expect(client.trash(['f1'])).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it('re-mints a bearer once on 401', async () => {
    let n = 0;
    const { client, calls, mints } = makeClient(async () =>
      ++n === 1 ? new Response('', { status: 401 }) : json({ results: [] }),
    );
    expect(await client.trash(['f1'])).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(mints).toHaveLength(2);
  });

  it('times out a response whose body stalls after the headers arrived', async () => {
    const { client } = makeClient(async () => stalledBody(), {
      timeoutMs: 30,
    });
    const err = await client.list('/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VfsHttpError);
    expect(err).toMatchObject({
      status: 0,
      message: 'Filesystem request timed out.',
    });
  });

  it('stops reading a stalled body when the caller aborts', async () => {
    const caller = new AbortController();
    const reason = new Error('turn cancelled');
    const { client } = makeClient(async () => stalledBody(), {
      signal: caller.signal,
    });
    const pending = client.contentBytes('f1', 1024);
    setTimeout(() => caller.abort(reason), 10);
    await expect(pending).rejects.toBe(reason);
  });

  it('does not retry when the caller aborts the fetch', async () => {
    const caller = new AbortController();
    caller.abort(new Error('gone'));
    const { client, calls } = makeClient(
      async (_call, signal) => {
        if (signal?.aborted) throw signal.reason;
        return json({ nodes: [] });
      },
      { signal: caller.signal },
    );
    await expect(client.list('/')).rejects.toThrow('gone');
    expect(calls).toHaveLength(1);
  });

  it('a body that is not JSON parses as empty instead of throwing', async () => {
    const { client } = makeClient(
      async () => new Response('<html>', { status: 200 }),
    );
    expect(await client.list('/')).toEqual([]);
  });
});

describe('VfsClient.contentBytes size cap', () => {
  it('refuses from content-length without reading the body', async () => {
    let pulled = false;
    const { client } = makeClient(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(c) {
                pulled = true;
                c.enqueue(new Uint8Array(8));
                c.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, headers: { 'content-length': '5000' } },
        ),
    );
    const err = await client.contentBytes('f1', 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VfsContentTooLargeError);
    expect(err).toMatchObject({ limitBytes: 1000 });
    expect(pulled).toBe(false);
  });

  it('refuses while streaming when content-length is absent', async () => {
    let chunks = 0;
    const { client } = makeClient(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              chunks += 1;
              c.enqueue(new Uint8Array(400));
              if (chunks > 100) c.close();
            },
          }),
          { status: 200 },
        ),
    );
    await expect(client.contentBytes('f1', 1000)).rejects.toBeInstanceOf(
      VfsContentTooLargeError,
    );
    // Stopped at the first chunk past the cap, not after the whole stream.
    expect(chunks).toBeLessThan(10);
  });

  it('returns the exact bytes and mime type at or under the cap', async () => {
    const { client } = makeClient(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 233]), {
          status: 200,
          headers: { 'content-type': 'text/csv; charset=latin1' },
        }),
    );
    const got = await client.contentBytes('f1', 4);
    expect([...new Uint8Array(got.bytes)]).toEqual([1, 2, 3, 233]);
    expect(got).toMatchObject({ mimeType: 'text/csv', size: 4 });
  });
});
