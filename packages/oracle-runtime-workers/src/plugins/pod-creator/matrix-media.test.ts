/**
 * The POD creator's public documents on the homeserver: reserved with the
 * asynchronous upload (`POST /_matrix/media/v1/create`), uploaded after
 * approval (`PUT /_matrix/media/v3/upload/{server}/{id}`), against a fake
 * homeserver answering the way Synapse does (checked on a local Synapse:
 * 200 `{}` on upload, 409 `M_CANNOT_OVERWRITE_MEDIA` on a second upload,
 * 404 `M_NOT_FOUND` for an unknown id, 404 `M_UNRECOGNIZED` for an unknown
 * route, 401 `M_UNKNOWN_TOKEN` for a rejected token).
 */
import { describe, expect, it, vi } from 'vitest';
import { createNoopAmbient } from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  documentProof,
  publishPendingDocuments,
  reservePublicDocument,
  type MatrixMediaDeps,
} from './matrix-media';

const HOMESERVER = 'https://matrix.example';
const MXC = 'mxc://matrix.example/Reserved123';
const DOWNLOAD = `${HOMESERVER}/_matrix/media/v3/download/matrix.example/Reserved123`;
const DOCUMENT = {
  text: '{"name":"Solar POD"}',
  filename: 'profile.json',
  contentType: 'application/ld+json',
};
const PENDING = {
  mxc: MXC,
  contentType: DOCUMENT.contentType,
  filename: DOCUMENT.filename,
  text: DOCUMENT.text,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const RESERVED = () =>
  json({ content_uri: MXC, unused_expires_at: Date.now() + 86_400_000 });

/** An answer that never comes: like `fetch`, the request only ends when its signal aborts. */
const HANG = (init: RequestInit | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (init?.signal?.aborted) abort();
    init?.signal?.addEventListener('abort', abort);
  });

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string | null;
}

type Handler = (
  n: number,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

/** A fake homeserver: each route answers from its handler; every request is recorded. */
function homeserver(routes: {
  create?: Handler;
  put?: Handler;
  upload?: Handler;
}) {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body;
    seen.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: body instanceof Uint8Array ? new TextDecoder().decode(body) : null,
    });
    const route = url.endsWith('/_matrix/media/v1/create')
      ? 'create'
      : url.includes('/_matrix/media/v3/upload/')
        ? 'put'
        : url.includes('/_matrix/media/v3/upload?')
          ? 'upload'
          : null;
    const handler = route ? routes[route] : undefined;
    if (!route || !handler) throw new Error(`unexpected request ${url}`);
    const n = (counts.get(route) ?? 0) + 1;
    counts.set(route, n);
    return handler(n, init);
  };
  return { fetchImpl, seen };
}

function deps(fetchImpl: typeof fetch): MatrixMediaDeps {
  return { fetch: fetchImpl, requestTimeoutMs: 50, credentialsTimeoutMs: 50 };
}

/** The plugin device's credentials, as the host hands them out (a fresh token after a rejection). */
function credentials() {
  return vi.fn(async (opts?: { rejected?: string }) => ({
    baseUrl: `${HOMESERVER}/`,
    userId: '@oracle:matrix.example',
    accessToken: opts?.rejected ? 'fresh-token' : 'device-token',
    deviceId: 'PLUGINS',
  }));
}

function ctxWith(
  botCredentials: RuntimeContext['matrix']['botCredentials'] = credentials(),
  over: Partial<RuntimeContext> = {},
): RuntimeContext {
  const base = makeRuntimeContext();
  return {
    ...base,
    kv: createMemoryUserKv(),
    matrix: { ...base.matrix, botCredentials },
    ...over,
  };
}

const deadline = () => Date.now() + 20_000;

