/**
 * `POST /channels/turn`: the caller is limited as soon as the user-rooted
 * invocation proves who it is, before the Auth Hub binding check — a flood
 * or a tight poll must not cost an Auth Hub round trip per request.
 */
import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeInvocation,
  type Capability,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertActiveChannelBindingCached,
  CHANNEL_BINDING_CACHE_MAX_ENTRIES,
  CHANNEL_BINDING_CACHE_TTL_MS,
  clearChannelBindingCache,
} from '../channels/auth';
import {
  channelRequestHash,
  type ChannelTurnInput,
  type ChannelControlInput,
} from '../channels/contract';
import { signOutcomeRequest } from '@ixo/action-protocol';
import {
  HUB_DID_REFRESH_MIN_MS,
  resetHubDidCache,
} from '../hub-actions/outcome-signature';
import { callbackAudience, createShell, rateLimitKey } from './app';

const USER_DID = 'did:ixo:ixo1channeluser';

const input: ChannelTurnInput = {
  provider: 'whatsapp',
  bindingId: 'chb_route',
  bindingRevision: 1,
  requestId: 'wa:route1',
  remoteMessageRef: `hmac:${'b'.repeat(64)}`,
  message: 'Hello',
  context: { kind: 'companion' },
};

/** A channel turn signed by the channel service under the user's direct grant. */
async function signedTurn(
  body: ChannelTurnInput | ChannelControlInput = input,
) {
  const user = await generateKeypair();
  const service = await generateKeypair();
  const oracle = await generateKeypair();
  const signer = user.signer.withDID(USER_DID);
  const capability: Capability = {
    can: 'ixo:channel/invoke',
    with: `ixo:channel:${body.bindingId}`,
    nb: {
      provider: body.provider,
      bindingRevision: body.bindingRevision,
      oracleDid: oracle.did,
    },
  };
  const grant = await createDelegation({
    issuer: signer,
    audience: service.did,
    capabilities: [capability],
    expiration: Math.floor(Date.now() / 1000) + 300,
  });
  const raw = JSON.stringify(body);
  // The did:ixo resolver and its key cache are shared per Blocksync URL per
  // isolate, so each turn's freshly generated user key gets its own URL.
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
  // Blocksync serves the user's DID document (its Ed25519 key).
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

type ChannelTurnStub = (identity: { userDid: string }) => Promise<unknown>;

function environment(
  turn: Awaited<ReturnType<typeof signedTurn>>,
  limited: boolean,
  channelTurn?: ChannelTurnStub,
  options: {
    /** What the object's poll path answers (null = no run yet). */
    channelPoll?: () => Promise<unknown>;
    /** The Auth Hub's answer (default: `{active: true}`). */
    hub?: () => Response;
  } = {},
) {
  const authHubCalls: string[] = [];
  const limiterKeys: string[] = [];
  const turns: string[] = [];
  const polls: string[] = [];
  const env = {
    ORACLE_DID: turn.oracleDid,
    BLOCKSYNC_GRAPHQL_URL: turn.blocksync,
    CHANNEL_SERVICE_DID: turn.serviceDid,
    AUTH_HUB_CHANNEL_SERVICE_KEY: 'k',
    AUTH_HUB: {
      fetch: async (request: Request) => {
        authHubCalls.push(new URL(request.url).pathname);
        return options.hub?.() ?? Response.json({ active: true });
      },
    },
    RATE_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        limiterKeys.push(key);
        return { success: !limited };
      },
    },
    USER_ORACLE: {
      idFromName: (name: string) => name,
      get: () => ({
        channelControl: async (
          identity: { userDid: string },
          command: ChannelControlInput,
        ) => {
          turns.push(identity.userDid);
          return {
            ok: true,
            result: {
              requestId: command.requestId,
              sessionId: '$owned',
              command: command.command.kind,
            },
          };
        },
        channelPoll: async (identity: { userDid: string }) => {
          polls.push(identity.userDid);
          return options.channelPoll ? options.channelPoll() : null;
        },
        channelTurn: async (identity: { userDid: string }) => {
          turns.push(identity.userDid);
          if (channelTurn) return channelTurn(identity);
          return {
            ok: true,
            result: { status: 'completed', requestId: input.requestId },
          };
        },
      }),
    },
  };
  return { env, authHubCalls, limiterKeys, turns, polls };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearChannelBindingCache();
});

