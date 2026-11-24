/**
 * `POST /channels/media`: a web binding's media read is verified like a
 * history read (the same `ixo:channel/history` grant, for this exact media
 * query), limited per binding, checked with the Auth Hub on EVERY read, and
 * answered from the person's own object; every refusal is `{ error }`.
 */
import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeInvocation,
  type Capability,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearChannelBindingCache } from '../channels/auth';
import { channelRequestHash, historyQueryHash } from '../channels/contract';
import {
  channelMediaResponse,
  mediaQueryHash,
  type ChannelMediaInput,
  type ChannelMediaOutcome,
} from '../channels/media';
import { createShell } from './app';

const USER_DID = 'did:ixo:ixo1webmediauser';
const BYTES = new TextEncoder().encode('%PDF-1.7 the whole file');

const FILE_QUERY = {
  kind: 'file' as const,
  sessionId: '$thread:hs.test',
  ref: 'channel:0123456789abcdef',
};

const input: ChannelMediaInput = {
  provider: 'web',
  bindingId: 'chb_webmedia',
  bindingRevision: 2,
  requestId: 'web-media:5b0c4f2e-0000-4000-8000-000000000001',
  query: FILE_QUERY,
};

async function signedMedia(
  body: ChannelMediaInput = input,
  opts: {
    can?: Capability['can'];
    queryHash?: string;
    bindingRevision?: number;
    /** Sign this body text instead (another route's body with the same request id). */
    raw?: string;
  } = {},
) {
  const user = await generateKeypair();
  const service = await generateKeypair();
  const oracle = await generateKeypair();
  const capability: Capability = {
    can: opts.can ?? 'ixo:channel/media',
    with: `ixo:channel:${body.bindingId}`,
    nb: {
      provider: body.provider,
      bindingRevision: opts.bindingRevision ?? body.bindingRevision,
      oracleDid: oracle.did,
      queryHash: opts.queryHash ?? (await mediaQueryHash(body.query)),
      deviceId: `dev_${'A'.repeat(43)}`,
    },
  };
  const grant = await createDelegation({
    issuer: user.signer.withDID(USER_DID),
    audience: service.did,
    capabilities: [capability],
    expiration: Math.floor(Date.now() / 1000) + 60,
  });
  const raw = opts.raw ?? JSON.stringify(body);
  const blocksync = `https://blocksync-${crypto.randomUUID()}.test/graphql`;
  const token = await serializeInvocation(
    await createInvocation({
      issuer: service.signer,
      audience: oracle.did,
      capability,
      proofs: [grant],
      expiration: Math.floor(Date.now() / 1000) + 60,
      facts: [
        {
          requestId: body.requestId,
          requestHash: await channelRequestHash(raw),
        },
      ],
    }),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) !== blocksync)
      throw new Error(`unexpected fetch ${String(url)}`);
    return Response.json({
      data: {
        iids: {
          nodes: [
            {
              id: USER_DID,
              verificationMethod: [
                {
                  id: `${USER_DID}#key-1`,
                  type: 'Ed25519VerificationKey2020',
                  controller: USER_DID,
                  publicKeyMultibase: user.did.slice('did:key:'.length),
                },
              ],
            },
          ],
        },
      },
    });
  });
  return {
    raw,
    headers: {
      authorization: `Bearer ${token}`,
      'x-auth-type': 'ucan',
      'content-type': 'application/json',
    },
    oracleDid: oracle.did,
    serviceDid: service.did,
    blocksync,
  };
}

/**
 * A file outcome of `chunks` chunks of 1 KiB, produced on demand; after
 * `stallAfter` chunks it produces nothing more. `cancelled()` says whether
 * its body was cancelled.
 */
