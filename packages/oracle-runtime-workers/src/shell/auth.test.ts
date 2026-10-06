/**
 * `authenticate` at its edges: what an invocation must be to prove a caller,
 * how a delegation beside it is paired (or dropped), the bare-delegation
 * fallback, and headers that are not an invocation at all.
 */
import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeDelegation,
  serializeInvocation,
  type Signer,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticate,
  DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS,
  INVOCATION_REQUIRED_ERROR,
  isExcluded,
} from './auth';

// did:key throughout: every DID resolves locally, Blocksync is never asked.
const ORACLE_DID = (await generateKeypair()).did;
const CFG = {
  oracleDid: ORACLE_DID,
  blocksyncUri: 'https://blocksync.invalid/graphql',
};
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function invocation(
  issuer: Signer,
  opts: { audience?: string; expiration?: number } = {},
): Promise<string> {
  return serializeInvocation(
    await createInvocation({
      issuer,
      audience: opts.audience ?? ORACLE_DID,
      capability: { can: '*', with: 'ixo:oracle' },
      proofs: [],
      ...(opts.expiration !== undefined ? { expiration: opts.expiration } : {}),
    }),
  );
}

async function delegation(issuer: Signer, expiration: number) {
  return serializeDelegation(
    await createDelegation({
      issuer,
      audience: ORACLE_DID,
      capabilities: [{ can: '*', with: 'ixo:oracle' }],
      expiration,
    }),
  );
}

const ucan = (token: string, extra: Record<string, string> = {}) =>
  new Headers({
    authorization: `Bearer ${token}`,
    'x-auth-type': 'ucan',
    ...extra,
  });

describe('authenticate: the invocation', () => {
  it('proves the signer, never a DID the client names', async () => {
    const user = await generateKeypair();
    const other = await generateKeypair();
    const outcome = await authenticate(
      ucan(await invocation(user.signer, { expiration: nowSeconds() + 300 }), {
        'x-did': other.did,
      }),
      CFG,
    );
    expect(outcome).toEqual({
      ok: true,
      auth: {
        userDid: user.did,
        via: 'invocation',
        delegation: undefined,
        delegationExpiration: undefined,
      },
    });
  });

  it('refuses an expired invocation', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      ucan(await invocation(user.signer, { expiration: nowSeconds() - 60 })),
      CFG,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(401);
    expect(outcome.error).toMatch(/^Invalid UCAN invocation: .*expired/is);
  });

  it('refuses an invocation that never expires, or lives longer than the allowed TTL', async () => {
    const user = await generateKeypair();
    const forever = await authenticate(
      ucan(await invocation(user.signer)),
      CFG,
    );
    expect(forever.ok).toBe(false);
    const tooLong = await authenticate(
      ucan(
        await invocation(user.signer, {
          expiration: nowSeconds() + DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS + 600,
        }),
      ),
      CFG,
    );
    expect(tooLong).toEqual({
      ok: false,
      status: 401,
      error: `Invalid UCAN invocation: Auth invocation TTL exceeds maximum of ${DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS}s`,
    });
  });

  it('refuses an invocation addressed to another oracle', async () => {
    const user = await generateKeypair();
    const elsewhere = await generateKeypair();
    const outcome = await authenticate(
      ucan(
        await invocation(user.signer, {
          audience: elsewhere.did,
          expiration: nowSeconds() + 300,
        }),
      ),
      CFG,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(401);
  });

  it('accepts the same invocation again within its lifetime (clients reuse one per TTL)', async () => {
    const user = await generateKeypair();
    const token = await invocation(user.signer, {
      expiration: nowSeconds() + 300,
    });
    const first = await authenticate(ucan(token), CFG);
    const again = await authenticate(ucan(token), CFG);
    expect(first.ok && first.auth.userDid).toBe(user.did);
    expect(again.ok && again.auth.userDid).toBe(user.did);
  });

  it('treats headers that are not a UCAN invocation as no credentials', async () => {
    const user = await generateKeypair();
    const token = await invocation(user.signer, {
      expiration: nowSeconds() + 300,
    });
    const missing = {
      ok: false,
      status: 401,
      error:
        'Missing Authorization (UCAN invocation) or x-ucan-delegation header',
    };
    // Another scheme, no token, no X-Auth-Type.
    expect(
      await authenticate(
        new Headers({ authorization: `Basic ${token}`, 'x-auth-type': 'ucan' }),
        CFG,
      ),
    ).toEqual(missing);
    expect(
      await authenticate(
        new Headers({ authorization: 'Bearer', 'x-auth-type': 'ucan' }),
        CFG,
      ),
    ).toEqual(missing);
    expect(
      await authenticate(
        new Headers({ authorization: `Bearer ${token}` }),
        CFG,
      ),
    ).toEqual(missing);
    expect(await authenticate(new Headers(), CFG)).toEqual(missing);
  });

  it('refuses a malformed invocation with 401, never throwing', async () => {
    const outcome = await authenticate(ucan('not-a-car-file'), CFG);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(401);
    expect(outcome.error).toMatch(/^Invalid UCAN invocation:/);
  });
});

