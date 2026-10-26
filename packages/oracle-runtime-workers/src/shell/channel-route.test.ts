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
} from '../channels/contract';
import { createShell, rateLimitKey } from './app';

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
async function signedTurn() {
  const user = await generateKeypair();
  const service = await generateKeypair();
  const oracle = await generateKeypair();
  const signer = user.signer.withDID(USER_DID);
  const capability: Capability = {
    can: 'ixo:channel/invoke',
    with: `ixo:channel:${input.bindingId}`,
    nb: {
      provider: input.provider,
      bindingRevision: input.bindingRevision,
      oracleDid: oracle.did,
    },
  };
  const grant = await createDelegation({
    issuer: signer,
    audience: service.did,
    capabilities: [capability],
    expiration: Math.floor(Date.now() / 1000) + 300,
  });
  const raw = JSON.stringify(input);
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
          requestId: input.requestId,
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
  it('requires the separate Hub callback secret before routing by owner', async () => {
    const turn = await signedTurn();
    const base = environment(turn, false).env;
    const record = vi.fn(async () => undefined);
    const env = {
      ...base,
      HUB_ACTIONS_ENABLED: 'true',
      AUTH_HUB_ACTION_OUTCOME_KEY: 'x'.repeat(40),
      USER_ORACLE: {
        idFromName: (name: string) => name,
        get: () => ({ recordHubActionOutcome: record }),
      },
    };
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
    const shell = createShell();
    const send = (key?: string) =>
      shell.request(
        '/api/internal/actions/outcomes',
        {
          method: 'POST',
          headers: key ? { 'x-auth-hub-outcome-key': key } : {},
          body: JSON.stringify(outcome),
        },
        env,
      );
    expect((await send()).status).toBe(401);
    expect((await send('wrong')).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
    const accepted = await send('x'.repeat(40));
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