describe('POST /api/internal/actions/outcomes', () => {
  const ORACLE_ORIGIN = 'https://oracle.test';
  const HUB_DID = 'did:web:hub.test';
  const KEY_ID = `${HUB_DID}#key-0`;
  const id = 'D'.repeat(32);
  const outcome = {
    version: 'ixo.auth-outcome/1',
    eventId: 'event-shell',
    ownerDid: USER_DID,
    reference: {
      version: 'ixo.auth-action/1',
      id,
      accountId: 'account-shell',
      bindingId: 'chb_shell',
      bindingRevision: 1,
      revision: 1,
      digest: 'a'.repeat(64),
      url: `https://hub.test/a/${id}`,
      expiresAt: 1999999999999,
      title: 'Review form',
    },
    authorizedRevision: 1,
    authorizedDigest: 'a'.repeat(64),
    sequence: 1,
    status: 'declined',
    receipt: null,
    occurredAt: 1770000000001,
  };
  const rawBody = JSON.stringify(outcome);

  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function multibase(raw: Uint8Array): string {
    const bytes = Uint8Array.from([0xed, 0x01, ...raw]);
    let value = 0n;
    for (const byte of bytes) value = value * 256n + BigInt(byte);
    let text = '';
    while (value > 0n) {
      text = BASE58[Number(value % 58n)] + text;
      value /= 58n;
    }
    return `z${text}`;
  }
  async function hubKey() {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]);
    if (!('privateKey' in pair)) throw new Error('Ed25519 key pair expected');
    const exported = await crypto.subtle.exportKey('raw', pair.publicKey);
    if (!(exported instanceof ArrayBuffer)) throw new Error('raw key expected');
    const raw = new Uint8Array(exported);
    return { privateKey: pair.privateKey, publicKeyMultibase: multibase(raw) };
  }
  function didDocument(publicKeyMultibase: string, did = HUB_DID) {
    return {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      verificationMethod: [
        {
          id: `${did}#key-0`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase,
        },
      ],
    };
  }

  async function routeEnv(document: () => unknown) {
    const turn = await signedTurn();
    const base = environment(turn, false).env;
    const record = vi.fn(async () => undefined);
    const hubCalls: string[] = [];
    const env = {
      ...base,
      HUB_ACTIONS_ENABLED: 'true',
      AUTH_HUB_URL: 'https://hub.test',
      AUTH_HUB_CHANNEL_SERVICE_KEY: 'oracle-secret',
      AUTH_HUB: {
        fetch: async (request: Request) => {
          hubCalls.push(new URL(request.url).pathname);
          return Response.json(document());
        },
      },
      USER_ORACLE: {
        idFromName: (name: string) => name,
        get: () => ({ recordHubActionOutcome: record }),
      },
    };
    return { env, record, hubCalls };
  }

  const post = (
    env: unknown,
    headers: Record<string, string>,
    body = rawBody,
    url = `${ORACLE_ORIGIN}/api/internal/actions/outcomes`,
  ) =>
    createShell().request(
      url,
      { method: 'POST', headers, body },
      // The shell's env type is the Worker's; the test env carries the
      // bindings this route reads.
      Object.assign({}, env),
    );

  afterEach(() => resetHubDidCache());

  it('accepts a callback the configured Hub signed for this oracle origin', async () => {
    const key = await hubKey();
    const { env, record, hubCalls } = await routeEnv(() =>
      didDocument(key.publicKeyMultibase),
    );
    const headers = await signOutcomeRequest({
      privateKey: key.privateKey,
      keyId: KEY_ID,
      audience: ORACLE_ORIGIN,
      rawBody,
    });
    // The transition header the Hub still sends is ignored, never required.
    const accepted = await post(env, {
      ...headers,
      'x-auth-hub-outcome-key': 'legacy-key',
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      accepted: true,
      eventId: outcome.eventId,
      accountId: outcome.reference.accountId,
      actionId: id,
      revision: outcome.authorizedRevision,
      digest: outcome.authorizedDigest,
      sequence: outcome.sequence,
    });
    expect(record).toHaveBeenCalledWith(outcome);
    expect(hubCalls).toEqual(['/.well-known/did.json']);
    // The DID document is cached: a second callback reads it from memory.
    expect((await post(env, headers)).status).toBe(200);
    expect(hubCalls).toHaveLength(1);
  });

  it('refuses unsigned, re-targeted, tampered, stale and foreign-key callbacks', async () => {
    const key = await hubKey();
    const other = await hubKey();
    const { env, record } = await routeEnv(() =>
      didDocument(key.publicKeyMultibase),
    );
    const sign = (fields: {
      privateKey?: CryptoKey;
      keyId?: string;
      audience?: string;
      timestamp?: number;
    }) =>
      signOutcomeRequest({
        privateKey: fields.privateKey ?? key.privateKey,
        keyId: fields.keyId ?? KEY_ID,
        audience: fields.audience ?? ORACLE_ORIGIN,
        rawBody,
        ...(fields.timestamp ? { timestamp: fields.timestamp } : {}),
      });
    // No signature; the old shared key alone is not enough.
    expect((await post(env, {})).status).toBe(401);
    expect(
      (await post(env, { 'x-auth-hub-outcome-key': 'x'.repeat(40) })).status,
    ).toBe(401);
    // Signed for another oracle.
    expect(
      (await post(env, await sign({ audience: 'https://other-oracle.test' })))
        .status,
    ).toBe(401);
    // Signed for this oracle but delivered to another origin it serves.
    expect(
      (
        await post(
          env,
          await sign({}),
          rawBody,
          'https://alias.test/api/internal/actions/outcomes',
        )
      ).status,
    ).toBe(401);
    // A body changed after signing.
    expect(
      (
        await post(
          env,
          await sign({}),
          JSON.stringify({ ...outcome, status: 'authorized' }),
        )
      ).status,
    ).toBe(401);
    // A key the Hub DID document does not hold, or another DID's key id.
    expect(
      (await post(env, await sign({ privateKey: other.privateKey }))).status,
    ).toBe(401);
    expect(
      (await post(env, await sign({ keyId: 'did:web:evil.test#key-0' })))
        .status,
    ).toBe(401);
    // Outside the 300 s skew window.
    expect(
      (
        await post(
          env,
          await sign({ timestamp: Math.floor(Date.now() / 1000) - 301 }),
        )
      ).status,
    ).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a DID document for another DID and stays off without Hub configuration', async () => {
    const key = await hubKey();
    const { env, record } = await routeEnv(() =>
      didDocument(key.publicKeyMultibase, 'did:web:evil.test'),
    );
    const headers = await signOutcomeRequest({
      privateKey: key.privateKey,
      keyId: KEY_ID,
      audience: ORACLE_ORIGIN,
      rawBody,
    });
    expect((await post(env, headers)).status).toBe(401);
    resetHubDidCache();
    for (const off of [
      { HUB_ACTIONS_ENABLED: 'false' },
      { AUTH_HUB_URL: '' },
      { AUTH_HUB_CHANNEL_SERVICE_KEY: '' },
    ])
      expect((await post({ ...env, ...off }, headers)).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it('verifies against ORACLE_PUBLIC_URL when it is set, whatever host the request used', async () => {
    const key = await hubKey();
    const { env, record } = await routeEnv(() =>
      didDocument(key.publicKeyMultibase),
    );
    const configured = { ...env, ORACLE_PUBLIC_URL: `${ORACLE_ORIGIN}/base/` };
    const sign = (audience: string) =>
      signOutcomeRequest({
        privateKey: key.privateKey,
        keyId: KEY_ID,
        audience,
        rawBody,
      });
    const viaAlias = 'https://alias.workers.dev/api/internal/actions/outcomes';
    expect(
      (await post(configured, await sign(ORACLE_ORIGIN), rawBody, viaAlias))
        .status,
    ).toBe(200);
    // Signed for the hostname the request used, not the configured one.
    expect(
      (
        await post(
          configured,
          await sign('https://alias.workers.dev'),
          rawBody,
          viaAlias,
        )
      ).status,
    ).toBe(401);
    expect(record).toHaveBeenCalledTimes(1);
    expect(callbackAudience(undefined, viaAlias)).toBe(
      'https://alias.workers.dev',
    );
    expect(callbackAudience('not a url', viaAlias)).toBe('');
  });

  it('picks up a rotated Hub key with one fresh DID document read', async () => {
    const before = await hubKey();
    const after = await hubKey();
    let current = before;
    const { env, record, hubCalls } = await routeEnv(() =>
      didDocument(current.publicKeyMultibase),
    );
    const signed = (key: { privateKey: CryptoKey }) =>
      signOutcomeRequest({
        privateKey: key.privateKey,
        keyId: KEY_ID,
        audience: ORACLE_ORIGIN,
        rawBody,
      });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect((await post(env, await signed(before))).status).toBe(200);
      current = after;
      // The cached document names the old key under the same id. Within
      // a minute of the last read a failed signature reads nothing again.
      expect((await post(env, await signed(after))).status).toBe(401);
      expect(hubCalls).toHaveLength(1);
      // Later, one fresh read picks up the rotated key.
      vi.setSystemTime(Date.now() + HUB_DID_REFRESH_MIN_MS);
      expect((await post(env, await signed(after))).status).toBe(200);
      expect(hubCalls).toHaveLength(2);
      // A forged signature right after reads nothing more.
      expect((await post(env, await signed(before))).status).toBe(401);
      expect(hubCalls).toHaveLength(2);
      expect(record).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /channels/turn rate limit', () => {
  it('answers 429 over the limit without calling the Auth Hub', async () => {
    const turn = await signedTurn();
    const { env, authHubCalls, limiterKeys, turns } = environment(turn, true);
    const res = await createShell().request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body: turn.raw },
      env,
    );
    expect(res.status).toBe(429);
    expect(limiterKeys).toEqual([`${turn.oracleDid}|channel|${USER_DID}`]);
    expect(authHubCalls).toEqual([]);
    expect(turns).toEqual([]);
  });

  it('spends a channel budget apart from the Portal one: a user at the Portal limit can still poll', async () => {
    const turn = await signedTurn();
    const { env, limiterKeys } = environment(turn, false);
    const portalKey = `${turn.oracleDid}|user|${USER_DID}`;
    // The limiter refuses the Portal key only (a user at its Portal limit).
    env.RATE_LIMIT.limit = async ({ key }: { key: string }) => {
      limiterKeys.push(key);
      return { success: key !== portalKey };
    };
    const res = await createShell().request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body: turn.raw },
      env,
    );
    expect(res.status).toBe(200);
    expect(limiterKeys).toEqual([`${turn.oracleDid}|channel|${USER_DID}`]);
    expect(rateLimitKey(env, 'channel', USER_DID)).not.toBe(portalKey);
  });

  it('checks the binding with the Auth Hub once within the limit', async () => {
    const turn = await signedTurn();
    const { env, authHubCalls, turns } = environment(turn, false);
    const res = await createShell().request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body: turn.raw },
      env,
    );
    expect(res.status).toBe(200);
    expect(authHubCalls).toEqual(['/api/internal/channels/validate-binding']);
    expect(turns).toEqual([USER_DID]);
  });
});