function fileOutcome(opts: { chunks: number; stallAfter?: number }) {
  let cancelled = false;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (opts.stallAfter !== undefined && sent >= opts.stallAfter)
          return new Promise<void>(() => undefined);
        sent += 1;
        controller.enqueue(new Uint8Array(1024).fill(sent & 0xff));
        if (sent === opts.chunks) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const outcome: ChannelMediaOutcome = {
    ok: true,
    kind: 'file',
    body,
    size: opts.chunks * 1024,
    mime: 'application/pdf',
    name: 'cv.pdf',
    sha256: 'ab'.repeat(32),
  };
  return { outcome, cancelled: () => cancelled, sent: () => sent };
}

function environment(
  signed: Awaited<ReturnType<typeof signedMedia>>,
  options: {
    limited?: boolean;
    hub?: () => Response;
    media?: () => Promise<ChannelMediaOutcome>;
  } = {},
) {
  const hubBodies: unknown[] = [];
  const limiterKeys: string[] = [];
  const reads: { userDid: string; query: unknown }[] = [];
  const env = {
    ORACLE_DID: signed.oracleDid,
    BLOCKSYNC_GRAPHQL_URL: signed.blocksync,
    CHANNEL_SERVICE_DID: signed.serviceDid,
    AUTH_HUB_CHANNEL_SERVICE_KEY: 'k',
    AUTH_HUB: {
      fetch: async (request: Request) => {
        const body: unknown = await request.json();
        hubBodies.push({ path: new URL(request.url).pathname, body });
        return options.hub?.() ?? Response.json({ active: true });
      },
    },
    RATE_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        limiterKeys.push(key);
        return { success: !options.limited };
      },
    },
    USER_ORACLE: {
      idFromName: (name: string) => name,
      get: () => ({
        channelMedia: async (
          identity: { userDid: string },
          body: ChannelMediaInput,
        ) => {
          reads.push({ userDid: identity.userDid, query: body.query });
          return options.media
            ? options.media()
            : {
                ok: true,
                kind: 'file',
                body: new Response(BYTES).body!,
                size: BYTES.byteLength,
                mime: 'application/pdf',
                name: 'cv é.pdf',
                sha256: 'ab'.repeat(32),
              };
        },
      }),
    },
  };
  return { env, hubBodies, limiterKeys, reads };
}

const send = (
  signed: { raw: string; headers: Record<string, string> },
  env: ReturnType<typeof environment>['env'] & {
    OPS_ANALYTICS?: { writeDataPoint(point: { blobs?: string[] }): void };
  },
  shell = createShell(),
) =>
  shell.request(
    '/channels/media',
    { method: 'POST', headers: signed.headers, body: signed.raw },
    env,
  );

afterEach(() => {
  vi.restoreAllMocks();
  clearChannelBindingCache();
});