describe('authenticate: the delegation beside an invocation', () => {
  it("drops another user's delegation: the caller stays the invocation's signer and carries nothing downstream", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const outcome = await authenticate(
      ucan(await invocation(alice.signer, { expiration: nowSeconds() + 300 }), {
        'x-ucan-delegation': await delegation(bob.signer, nowSeconds() + 3600),
      }),
      CFG,
    );
    expect(outcome).toMatchObject({
      ok: true,
      auth: { userDid: alice.did, via: 'invocation' },
    });
    if (!outcome.ok) return;
    expect(outcome.auth.delegation).toBeUndefined();
  });

  it('ignores an invalid delegation beside a valid invocation', async () => {
    const alice = await generateKeypair();
    const outcome = await authenticate(
      ucan(await invocation(alice.signer, { expiration: nowSeconds() + 300 }), {
        'x-ucan-delegation': 'garbage',
      }),
      CFG,
    );
    expect(outcome).toMatchObject({
      ok: true,
      auth: { userDid: alice.did, via: 'invocation' },
    });
  });
});

describe('authenticate: a bare delegation', () => {
  it('authenticates only with the legacy fallback switched on', async () => {
    const user = await generateKeypair();
    const headers = new Headers({
      'x-ucan-delegation': await delegation(user.signer, nowSeconds() + 3600),
    });
    expect(await authenticate(headers, CFG)).toEqual({
      ok: false,
      status: 401,
      error: INVOCATION_REQUIRED_ERROR,
    });
    expect(
      await authenticate(headers, { ...CFG, allowBareDelegation: true }),
    ).toMatchObject({
      ok: true,
      auth: { userDid: user.did, via: 'delegation' },
    });
  });

  it('refuses an invalid bare delegation even with the fallback on', async () => {
    const outcome = await authenticate(
      new Headers({ 'x-ucan-delegation': 'garbage' }),
      { ...CFG, allowBareDelegation: true },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/^Invalid UCAN delegation:/);
  });
});

describe('authenticate: did:ixo key resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks Blocksync once for an issuer across invocations within the cache TTL', async () => {
    const user = await generateKeypair();
    const userDid = 'did:ixo:ixo1resolvercache';
    // A URL no other test uses: the resolver is shared per URL per isolate.
    const blocksyncUri = 'https://blocksync-cache.invalid/graphql';
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requests.push(String(input instanceof Request ? input.url : input));
      return Response.json({
        data: {
          iids: {
            nodes: [
              {
                id: userDid,
                verificationMethod: [
                  {
                    id: `${userDid}#key-1`,
                    type: 'Ed25519VerificationKey2018',
                    controller: userDid,
                    publicKeyMultibase: user.did.slice('did:key:'.length),
                  },
                ],
              },
            ],
          },
        },
      });
    });
    const signer = user.signer.withDID(userDid);
    const cfg = { oracleDid: ORACLE_DID, blocksyncUri };
    const first = await invocation(signer, { expiration: nowSeconds() + 300 });
    const second = await invocation(signer, {
      expiration: nowSeconds() + 301,
    });
    expect(first).not.toBe(second);

    for (const token of [first, second]) {
      expect(await authenticate(ucan(token), cfg)).toEqual({
        ok: true,
        auth: {
          userDid,
          via: 'invocation',
          delegation: undefined,
          delegationExpiration: undefined,
        },
      });
    }
    expect(requests).toEqual([blocksyncUri]);
  });
});

describe('isExcluded', () => {
  const exclusions = [
    { path: '/health', method: 'ALL' },
    { path: '/health/*', method: 'ALL' },
    { path: '/matrix/status', method: 'GET' },
    { path: '/plugin/:id/hook', method: 'POST' },
  ];

  it('matches exact paths, wildcards and :param segments, per method', () => {
    expect(isExcluded('GET', '/health', exclusions)).toBe(true);
    expect(isExcluded('POST', '/health/', exclusions)).toBe(true);
    expect(isExcluded('GET', '/health/matrix', exclusions)).toBe(true);
    expect(isExcluded('GET', '/matrix/status', exclusions)).toBe(true);
    expect(isExcluded('POST', '/matrix/status', exclusions)).toBe(false);
    expect(isExcluded('post', '/plugin/abc/hook', exclusions)).toBe(true);
    expect(isExcluded('POST', '/plugin/abc/def/hook', exclusions)).toBe(false);
  });

  it('does not let a prefix or a lookalike path through', () => {
    expect(isExcluded('GET', '/healthz', exclusions)).toBe(false);
    expect(isExcluded('GET', '/matrix/status/extra', exclusions)).toBe(false);
    expect(isExcluded('GET', '/debug/matrix/stop', exclusions)).toBe(false);
  });
});