describe('POST /channels/turn retries', () => {
  it('admits two concurrent identical requests under one invocation', async () => {
    // A poll repeats the exact body and may reuse its invocation; the durable
    // receipt, not a replay mark, keeps the repeats on one run.
    const turn = await signedTurn();
    const { env, turns } = environment(turn, false);
    const shell = createShell();
    const send = () =>
      shell.request(
        '/channels/turn',
        { method: 'POST', headers: turn.headers, body: turn.raw },
        env,
      );
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(turns).toEqual([USER_DID, USER_DID]);
  });
});

describe('POST /channels/turn error bodies', () => {
  const send = (
    turn: Awaited<ReturnType<typeof signedTurn>>,
    env: ReturnType<typeof environment>['env'],
    body = turn.raw,
  ) =>
    createShell().request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body },
      env,
    );

  it('answers invalid JSON with 400 invalid_request', async () => {
    const turn = await signedTurn();
    const { env, turns } = environment(turn, false);
    const res = await send(turn, env, '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'invalid_request',
      message: 'Invalid JSON request',
    });
    expect(turns).toEqual([]);
  });

  it("passes the object's refusal on as { code, message } with its status", async () => {
    const turn = await signedTurn();
    const { env } = environment(turn, false, async () => ({
      ok: false,
      status: 428,
      code: 'delegation_required',
      message: 'Delegation required: the user must authorize this oracle again',
    }));
    const res = await send(turn, env);
    expect(res.status).toBe(428);
    expect(await res.json()).toEqual({
      code: 'delegation_required',
      message: 'Delegation required: the user must authorize this oracle again',
    });
  });

  it('answers an unexpected failure with 503 unavailable and logs its cause, bounded', async () => {
    const turn = await signedTurn();
    const cause = new Error(`owner copy failed: ${'x'.repeat(500)}`);
    cause.name = 'OwnerCopyUnavailableError';
    const { env } = environment(turn, false, async () => {
      throw cause;
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await send(turn, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'unavailable',
      message: 'Channel turn is temporarily unavailable',
    });
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toBe(
      `[channels] turn failed unexpectedly: OwnerCopyUnavailableError: ${cause.message.slice(0, 300)}…`,
    );
    // Nothing from the request: no token, no message text.
    expect(line).not.toContain(turn.headers.authorization.slice(7, 40));
    expect(line).not.toContain(input.message);
  });
});