describe('reservePublicDocument', () => {
  it('reserves the document without uploading it, as the plugin device', async () => {
    const { fetchImpl, seen } = homeserver({ create: RESERVED });
    await expect(
      reservePublicDocument(ctxWith(), DOCUMENT, deps(fetchImpl), deadline()),
    ).resolves.toEqual({ ok: true, url: DOWNLOAD, pending: PENDING });
    expect(seen).toEqual([
      {
        url: `${HOMESERVER}/_matrix/media/v1/create`,
        method: 'POST',
        authorization: 'Bearer device-token',
        contentType: null,
        body: null,
      },
    ]);
  });

  it('reuses the reservation of the same bytes, and once uploaded has nothing left to upload', async () => {
    const { fetchImpl, seen } = homeserver({
      create: RESERVED,
      put: () => json({}),
    });
    const ctx = ctxWith();
    const first = await reservePublicDocument(
      ctx,
      DOCUMENT,
      deps(fetchImpl),
      deadline(),
    );
    const again = await reservePublicDocument(
      ctx,
      DOCUMENT,
      deps(fetchImpl),
      deadline(),
    );
    expect(again).toEqual(first);
    expect(
      seen.filter((request) => request.url.endsWith('/create')),
    ).toHaveLength(1);

    await publishPendingDocuments(ctx, [PENDING], deps(fetchImpl), deadline());
    await expect(
      reservePublicDocument(ctx, DOCUMENT, deps(fetchImpl), deadline()),
    ).resolves.toEqual({ ok: true, url: DOWNLOAD, pending: null });

    // Other bytes are another document.
    await reservePublicDocument(
      ctx,
      { ...DOCUMENT, text: '{"name":"Other"}' },
      deps(fetchImpl),
      deadline(),
    );
    expect(
      seen.filter((request) => request.url.endsWith('/create')),
    ).toHaveLength(2);
  });

  it('does not reuse a reservation about to expire', async () => {
    const { fetchImpl, seen } = homeserver({
      create: () =>
        json({ content_uri: MXC, unused_expires_at: Date.now() + 60_000 }),
    });
    const ctx = ctxWith();
    await reservePublicDocument(ctx, DOCUMENT, deps(fetchImpl), deadline());
    await reservePublicDocument(ctx, DOCUMENT, deps(fetchImpl), deadline());
    expect(
      seen.filter((request) => request.url.endsWith('/create')),
    ).toHaveLength(2);
  });

  it('uploads at once on a homeserver without asynchronous uploads, leaving nothing to publish', async () => {
    for (const unsupported of [
      () =>
        json({ errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }, 404),
      () =>
        json({ errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }, 400),
      () => new Response('Method Not Allowed', { status: 405 }),
    ]) {
      const { fetchImpl, seen } = homeserver({
        create: unsupported,
        upload: () => json({ content_uri: MXC }),
      });
      await expect(
        reservePublicDocument(ctxWith(), DOCUMENT, deps(fetchImpl), deadline()),
      ).resolves.toEqual({ ok: true, url: DOWNLOAD, pending: null });
      expect(seen[1]).toEqual({
        url: `${HOMESERVER}/_matrix/media/v3/upload?filename=profile.json`,
        method: 'POST',
        authorization: 'Bearer device-token',
        contentType: 'application/ld+json',
        body: DOCUMENT.text,
      });
    }
  });

  it('asks once for fresh credentials when the homeserver rejects the token', async () => {
    const botCredentials = credentials();
    const { fetchImpl, seen } = homeserver({
      create: (n) =>
        n === 1
          ? json({ errcode: 'M_UNKNOWN_TOKEN', soft_logout: false }, 401)
          : RESERVED(),
    });
    await expect(
      reservePublicDocument(
        ctxWith(botCredentials),
        DOCUMENT,
        deps(fetchImpl),
        deadline(),
      ),
    ).resolves.toMatchObject({ ok: true, url: DOWNLOAD });
    expect(botCredentials).toHaveBeenLastCalledWith({
      rejected: 'device-token',
    });
    expect(seen.map((request) => request.authorization)).toEqual([
      'Bearer device-token',
      'Bearer fresh-token',
    ]);
  });

  it('refuses, to be tried again, when the fresh token is rejected too', async () => {
    const { fetchImpl, seen } = homeserver({
      create: () => json({ errcode: 'M_UNKNOWN_TOKEN' }, 401),
    });
    await expect(
      reservePublicDocument(ctxWith(), DOCUMENT, deps(fetchImpl), deadline()),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      message:
        'The homeserver refused reserving the document (HTTP 401 M_UNKNOWN_TOKEN); try again in a moment.',
    });
    expect(seen).toHaveLength(2);
  });

  it('refuses when the plugin device cannot be had: an error, or no answer in time', async () => {
    const { fetchImpl, seen } = homeserver({ create: RESERVED });
    await expect(
      reservePublicDocument(
        ctxWith(async () => {
          throw new Error('gateway unreachable');
        }),
        DOCUMENT,
        deps(fetchImpl),
        deadline(),
      ),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      message:
        "The oracle's Matrix device is unavailable (gateway unreachable); try again in a moment.",
    });
    await expect(
      reservePublicDocument(
        ctxWith(() => new Promise(() => undefined)),
        DOCUMENT,
        deps(fetchImpl),
        deadline(),
      ),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      message:
        "The oracle's Matrix device did not answer in time; try again in a moment.",
    });
    expect(seen).toEqual([]);
  });

  it('ends a request the homeserver never answers at its time bound', async () => {
    const { fetchImpl } = homeserver({ create: (_n, init) => HANG(init) });
    await expect(
      reservePublicDocument(ctxWith(), DOCUMENT, deps(fetchImpl), deadline()),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      message: 'The homeserver did not answer in time; try again in a moment.',
    });
  });

  it('starts nothing once the time budget is spent', async () => {
    const { fetchImpl, seen } = homeserver({ create: RESERVED });
    await expect(
      reservePublicDocument(ctxWith(), DOCUMENT, deps(fetchImpl), Date.now()),
    ).resolves.toMatchObject({ ok: false, retryable: true });
    expect(seen).toEqual([]);
  });

  it('rethrows the turn’s abort', async () => {
    const controller = new AbortController();
    const { fetchImpl } = homeserver({
      create: (_n, init) => {
        controller.abort(new Error('turn ended'));
        return HANG(init);
      },
    });
    await expect(
      reservePublicDocument(
        ctxWith(credentials(), { abortSignal: controller.signal }),
        DOCUMENT,
        deps(fetchImpl),
        deadline(),
      ),
    ).rejects.toThrow('turn ended');
  });

  it.each([
    [
      'a server error',
      () => json({ errcode: 'M_UNKNOWN' }, 502),
      true,
      /HTTP 502 M_UNKNOWN\); try again/,
    ],
    [
      'rate limiting',
      () => json({ errcode: 'M_LIMIT_EXCEEDED' }, 429),
      true,
      /HTTP 429 M_LIMIT_EXCEEDED/,
    ],
    [
      'a refusal',
      () => json({ errcode: 'M_FORBIDDEN' }, 403),
      false,
      /HTTP 403 M_FORBIDDEN\)\.$/,
    ],
    [
      'no content URI',
      () => json({ content_uri: 'https://not-mxc.example/x' }),
      false,
      /without a valid content URI/,
    ],
    [
      'an answer that is not JSON',
      () => new Response('<html>'),
      false,
      /without a valid content URI/,
    ],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
      true,
      /could not be reached \(TypeError\)/,
    ],
  ])('refuses on %s', async (_case, create, retryable, message) => {
    const { fetchImpl } = homeserver({ create });
    await expect(
      reservePublicDocument(ctxWith(), DOCUMENT, deps(fetchImpl), deadline()),
    ).resolves.toEqual({
      ok: false,
      retryable,
      message: expect.stringMatching(message),
    });
  });
});

