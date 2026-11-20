/**
 * `POST /channels/history`: a web binding's history read is verified like a
 * turn, limited per binding, checked with the Auth Hub on EVERY read (never
 * cached), and answered from the person's own object.
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
import {
  channelRequestHash,
  historyQueryHash,
  type ChannelHistoryInput,
} from '../channels/contract';
import { encodeHistoryCursor } from '../channels/history';
import { createShell } from './app';

const USER_DID = 'did:ixo:ixo1webhistoryuser';

const input: ChannelHistoryInput = {
  provider: 'web',
  bindingId: 'chb_webroute',
  bindingRevision: 2,
  requestId: 'web-history:5b0c4f2e-0000-4000-8000-000000000001',
  query: { limit: 20 },
};

async function signedHistory(body: ChannelHistoryInput = input) {
  const user = await generateKeypair();
  const service = await generateKeypair();
  const oracle = await generateKeypair();
  const capability: Capability = {
    can: 'ixo:channel/history',
    with: `ixo:channel:${body.bindingId}`,
    nb: {
      provider: body.provider,
      bindingRevision: body.bindingRevision,
      oracleDid: oracle.did,
      queryHash: await historyQueryHash(body.query),
      deviceId: `dev_${'A'.repeat(43)}`,
    },
  };
  const grant = await createDelegation({
    issuer: user.signer.withDID(USER_DID),
    audience: service.did,
    capabilities: [capability],
    expiration: Math.floor(Date.now() / 1000) + 60,
  });
  const raw = JSON.stringify(body);
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

const PAGE = {
  items: [],
  prevCursor: null,
  nextCursor: null,
  hasOlder: false,
  hasNewer: false,
};

function environment(
  signed: Awaited<ReturnType<typeof signedHistory>>,
  options: {
    limited?: boolean;
    hub?: () => Response;
    /** What the object answers (default: an empty page). */
    history?: () => Promise<unknown>;
  } = {},
) {
  const hubBodies: unknown[] = [];
  const limiterKeys: string[] = [];
  const reads: { userDid: string; bindingId: string }[] = [];
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
        channelHistory: async (
          identity: { userDid: string },
          body: ChannelHistoryInput,
        ) => {
          reads.push({ userDid: identity.userDid, bindingId: body.bindingId });
          return options.history
            ? options.history()
            : { ok: true, json: JSON.stringify(PAGE) };
        },
      }),
    },
  };
  return { env, hubBodies, limiterKeys, reads };
}

const send = (
  signed: { raw: string; headers: Record<string, string> },
  env: ReturnType<typeof environment>['env'],
  shell = createShell(),
) =>
  shell.request(
    '/channels/history',
    { method: 'POST', headers: signed.headers, body: signed.raw },
    env,
  );

afterEach(() => {
  vi.restoreAllMocks();
  clearChannelBindingCache();
});

