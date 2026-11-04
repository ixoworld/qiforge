import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS, REFRESH_EARLY_MS } from './connection';
import {
  deriveKeys,
  objectNameOf,
  objectNameOfState,
  pkceChallenge,
  unseal,
  type Sealed,
} from './oauth';
import {
  accountAnswer,
  connectionWith,
  MemoryStorage,
  json,
  MCP_URL,
  OTHER_ADDRESS,
  PERSON_ADDRESS,
  PERSON_DID,
  recordingFetch,
  TOKEN_KEY,
  tokenAnswer,
} from './testing';

async function signedIn(
  clock: { now: number },
  answer: (n: number) => Response | Promise<Response> = (n) => tokenAnswer(n),
) {
  let issued = 0;
  const net = recordingFetch(() => answer(++issued));
  const { connection, storage } = connectionWith(net.fetcher, clock);
  const { link } = await connection.begin(PERSON_DID, 'whatsapp');
  const state = link.split('/').pop()!;
  const done = await connection.complete(state, 'code-1');
  expect(done).toEqual({ ok: true, surface: 'whatsapp' });
  return { connection, storage, net };
}

describe('sign-in: PKCE, state and code exchange', () => {
  it('sends a S256 challenge of the kept verifier, and the verifier with the code', async () => {
    const clock = { now: 1_000 };
    const net = recordingFetch(() => tokenAnswer(1));
    const { connection } = connectionWith(net.fetcher, clock);
    const { link, expiresAt } = await connection.begin(PERSON_DID, 'chat');
    expect(expiresAt).toBe(1_000 + PENDING_TTL_MS);
    expect(link).toMatch(
      /^https:\/\/companion\.devnet\.ixo\.earth\/asks\/oauth\/start\/[0-9a-f]{64}\.[A-Za-z0-9_-]{32}$/,
    );
    const state = link.split('/').pop()!;
    // The object is named from the DID inside the object, not by the caller.
    expect(objectNameOfState(state)).toBe(
      await objectNameOf(await deriveKeys(TOKEN_KEY), PERSON_DID),
    );

    const step = await connection.authorizeUrl(state);
    if (!('url' in step)) throw new Error('no url');
    const asked = new URL(step.url);
    expect(asked.origin + asked.pathname).toBe(
      'https://dev.asks.world/oauth/authorize',
    );
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'https://companion.devnet.ixo.earth/asks/oauth/client.json',
      redirect_uri: 'https://companion.devnet.ixo.earth/asks/oauth/callback',
      state,
      code_challenge_method: 'S256',
      resource: MCP_URL,
      scope: 'asks',
    });

    expect(await connection.complete(state, 'the-code')).toEqual({
      ok: true,
      surface: 'chat',
    });
    const form = net.calls[0]!.form!;
    expect(net.calls[0]!.url).toBe('https://dev.asks.world/oauth/token');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('resource')).toBe(MCP_URL);
    expect(await pkceChallenge(form.get('code_verifier')!)).toBe(
      asked.searchParams.get('code_challenge'),
    );
  });

  it('takes a state once, refuses another state and an expired one', async () => {
    const clock = { now: 0 };
    const net = recordingFetch(() => tokenAnswer(1));
    const { connection } = connectionWith(net.fetcher, clock);
    const state = (await connection.begin(PERSON_DID, 'chat')).link
      .split('/')
      .pop()!;
    const name = state.split('.')[0]!;
    expect(await connection.complete(`${name}.${'x'.repeat(32)}`, 'c')).toEqual(
      { ok: false, reason: 'unknown' },
    );
    expect(await connection.complete(state, 'c')).toMatchObject({ ok: true });
    expect(await connection.complete(state, 'c')).toEqual({
      ok: false,
      reason: 'unknown',
    });

    const later = (await connection.begin(PERSON_DID, 'chat')).link
      .split('/')
      .pop()!;
    clock.now += PENDING_TTL_MS + 1;
    expect(await connection.authorizeUrl(later)).toEqual({ reason: 'expired' });
    expect(net.calls).toHaveLength(1);
  });

  it("keeps the sign-in only for the chat person's own asks account, and says whose", async () => {
    const net = recordingFetch(() => tokenAnswer(1));
    const { connection, probes } = connectionWith(net.fetcher, { now: 0 });
    const state = (await connection.begin(PERSON_DID, 'chat')).link
      .split('/')
      .pop()!;
    expect(await connection.complete(state, 'c')).toEqual({
      ok: true,
      surface: 'chat',
    });
    // The check is an MCP initialize with the new token.
    expect(probes).toHaveLength(1);
    expect(new Headers(probes[0]!.init?.headers).get('authorization')).toBe(
      'Bearer asks_at_1',
    );
    expect(String(probes[0]!.init?.body)).toContain('"initialize"');
    expect(await connection.status()).toEqual({
      connected: true,
      pending: false,
      account: PERSON_ADDRESS,
    });
  });

  it('a forwarded link opened by someone else links nothing and revokes their sign-in', async () => {
    const net = recordingFetch((call) =>
      call.url.endsWith('/oauth/revoke') ? json({}) : tokenAnswer(1),
    );
    const { connection, storage } = connectionWith(
      net.fetcher,
      { now: 0 },
      undefined,
      () => accountAnswer(OTHER_ADDRESS),
    );
    const state = (await connection.begin(PERSON_DID, 'whatsapp')).link
      .split('/')
      .pop()!;
    expect(await connection.complete(state, 'c')).toEqual({
      ok: false,
      reason: 'other-account',
    });
    expect(storage.map.has('tokens')).toBe(false);
    const revoke = net.calls.find((call) => call.url.endsWith('/oauth/revoke'));
    expect(revoke?.form?.get('token')).toBe('asks_rt_1');
    expect((await connection.status()).connected).toBe(false);
    // The state is spent too.
    expect(await connection.complete(state, 'c')).toMatchObject({
      reason: 'unknown',
    });
  });

  it('fails closed when asks cannot say whose sign-in it is', async () => {
    for (const account of [
      () => json({ error: 'down' }, 503),
      () => Promise.reject(new Error('timeout')),
      () => json({ jsonrpc: '2.0', id: 1, result: { instructions: 'Hi' } }),
    ]) {
      const net = recordingFetch((call) =>
        call.url.endsWith('/oauth/revoke') ? json({}) : tokenAnswer(1),
      );
      const { connection, storage } = connectionWith(
        net.fetcher,
        { now: 0 },
        undefined,
        account,
      );
      const state = (await connection.begin(PERSON_DID, 'chat')).link
        .split('/')
        .pop()!;
      expect(await connection.complete(state, 'c')).toEqual({
        ok: false,
        reason: 'unconfirmed',
      });
      expect(storage.map.has('tokens')).toBe(false);
      expect(net.calls.some((call) => call.url.endsWith('/oauth/revoke'))).toBe(
        true,
      );
    }
  });

  it('a person whose DID names no IXO account can never link one', async () => {
    const net = recordingFetch(() => tokenAnswer(1));
    const { connection } = connectionWith(net.fetcher, { now: 0 });
    const state = (await connection.begin('did:key:z6Mk', 'chat')).link
      .split('/')
      .pop()!;
    expect(await connection.complete(state, 'c')).toMatchObject({
      reason: 'other-account',
    });
  });

  it('names one object per person with the key, not the DID', async () => {
    const keys = await deriveKeys(TOKEN_KEY);
    const one = await objectNameOf(keys, 'did:ixo:ixo1a');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(await objectNameOf(keys, 'did:ixo:ixo1a')).toBe(one);
    expect(await objectNameOf(keys, 'did:ixo:ixo1b')).not.toBe(one);
    expect(
      await objectNameOf(
        await deriveKeys(`${TOKEN_KEY}-other`),
        'did:ixo:ixo1a',
      ),
    ).not.toBe(one);
  });
});