describe('POST /channels/turn polls and the binding check', () => {
  const send = (
    turn: Awaited<ReturnType<typeof signedTurn>>,
    env: ReturnType<typeof environment>['env'],
    shell = createShell(),
  ) =>
    shell.request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body: turn.raw },
      env,
    );

  it('answers a poll of an existing run from the object, without the Auth Hub', async () => {
    const turn = await signedTurn();
    const running = {
      requestId: input.requestId,
      runId: 'channel_run',
      sessionId: '$session',
      status: 'running',
    };
    const { env, authHubCalls, turns, polls } = environment(
      turn,
      false,
      undefined,
      { channelPoll: async () => ({ ok: true, result: running }) },
    );
    const res = await send(turn, env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(running);
    expect(polls).toEqual([USER_DID]);
    expect(authHubCalls).toEqual([]);
    expect(turns).toEqual([]);
  });

  it('releases a finished reply while the Auth Hub is down', async () => {
    const turn = await signedTurn();
    const finished = {
      requestId: input.requestId,
      runId: 'channel_run',
      sessionId: '$session',
      status: 'finished',
      text: 'Done',
    };
    const { env, authHubCalls } = environment(turn, false, undefined, {
      channelPoll: async () => ({ ok: true, result: finished }),
      hub: () => new Response('down', { status: 500 }),
    });
    const res = await send(turn, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(finished);
    expect(authHubCalls).toEqual([]);
  });

  it('admits a new request after the Auth Hub check, and reuses an active verdict for the next one', async () => {
    const turn = await signedTurn();
    const { env, authHubCalls, turns, polls } = environment(turn, false);
    const shell = createShell();
    expect((await send(turn, env, shell)).status).toBe(200);
    expect((await send(turn, env, shell)).status).toBe(200);
    expect(polls).toEqual([USER_DID, USER_DID]);
    expect(turns).toEqual([USER_DID, USER_DID]);
    expect(authHubCalls).toEqual(['/api/internal/channels/validate-binding']);
  });

  it.each([
    {
      name: 'an inactive binding',
      hub: () => Response.json({ active: false }),
      status: 403,
      code: 'binding_inactive',
    },
    {
      name: 'an unavailable Auth Hub',
      hub: () => new Response('down', { status: 503 }),
      status: 503,
      code: 'binding_check_unavailable',
    },
  ])('never caches $name', async ({ hub, status, code }) => {
    const turn = await signedTurn();
    const { env, authHubCalls, turns } = environment(turn, false, undefined, {
      hub,
    });
    const shell = createShell();
    for (let i = 0; i < 2; i += 1) {
      const res = await send(turn, env, shell);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
    expect(authHubCalls).toHaveLength(2);
    expect(turns).toEqual([]);
  });
});

describe('the binding verdict cache', () => {
  const identity = {
    userDid: USER_DID,
    channel: {
      callerDid: 'did:web:channels.test',
      provider: 'whatsapp' as const,
      bindingId: 'chb_cache',
      bindingRevision: 1,
    },
  };
  const hubEnv = (calls: unknown[]) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      calls.push(request);
      return Response.json({ active: true });
    });
    return {
      ORACLE_DID: 'did:ixo:oracle',
      AUTH_HUB_CHANNEL_SERVICE_KEY: 'k',
      AUTH_HUB_URL: 'https://auth-hub.test',
    };
  };

  it('keeps an active verdict for 60 s per binding revision and user, then asks again', async () => {
    const calls: unknown[] = [];
    const env = hubEnv(calls);
    const t0 = 1_000_000;
    expect(await assertActiveChannelBindingCached(identity, env, t0)).toBe(
      'checked',
    );
    expect(
      await assertActiveChannelBindingCached(
        identity,
        env,
        t0 + CHANNEL_BINDING_CACHE_TTL_MS - 1,
      ),
    ).toBe('cached');
    // Another revision of the binding is another verdict.
    expect(
      await assertActiveChannelBindingCached(
        { ...identity, channel: { ...identity.channel, bindingRevision: 2 } },
        env,
        t0,
      ),
    ).toBe('checked');
    expect(
      await assertActiveChannelBindingCached(
        identity,
        env,
        t0 + CHANNEL_BINDING_CACHE_TTL_MS,
      ),
    ).toBe('checked');
    expect(calls).toHaveLength(3);
  });

  it('stays bounded: the oldest verdict makes room', async () => {
    const calls: unknown[] = [];
    const env = hubEnv(calls);
    const t0 = 2_000_000;
    const user = (i: number) => ({ ...identity, userDid: `did:ixo:user${i}` });
    for (let i = 0; i <= CHANNEL_BINDING_CACHE_MAX_ENTRIES; i += 1)
      await assertActiveChannelBindingCached(user(i), env, t0);
    expect(await assertActiveChannelBindingCached(user(0), env, t0)).toBe(
      'checked',
    );
    expect(
      await assertActiveChannelBindingCached(
        user(CHANNEL_BINDING_CACHE_MAX_ENTRIES),
        env,
        t0,
      ),
    ).toBe('cached');
  });
});