describe('POST /channels/history', () => {
  it("answers the person's own page after checking the web binding with the Auth Hub on every read", async () => {
    const signed = await signedHistory();
    const { env, hubBodies, limiterKeys, reads } = environment(signed);
    const shell = createShell();
    for (let i = 0; i < 2; i += 1) {
      const res = await send(signed, env, shell);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual(PAGE);
    }
    // Never cached: two reads, two checks, each for the web binding.
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
      `${signed.oracleDid}|channel-history|${input.bindingId}`,
      `${signed.oracleDid}|channel-history|${input.bindingId}`,
    ]);
    expect(reads).toEqual([
      { userDid: USER_DID, bindingId: input.bindingId },
      { userDid: USER_DID, bindingId: input.bindingId },
    ]);
  });

  it('refuses an inactive binding (signed out everywhere, or disconnected) before reading', async () => {
    const signed = await signedHistory();
    const { env, reads } = environment(signed, {
      hub: () => Response.json({ active: false }),
    });
    const res = await send(signed, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'binding_inactive' });
    expect(reads).toEqual([]);
  });

  it('answers 429 over the per-binding limit without the Auth Hub or the object', async () => {
    const signed = await signedHistory();
    const { env, hubBodies, reads } = environment(signed, { limited: true });
    const res = await send(signed, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited' });
    expect(hubBodies).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('refuses no invocation, a bad body and an oversized body before anything else', async () => {
    const signed = await signedHistory();
    const { env, hubBodies, reads, limiterKeys } = environment(signed);
    const unsigned = await send(
      { raw: signed.raw, headers: { 'content-type': 'application/json' } },
      env,
    );
    expect(unsigned.status).toBe(401);
    const bad = await send(
      {
        raw: JSON.stringify({ ...input, query: { limit: 500 } }),
        headers: signed.headers,
      },
      env,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_request' });
    const big = await send(
      {
        raw: JSON.stringify({ ...input, pad: 'x'.repeat(5000) }),
        headers: signed.headers,
      },
      env,
    );
    expect(big.status).toBe(413);
    expect(hubBodies).toEqual([]);
    expect(reads).toEqual([]);
    expect(limiterKeys).toEqual([]);
  });

  it("passes the object's refusal through (a cursor of another chat)", async () => {
    const signed = await signedHistory();
    const { env } = environment(signed, {
      history: async () => ({
        ok: false,
        status: 400,
        code: 'invalid_cursor',
        message: 'The history cursor names no message of this chat',
      }),
    });
    const res = await send(signed, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'invalid_cursor',
      message: 'The history cursor names no message of this chat',
    });
  });
});

describe('POST /channels/control for a web binding', () => {
  const body = (provider: string, command: Record<string, unknown>) =>
    JSON.stringify({
      provider,
      bindingId: 'chb_webroute',
      bindingRevision: 2,
      requestId: 'web-control-1',
      cancelRequestIds: [],
      command,
    });

  it('refuses every control with 403 control_not_supported, before the Auth Hub or the object', async () => {
    const signed = await signedHistory();
    const { env, hubBodies, limiterKeys, reads } = environment(signed);
    for (const command of [
      { kind: 'stop' },
      { kind: 'status' },
      { kind: 'new' },
      { kind: 'resume', sessionId: '$old' },
      { kind: 'topics' },
      { kind: 'rename', title: 'Mine' },
    ]) {
      const res = await createShell().request(
        '/channels/control',
        {
          method: 'POST',
          headers: signed.headers,
          body: body('web', command),
        },
        env,
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'control_not_supported' });
    }
    expect(hubBodies).toEqual([]);
    expect(limiterKeys).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('leaves a WhatsApp or Telegram control to the usual checks (an unsigned one is 401)', async () => {
    const signed = await signedHistory();
    const { env } = environment(signed);
    for (const provider of ['whatsapp', 'telegram']) {
      const res = await createShell().request(
        '/channels/control',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body(provider, { kind: 'topics' }),
        },
        env,
      );
      expect(res.status).toBe(401);
    }
  });
});

describe('POST /channels/history cursor length', () => {
  it('refuses a cursor over 512 characters as 400 invalid_request', async () => {
    const signed = await signedHistory();
    const { env, reads } = environment(signed);
    const res = await send(
      {
        raw: JSON.stringify({
          ...input,
          query: { limit: 20, before: `c1.${'a'.repeat(510)}` },
        }),
        headers: signed.headers,
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    expect(reads).toEqual([]);
  });
});

describe('channel request metrics on the web routes', () => {
  type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };
  const sink = () => {
    const points: Point[] = [];
    return {
      points,
      OPS_ANALYTICS: {
        writeDataPoint: (point: Point) => void points.push(point),
      },
    };
  };
  const cursor = encodeHistoryCursor({
    sessionId: '$session-secret',
    messageId: '$message-secret',
  });

  it('writes one history point: the channel, the page size and the plans it carried', async () => {
    const signed = await signedHistory();
    const { env } = environment(signed, {
      history: async () => ({
        ok: true,
        json: JSON.stringify(PAGE),
        items: 12,
        plans: 3,
      }),
    });
    const { points, OPS_ANALYTICS } = sink();
    const withSink = { ...env, OPS_ANALYTICS };
    const res = await send(signed, withSink);
    expect(res.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0]!.indexes).toEqual(['oracle-runtime']);
    expect(points[0]!.blobs).toEqual([
      'http',
      'POST /channels/history',
      'ok',
      '200',
      '',
      '',
      'gateway',
      'web',
      '',
    ]);
    expect(points[0]!.doubles!.slice(1, 5)).toEqual([1, 12, 3, 20]);
  });

  it('counts each refusal by its code and logs one line for it, with nothing personal in either', async () => {
    const signed = await signedHistory({
      ...input,
      query: { limit: 5, before: cursor },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = environment(signed, {
      history: async () => ({
        ok: false,
        status: 400,
        code: 'invalid_cursor',
        message: 'The history cursor names no message of this chat',
      }),
    });
    const { points, OPS_ANALYTICS } = sink();
    const withSink = { ...env, OPS_ANALYTICS };
    expect((await send(signed, withSink)).status).toBe(400);
    const inactive = environment(signed, {
      hub: () => Response.json({ active: false }),
    });
    const inactiveWithSink = { ...inactive.env, OPS_ANALYTICS };
    expect((await send(signed, inactiveWithSink)).status).toBe(403);
    expect(points.map((p) => p.blobs!.slice(2, 5))).toEqual([
      ['client_error', '400', 'invalid_cursor'],
      ['client_error', '403', 'binding_inactive'],
    ]);
    expect(points.map((p) => p.doubles![4])).toEqual([5, 5]);
    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[channel-request] '));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!.slice(18))).toMatchObject({
      event: 'channels.history',
      status: 400,
      code: 'invalid_cursor',
      provider: 'web',
      requestId: input.requestId,
    });
    const secrets = [
      USER_DID,
      input.bindingId,
      signed.oracleDid,
      signed.serviceDid,
      cursor,
      '$session-secret',
      '$message-secret',
      signed.headers.authorization.slice(7, 40),
      `dev_${'A'.repeat(43)}`,
    ];
    const text = JSON.stringify(points) + lines.join('\n');
    expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);
    // The request id is a random id the gateway made: in the log, never a point.
    expect(JSON.stringify(points)).not.toContain(input.requestId);
  });

  it('counts a web control refusal as control_not_supported on the web channel', async () => {
    const signed = await signedHistory();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = environment(signed);
    const { points, OPS_ANALYTICS } = sink();
    const res = await createShell().request(
      '/channels/control',
      {
        method: 'POST',
        headers: signed.headers,
        body: JSON.stringify({
          provider: 'web',
          bindingId: input.bindingId,
          bindingRevision: 2,
          requestId: 'web-control-1',
          cancelRequestIds: [],
          command: { kind: 'resume', sessionId: '$old-session-secret' },
        }),
      },
      { ...env, OPS_ANALYTICS },
    );
    expect(res.status).toBe(403);
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs!.slice(1, 9)).toEqual([
      'POST /channels/control',
      'client_error',
      '403',
      'control_not_supported',
      '',
      'gateway',
      'web',
      '',
    ]);
    expect(JSON.stringify(points)).not.toContain('$old-session-secret');
    expect(JSON.stringify(points)).not.toContain(input.bindingId);
  });

  it('writes nothing and answers as before without the binding', async () => {
    const signed = await signedHistory();
    const { env } = environment(signed);
    const res = await send(signed, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PAGE);
  });
});
