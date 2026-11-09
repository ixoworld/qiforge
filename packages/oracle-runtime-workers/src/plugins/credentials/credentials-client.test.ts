import { describe, expect, it } from 'vitest';
import {
  CredentialsWorkerClient,
  mergeVerifierAccept,
  VerifierEntryMemo,
} from './credentials-client';
import {
  json,
  noSleep,
  ORACLE_DID,
  routedFetch,
  VCT,
  WORKER,
} from './test-fixtures';

const ISSUER = 'did:ixo:entity:80f392610e8a128b4f4b1ed828dbeb7f';
const NEED = {
  purpose: 'Check your age',
  vct: VCT,
  claims: ['age_over_18'],
  issuers: [ISSUER],
};

function worker(fetchImpl: (r: Request) => Promise<Response>) {
  const facts: Record<string, unknown>[][] = [];
  const client = new CredentialsWorkerClient({
    baseUrl: WORKER,
    mint: async (f) => {
      facts.push(f);
      return `inv-${facts.length}`;
    },
    fetchImpl,
    sleep: noSleep,
  });
  return { client, facts };
}

describe('mergeVerifierAccept', () => {
  it('adds a new type, then widens it, and reports no change when covered', () => {
    const first = mergeVerifierAccept({ accepts: [] }, NEED);
    expect(first).toEqual({ accepts: [NEED], changed: true });
    const wider = mergeVerifierAccept(
      { accepts: first?.accepts ?? [] },
      { ...NEED, claims: ['identity_level'] },
    );
    expect(wider?.changed).toBe(true);
    expect(wider?.accepts[0]?.claims).toEqual([
      'age_over_18',
      'identity_level',
    ]);
    expect(
      mergeVerifierAccept({ accepts: wider?.accepts ?? [] }, NEED)?.changed,
    ).toBe(false);
  });

  it('refuses to grow past the catalog limits', () => {
    const accepts = Array.from({ length: 50 }, (_, i) => ({
      ...NEED,
      vct: `${VCT}/${i}`,
    }));
    expect(mergeVerifierAccept({ accepts }, NEED)).toBeNull();
  });
});

describe('CredentialsWorkerClient', () => {
  it('deposits a request with a POST-bound invocation', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`POST ${WORKER}/v1/requests`]: () =>
        json(
          {
            id: 'req_1',
            request_uri: `${WORKER}/v1/requests/req_1/object`,
            openid4vp_url: 'openid4vp://?x',
            wallet_url: 'https://dev.auth.ixo.earth/credentials/requests/req_1',
            status: 'pending',
          },
          201,
        ),
    });
    const { client, facts } = worker(fetchImpl);
    const out = await client.deposit({
      subject: 'did:ixo:ixo10e8pu63ee3p4y62wlu9myuyh2p08upm8xp4jw7',
      ref: 'chk',
      request: 'JWT',
      purpose: 'Check',
      expiresAt: 100,
    });
    expect(out.id).toBe('req_1');
    expect(JSON.parse(calls[0]?.body ?? '')).toMatchObject({
      ref: 'chk',
      expires_at: 100,
    });
    expect(facts).toEqual([[{ method: 'POST', path: '/v1/requests' }]]);
  });

  it('passes on 403 blocked and 429 too_many_pending', async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${WORKER}/v1/requests`]: [
        () => json({ error: 'blocked', message: 'x' }, 403),
        () =>
          json({ error: 'too_many_pending', message: 'x' }, 429, {
            'retry-after': '120',
          }),
      ],
    });
    const { client } = worker(fetchImpl);
    const input = {
      subject: 's',
      ref: 'r',
      request: 'j',
      purpose: 'p',
      expiresAt: 1,
    };
    await expect(client.deposit(input)).rejects.toMatchObject({
      code: 'blocked',
    });
    await expect(client.deposit(input)).rejects.toMatchObject({
      code: 'too_many_pending',
    });
  });
});

describe('VerifierEntryMemo', () => {
  it('publishes the entry once, then trusts it for an hour (concurrent calls share the work)', async () => {
    const entryUrl = `${WORKER}/v1/catalog/verifiers/${ORACLE_DID}`;
    const { fetchImpl, calls } = routedFetch({
      [`GET ${entryUrl}`]: () =>
        json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${entryUrl}`]: () =>
        json(
          {
            sender_key: ORACLE_DID,
            entry: {},
            updated_at: 1,
            display_dropped: [],
          },
          201,
        ),
    });
    let now = 0;
    const memo = new VerifierEntryMemo(() => now);
    const { client, facts } = worker(fetchImpl);
    const identity = { did: ORACLE_DID, name: 'Companion' };
    await Promise.all([
      memo.ensure(client, WORKER, identity, NEED),
      memo.ensure(client, WORKER, identity, NEED),
    ]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({
      did: ORACLE_DID,
      name: 'Companion',
      accepts: [NEED],
    });
    expect(facts).toEqual([
      [{ method: 'PUT', path: `/v1/catalog/verifiers/${ORACLE_DID}` }],
    ]);
    await memo.ensure(client, WORKER, identity, NEED);
    expect(calls).toHaveLength(2);
    now += 61 * 60 * 1000;
    await memo.ensure(client, WORKER, identity, NEED);
    expect(calls).toHaveLength(4);
  });

  it('does not write an entry that already covers the check', async () => {
    const entryUrl = `${WORKER}/v1/catalog/verifiers/${ORACLE_DID}`;
    const { fetchImpl, calls } = routedFetch({
      [`GET ${entryUrl}`]: () =>
        json({
          sender_key: ORACLE_DID,
          entry: { did: ORACLE_DID, name: 'Companion', accepts: [NEED] },
          updated_at: 1,
        }),
    });
    const { client } = worker(fetchImpl);
    await new VerifierEntryMemo().ensure(
      client,
      WORKER,
      { did: ORACLE_DID, name: 'Companion' },
      NEED,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});