describe('token storage', () => {
  it('keeps the tokens sealed: no plaintext in storage, and only this key opens them', async () => {
    const { storage } = await signedIn({ now: 0 });
    const raw = JSON.stringify([...storage.map.entries()]);
    expect(raw).not.toContain('asks_at_1');
    expect(raw).not.toContain('asks_rt_1');
    const sealed = storage.map.get('tokens') as Sealed;
    const keys = await deriveKeys(TOKEN_KEY);
    expect(await unseal(keys.seal, 'tokens', sealed)).toMatchObject({
      access: 'asks_at_1',
      refresh: 'asks_rt_1',
    });
    expect(
      await unseal((await deriveKeys(`${TOKEN_KEY}-x`)).seal, 'tokens', sealed),
    ).toBeNull();
    // Bound to its kind: a token record does not open as the pending sign-in.
    expect(await unseal(keys.seal, 'pending', sealed)).toBeNull();
  });
});

describe('refresh', () => {
  it('serves the access token as is until 2 minutes before it ends', async () => {
    const clock = { now: 0 };
    const { connection, net } = await signedIn(clock);
    clock.now = 1_800_000 - REFRESH_EARLY_MS - 1;
    expect(await connection.token()).toEqual({ ok: true, access: 'asks_at_1' });
    expect(net.calls).toHaveLength(1);
  });

  it('refreshes once for two callers at the same time, and stores the new pair before using it', async () => {
    const clock = { now: 0 };
    let release: () => void = () => undefined;
    let issued = 0;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { connection, storage, net } = await signedIn(clock, async (n) => {
      issued = n;
      if (n > 1) await gate;
      return tokenAnswer(n);
    });
    clock.now = 1_800_000 - REFRESH_EARLY_MS + 1;
    const first = connection.token();
    const second = connection.token();
    release();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, access: 'asks_at_2' },
      { ok: true, access: 'asks_at_2' },
    ]);
    expect(issued).toBe(2);
    const refreshes = net.calls.filter(
      (call) => call.form?.get('grant_type') === 'refresh_token',
    );
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.form!.get('refresh_token')).toBe('asks_rt_1');
    const keys = await deriveKeys(TOKEN_KEY);
    expect(
      await unseal(keys.seal, 'tokens', storage.map.get('tokens') as Sealed),
    ).toMatchObject({ refresh: 'asks_rt_2' });
    // The next caller reads the stored pair; no second refresh.
    expect(await connection.token()).toEqual({ ok: true, access: 'asks_at_2' });
    expect(
      net.calls.filter(
        (call) => call.form?.get('grant_type') === 'refresh_token',
      ),
    ).toHaveLength(1);
  });

  it('on invalid_grant forgets the tokens, so the person is offered sign-in again', async () => {
    const clock = { now: 0 };
    const { connection, storage } = await signedIn(clock, (n) =>
      n === 1
        ? tokenAnswer(1)
        : json({ error: 'invalid_grant', error_description: 'reused' }, 400),
    );
    clock.now = 1_800_000;
    expect(await connection.token()).toEqual({ ok: false, reason: 'ended' });
    expect(storage.map.has('tokens')).toBe(false);
    expect(await connection.status()).toEqual({
      connected: false,
      pending: false,
    });
    expect(await connection.token()).toEqual({
      ok: false,
      reason: 'not-connected',
    });
  });

  it('any 4xx from the token endpoint ends the connection; 5xx, 408 and 429 do not', async () => {
    for (const [status, error, ended] of [
      [401, 'invalid_client', true],
      [400, 'invalid_request', true],
      [403, undefined, true],
      [429, undefined, false],
      [408, undefined, false],
      [500, undefined, false],
    ] as const) {
      const clock = { now: 0 };
      const { connection, storage } = await signedIn(clock, (n) =>
        n === 1 ? tokenAnswer(1) : json(error ? { error } : {}, status),
      );
      clock.now = 1_800_000 - 1;
      const read = await connection.token();
      expect(read.ok, `status ${status}`).toBe(!ended);
      expect(storage.map.has('tokens'), `status ${status}`).toBe(!ended);
    }
  });

  it("a lost refresh answer is retried at once, inside asks' 60 s grace", async () => {
    const clock = { now: 0 };
    let refreshes = 0;
    const { connection } = await signedIn(clock, (n) => {
      if (n === 1) return tokenAnswer(1);
      refreshes += 1;
      return refreshes === 1
        ? Promise.reject(new Error('network lost'))
        : tokenAnswer(n);
    });
    clock.now = 1_800_000 - 1;
    expect(await connection.token()).toEqual({ ok: true, access: 'asks_at_3' });
    expect(refreshes).toBe(2);
  });

  it('a caller that read the pair while a refresh ran never refreshes the spent token', async () => {
    const clock = { now: 0 };
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((r) => (releaseRefresh = r));
    let issued = 0;
    const net = recordingFetch(async () => {
      issued += 1;
      if (issued === 2) await refreshGate;
      return tokenAnswer(issued);
    });
    // A storage read that takes its snapshot at once but answers late, the
    // way a caller can hold the old pair while another refresh finishes.
    const storage = new MemoryStorage();
    let slow: Promise<void> | null = null;
    const get = storage.get.bind(storage);
    storage.get = <T>(key: string) => {
      const value = get<T>(key);
      const wait = slow;
      slow = null;
      return wait ? wait.then(() => value) : value;
    };
    const { connection } = connectionWith(net.fetcher, clock, storage);
    const state = (await connection.begin(PERSON_DID, 'chat')).link
      .split('/')
      .pop()!;
    await connection.complete(state, 'c');
    clock.now = 1_800_000 - REFRESH_EARLY_MS + 1;

    const first = connection.token();
    // The first caller's refresh is at asks.
    while (issued < 2) await new Promise((r) => setTimeout(r, 0));
    let releaseRead: () => void = () => undefined;
    slow = new Promise<void>((r) => (releaseRead = r));
    const second = connection.token();
    releaseRefresh();
    await first;
    releaseRead();
    expect(await second).toEqual({ ok: true, access: 'asks_at_2' });
    const used = net.calls
      .filter((call) => call.form?.get('grant_type') === 'refresh_token')
      .map((call) => call.form!.get('refresh_token'));
    expect(used).toEqual(['asks_rt_1']);
  });

  it('a refused access token: replaced by a newer pair, kept when asks still takes it, ended (and revoked) when asks refuses it', async () => {
    const clock = { now: 0 };
    let probe: () => Response = () => accountAnswer();
    let issued = 0;
    const net = recordingFetch((call) =>
      call.url.endsWith('/oauth/revoke') ? json({}) : tokenAnswer(++issued),
    );
    const { connection, storage } = connectionWith(
      net.fetcher,
      clock,
      undefined,
      () => probe(),
    );
    const state = (await connection.begin(PERSON_DID, 'chat')).link
      .split('/')
      .pop()!;
    await connection.complete(state, 'c');
    clock.now = 1_800_000 - 1;
    expect(await connection.token()).toEqual({ ok: true, access: 'asks_at_2' });
    expect(await connection.refused('asks_at_1')).toBe('replaced');
    expect(await connection.refused('asks_at_2')).toBe('kept');
    expect(storage.map.has('tokens')).toBe(true);
    probe = () => json({ error: 'invalid_token' }, 401);
    expect(await connection.refused('asks_at_2')).toBe('ended');
    expect(storage.map.has('tokens')).toBe(false);
    expect(net.calls.at(-1)!.form!.get('token')).toBe('asks_rt_2');
  });

  it('keeps the old token while asks does not answer and it still works', async () => {
    const clock = { now: 0 };
    const { connection, storage } = await signedIn(clock, (n) =>
      n === 1 ? tokenAnswer(1) : json({}, 503),
    );
    clock.now = 1_800_000 - 60_000;
    expect(await connection.token()).toEqual({ ok: true, access: 'asks_at_1' });
    clock.now = 1_800_001;
    expect(await connection.token()).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    expect(storage.map.has('tokens')).toBe(true);
  });

  it('disconnect waits for a refresh in flight and revokes the new pair', async () => {
    const clock = { now: 0 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { connection, net } = await signedIn(clock, async (n) => {
      if (n === 2) await gate;
      return n > 2 ? json({}) : tokenAnswer(n);
    });
    clock.now = 1_800_000 - 1;
    const refreshing = connection.token();
    const disconnecting = connection.disconnect();
    release();
    await Promise.all([refreshing, disconnecting]);
    expect(net.calls.at(-1)!.form!.get('token')).toBe('asks_rt_2');
    expect((await connection.status()).connected).toBe(false);
  });

  it('disconnect revokes the refresh token at asks, then forgets', async () => {
    const { connection, net } = await signedIn({ now: 0 });
    await connection.disconnect();
    const revoke = net.calls.at(-1)!;
    expect(revoke.url).toBe('https://dev.asks.world/oauth/revoke');
    expect(revoke.form!.get('token')).toBe('asks_rt_1');
    expect(revoke.form!.get('client_id')).toBe(
      'https://companion.devnet.ixo.earth/asks/oauth/client.json',
    );
    expect(await connection.status()).toEqual({
      connected: false,
      pending: false,
    });
  });
});

describe('upload addresses', () => {
  it('keeps one per draft until it expires', async () => {
    const clock = { now: 0 };
    const { connection } = await signedIn(clock);
    await connection.keepUpload(
      'ad_aaaaaaaaaaaaaaaaaaaaaa',
      'https://up/draft-uploads/du_x/',
      60_000,
    );
    expect(await connection.uploadOf('ad_aaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'https://up/draft-uploads/du_x/',
    );
    clock.now = 60_001;
    expect(await connection.uploadOf('ad_aaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });
});