describe('publishPendingDocuments', () => {
  it('uploads the exact bytes to the reserved media id', async () => {
    const { fetchImpl, seen } = homeserver({ put: () => json({}) });
    await expect(
      publishPendingDocuments(
        ctxWith(),
        [PENDING],
        deps(fetchImpl),
        deadline(),
      ),
    ).resolves.toEqual({ ok: true });
    expect(seen).toEqual([
      {
        url: `${HOMESERVER}/_matrix/media/v3/upload/matrix.example/Reserved123?filename=profile.json`,
        method: 'PUT',
        authorization: 'Bearer device-token',
        contentType: 'application/ld+json',
        body: DOCUMENT.text,
      },
    ]);
    expect(documentProof(seen[0]?.body ?? '')).toBe(
      documentProof(DOCUMENT.text),
    );
  });

  it('counts a document already uploaded (409) as published', async () => {
    const { fetchImpl } = homeserver({
      put: () =>
        json(
          {
            errcode: 'M_CANNOT_OVERWRITE_MEDIA',
            error: 'Media ID already has content',
          },
          409,
        ),
    });
    await expect(
      publishPendingDocuments(
        ctxWith(),
        [PENDING],
        deps(fetchImpl),
        deadline(),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('retries once with fresh credentials after a 401', async () => {
    const botCredentials = credentials();
    const { fetchImpl, seen } = homeserver({
      put: (n) =>
        n === 1 ? json({ errcode: 'M_UNKNOWN_TOKEN' }, 401) : json({}),
    });
    await expect(
      publishPendingDocuments(
        ctxWith(botCredentials),
        [PENDING],
        deps(fetchImpl),
        deadline(),
      ),
    ).resolves.toEqual({ ok: true });
    expect(seen.map((request) => request.authorization)).toEqual([
      'Bearer device-token',
      'Bearer fresh-token',
    ]);
  });

  it.each([
    [
      'an expired reservation',
      () => json({ errcode: 'M_NOT_FOUND', error: 'Unknown media ID' }, 404),
      false,
      /reserved upload slot .* expired/,
    ],
    [
      'a server error',
      () => json({ errcode: 'M_UNKNOWN' }, 503),
      true,
      /HTTP 503/,
    ],
    [
      'a hang',
      (_n: number, init: RequestInit | undefined) => HANG(init),
      true,
      /did not answer in time/,
    ],
  ])('refuses on %s', async (_case, put, retryable, message) => {
    const { fetchImpl } = homeserver({ put });
    await expect(
      publishPendingDocuments(
        ctxWith(),
        [PENDING],
        deps(fetchImpl),
        deadline(),
      ),
    ).resolves.toEqual({
      ok: false,
      retryable,
      message: expect.stringMatching(message),
    });
  });
});

describe('ctx.matrix.botCredentials', () => {
  it('passes the rejected token on to the host, and nothing when there is none', async () => {
    const hostCredentials = credentials();
    const ctx = makeRuntimeContext(
      {},
      {
        ambient: {
          matrix: {
            ...createNoopAmbient().matrix,
            botCredentials: hostCredentials,
          },
        },
      },
    );
    await ctx.matrix.botCredentials();
    expect(hostCredentials).toHaveBeenLastCalledWith(undefined);
    await expect(
      ctx.matrix.botCredentials({ rejected: 'device-token' }),
    ).resolves.toMatchObject({ accessToken: 'fresh-token' });
    expect(hostCredentials).toHaveBeenLastCalledWith({
      rejected: 'device-token',
    });
  });
});