describe('POST /channels/media', () => {
  it("streams the person's file after checking the web binding with the Auth Hub on every read", async () => {
    const signed = await signedMedia();
    const { env, hubBodies, limiterKeys, reads } = environment(signed);
    const shell = createShell();
    for (let i = 0; i < 2; i += 1) {
      const res = await send(signed, env, shell);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-length')).toBe(String(BYTES.byteLength));
      expect(res.headers.get('x-ixo-file-name')).toBe('cv%20%C3%A9.pdf');
      expect(res.headers.get('x-ixo-sha256')).toBe('ab'.repeat(32));
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    }
    const check = {
      path: '/api/internal/channels/validate-binding',
      body: {
        bindingId: input.bindingId,
        bindingRevision: input.bindingRevision,
        userDid: USER_DID,
        provider: 'web',
        oracleDid: signed.oracleDid,
      },
    };
    expect(hubBodies).toEqual([check, check]);
    expect(limiterKeys).toEqual([
      `${signed.oracleDid}|channel-media|${input.bindingId}`,
      `${signed.oracleDid}|channel-media|${input.bindingId}`,
    ]);
    expect(reads).toEqual([
      { userDid: USER_DID, query: input.query },
      { userDid: USER_DID, query: input.query },
    ]);
  });

  it("answers a document as the object's JSON envelope", async () => {
    const body: ChannelMediaInput = {
      ...input,
      query: {
        kind: 'artifact',
        sessionId: '$thread:hs.test',
        artifactId: 'a'.repeat(32),
      },
    };
    const envelope = {
      v: 1,
      title: 'Plan',
      mime: 'text/markdown',
      content: '# Plan',
      createdAt: '2025-12-01T00:00:00.000Z',
    };
    const signed = await signedMedia(body);
    const { env } = environment(signed, {
      media: async () => ({
        ok: true,
        kind: 'artifact',
        json: JSON.stringify(envelope),
      }),
    });
    const res = await send(signed, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(envelope);
  });

  it('refuses a history grant for a media read, even naming this query, before the Auth Hub or the object', async () => {
    for (const queryHash of [
      await mediaQueryHash(FILE_QUERY),
      await historyQueryHash({ limit: 20 }),
    ]) {
      const signed = await signedMedia(input, {
        can: 'ixo:channel/history',
        queryHash,
      });
      const { env, hubBodies, reads, limiterKeys } = environment(signed);
      const res = await send(signed, env);
      expect([res.status, await res.json()]).toEqual([
        401,
        { error: 'unauthorized' },
      ]);
      expect(hubBodies).toEqual([]);
      expect(reads).toEqual([]);
      expect(limiterKeys).toEqual([]);
    }
  });

  it('refuses a media grant on the history route', async () => {
    const page = {
      provider: 'web',
      bindingId: input.bindingId,
      bindingRevision: input.bindingRevision,
      requestId: input.requestId,
      query: { limit: 20 },
    };
    // Signed over the page body itself: only the capability differs.
    const signed = await signedMedia(input, {
      queryHash: await historyQueryHash(page.query),
      raw: JSON.stringify(page),
    });
    const { env } = environment(signed);
    const res = await createShell().request(
      '/channels/history',
      { method: 'POST', headers: signed.headers, body: signed.raw },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('answers every auth and binding refusal as { error }', async () => {
    const cases: {
      sign: () => ReturnType<typeof signedMedia>;
      unsigned?: boolean;
      hub?: () => Response;
      expected: [number, string];
    }[] = [
      {
        sign: () => signedMedia(),
        unsigned: true,
        expected: [401, 'unauthorized'],
      },
      {
        sign: () => signedMedia(input, { bindingRevision: 1 }),
        expected: [403, 'revision_mismatch'],
      },
      {
        sign: async () =>
          signedMedia(input, {
            queryHash: await mediaQueryHash({
              ...FILE_QUERY,
              ref: 'channel:fedcba9876543210',
            }),
          }),
        expected: [403, 'scope_mismatch'],
      },
      {
        sign: () => signedMedia(),
        hub: () => Response.json({ active: false }),
        expected: [403, 'binding_inactive'],
      },
      {
        sign: () => signedMedia(),
        hub: () => new Response('down', { status: 500 }),
        expected: [503, 'binding_check_unavailable'],
      },
    ];
    for (const test of cases) {
      const signed = await test.sign();
      const { env, reads } = environment(signed, {
        ...(test.hub ? { hub: test.hub } : {}),
      });
      const res = await send(
        {
          raw: signed.raw,
          headers: test.unsigned
            ? { 'content-type': 'application/json' }
            : signed.headers,
        },
        env,
      );
      expect(res.headers.get('retry-after')).toBe(
        test.expected[0] === 503 ? '5' : null,
      );
      expect([res.status, await res.json()]).toEqual([
        test.expected[0],
        { error: test.expected[1] },
      ]);
      expect(reads).toEqual([]);
    }
  });

  it('answers 429 rate_limited with Retry-After 60 over the per-binding limit, without the Auth Hub or the object', async () => {
    const signed = await signedMedia();
    const { env, hubBodies, reads } = environment(signed, { limited: true });
    const res = await send(signed, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(hubBodies).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("passes the object's refusals through, busy with its Retry-After", async () => {
    for (const [refusal, retryAfter] of [
      [{ ok: false, status: 429, error: 'busy', retryAfter: 2 }, '2'],
      [{ ok: false, status: 404, error: 'not_found' }, null],
      [{ ok: false, status: 502, error: 'upstream' }, null],
    ] as const) {
      const signed = await signedMedia();
      const { env } = environment(signed, { media: async () => refusal });
      const res = await send(signed, env);
      expect(res.status).toBe(refusal.status);
      expect(res.headers.get('retry-after')).toBe(retryAfter);
      expect(await res.json()).toEqual({ error: refusal.error });
    }
  });

  it('refuses a bad body and an oversized body before anything else', async () => {
    const signed = await signedMedia();
    const { env, hubBodies, reads, limiterKeys } = environment(signed);
    const bad = await send(
      {
        raw: JSON.stringify({
          ...input,
          query: { kind: 'file', sessionId: 's', ref: 'mxc://hs/x' },
        }),
        headers: signed.headers,
      },
      env,
    );
    expect([bad.status, await bad.json()]).toEqual([
      400,
      { error: 'invalid_request' },
    ]);
    const notJson = await send({ raw: '{', headers: signed.headers }, env);
    expect([notJson.status, await notJson.json()]).toEqual([
      400,
      { error: 'invalid_request' },
    ]);
    const big = await send(
      {
        raw: JSON.stringify({ ...input, pad: 'x'.repeat(5000) }),
        headers: signed.headers,
      },
      env,
    );
    expect([big.status, await big.json()]).toEqual([
      413,
      { error: 'request_too_large' },
    ]);
    expect(hubBodies).toEqual([]);
    expect(reads).toEqual([]);
    expect(limiterKeys).toEqual([]);
  });

  it('writes one media point with the kind asked for, and logs a refusal without anything personal', async () => {
    const points: { blobs?: string[] }[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signed = await signedMedia();
    const { env } = environment(signed, {
      media: async () => ({ ok: false, status: 404, error: 'not_found' }),
    });
    const res = await send(signed, {
      ...env,
      OPS_ANALYTICS: {
        writeDataPoint: (point: { blobs?: string[] }) =>
          void points.push(point),
      },
    });
    expect(res.status).toBe(404);
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs).toEqual([
      'http',
      'POST /channels/media',
      'client_error',
      '404',
      'not_found',
      '',
      'gateway',
      'web',
      'file',
    ]);
    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[channel-request] '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"channels.media"');
    expect(lines[0]).toContain('"kind":"file"');
    for (const secret of [
      FILE_QUERY.sessionId,
      'channel:0123',
      input.bindingId,
      USER_DID,
      input.requestId,
    ])
      expect(lines[0]).not.toContain(secret);
  });
});

describe('channel media response', () => {
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
  };

  it("cancels the object's body when the caller cancels the HTTP body, at the next chunk (through FixedLengthStream)", async () => {
    const file = fileOutcome({ chunks: 100 });
    const response = channelMediaResponse(file.outcome);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel('client went away');
    await settle(file.cancelled);
    expect(file.cancelled()).toBe(true);
    // Far from drained: the pipe stopped at the cancel.
    expect(file.sent()).toBeLessThan(20);
  });

  it('does not notice a cancel while the object produces nothing (the read deadline ends that read)', async () => {
    const file = fileOutcome({ chunks: 100, stallAfter: 1 });
    const response = channelMediaResponse(file.outcome);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel('client went away');
    await settle(file.cancelled);
    // A limitation of the pipe into `FixedLengthStream`: the cancel reaches
    // the object's body only with the next chunk written. A stalled read is
    // ended by the object's 60 s deadline (media.test.ts), which frees the
    // slot and cancels the homeserver read.
    expect(file.cancelled()).toBe(false);
  });
});