describe('POST /channels/turn service DID list', () => {
  const send = (
    turn: Awaited<ReturnType<typeof signedTurn>>,
    env: ReturnType<typeof environment>['env'],
  ) =>
    createShell().request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body: turn.raw },
      env,
    );

  it('admits a service listed second in a comma-separated CHANNEL_SERVICE_DID', async () => {
    const turn = await signedTurn();
    const { env, turns } = environment(turn, false);
    env.CHANNEL_SERVICE_DID = `did:web:other.example.test, ${turn.serviceDid}`;
    expect((await send(turn, env)).status).toBe(200);
    expect(turns).toEqual([USER_DID]);
  });

  it('answers 503 not_configured, before reading the body, when the list is empty', async () => {
    const turn = await signedTurn();
    const { env, turns } = environment(turn, false);
    env.CHANNEL_SERVICE_DID = ' , ';
    const res = await send(turn, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'not_configured',
      message: 'Channels are not configured',
    });
    expect(turns).toEqual([]);
  });
});

describe('POST /channels/control authorization', () => {
  const control: ChannelControlInput = {
    provider: 'whatsapp',
    bindingId: input.bindingId,
    bindingRevision: 1,
    requestId: 'wa:stop',
    cancelRequestIds: [input.requestId],
    command: { kind: 'stop' },
  };
  it('authenticates the exact control body and checks the active binding before invoking the user object', async () => {
    const signed = await signedTurn(control);
    const e = environment(signed, false);
    const response = await createShell().fetch(
      new Request('https://oracle.test/channels/control', {
        method: 'POST',
        headers: signed.headers,
        body: signed.raw,
      }),
      e.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: control.requestId,
      command: 'stop',
    });
    expect(e.authHubCalls).toHaveLength(1);
    expect(e.turns).toEqual([USER_DID]);
  });
  it('rejects changed commands and inactive bindings without invoking controls', async () => {
    const signed = await signedTurn(control);
    const e = environment(signed, false, undefined, {
      hub: () => Response.json({ active: false }),
    });
    const changed = await createShell().fetch(
      new Request('https://oracle.test/channels/control', {
        method: 'POST',
        headers: signed.headers,
        body: JSON.stringify({ ...control, command: { kind: 'new' } }),
      }),
      e.env,
    );
    expect(changed.status).toBe(403);
    const revoked = await createShell().fetch(
      new Request('https://oracle.test/channels/control', {
        method: 'POST',
        headers: signed.headers,
        body: signed.raw,
      }),
      e.env,
    );
    expect(revoked.status).toBe(403);
    expect(e.turns).toEqual([]);
  });
  it('rate limits controls before asking Auth Hub', async () => {
    const signed = await signedTurn(control);
    const e = environment(signed, true);
    const response = await createShell().fetch(
      new Request('https://oracle.test/channels/control', {
        method: 'POST',
        headers: signed.headers,
        body: signed.raw,
      }),
      e.env,
    );
    expect(response.status).toBe(429);
    expect(e.authHubCalls).toEqual([]);
    expect(e.turns).toEqual([]);
  });
  it('spends a control budget apart from turns and polls, so polling cannot block a stop', async () => {
    const signed = await signedTurn(control);
    const e = environment(signed, false);
    const channelKey = `${signed.oracleDid}|channel|${USER_DID}`;
    // The limiter refuses the turn/poll key only (a gateway polling hard).
    e.env.RATE_LIMIT.limit = async ({ key }: { key: string }) => {
      e.limiterKeys.push(key);
      return { success: key !== channelKey };
    };
    const response = await createShell().fetch(
      new Request('https://oracle.test/channels/control', {
        method: 'POST',
        headers: signed.headers,
        body: signed.raw,
      }),
      e.env,
    );
    expect(response.status).toBe(200);
    expect(e.limiterKeys).toEqual([
      `${signed.oracleDid}|channel-control|${USER_DID}`,
    ]);
  });
});
