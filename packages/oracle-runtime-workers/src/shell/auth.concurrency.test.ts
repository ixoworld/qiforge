/**
 * `authenticate` under concurrency: one invocation is a bearer token reusable
 * until it expires, so simultaneous requests carrying it all succeed and its
 * signature chain is verified once; a failure is shared only with the callers
 * that were waiting on that verification.
 */
import * as ucan from '@ixo/ucan';
import {
  createInvocation,
  defineCapability,
  generateKeypair,
  serializeInvocation,
  type CreateValidatorOptions,
  type Signer,
} from '@ixo/ucan';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from './auth';

const validatorOptions: CreateValidatorOptions[] = [];

vi.mock('@ixo/ucan', async (importOriginal) => {
  const actual = await importOriginal<typeof ucan>();
  return {
    ...actual,
    createUCANValidator: (options: CreateValidatorOptions) => {
      validatorOptions.push(options);
      return actual.createUCANValidator(options);
    },
  };
});

const ORACLE_DID = (await generateKeypair()).did;
const CFG = {
  oracleDid: ORACLE_DID,
  blocksyncUri: 'https://blocksync.invalid/graphql',
};
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function invocation(issuer: Signer, expiration: number) {
  return serializeInvocation(
    await createInvocation({
      issuer,
      audience: ORACLE_DID,
      capability: { can: '*', with: 'ixo:oracle' },
      proofs: [],
      expiration,
    }),
  );
}

const headers = (token: string) =>
  new Headers({ authorization: `Bearer ${token}`, 'x-auth-type': 'ucan' });

beforeEach(() => {
  validatorOptions.length = 0;
});

describe('authenticate: one invocation on concurrent requests', () => {
  it('accepts every concurrent request and verifies the token once', async () => {
    const user = await generateKeypair();
    const token = await invocation(user.signer, nowSeconds() + 300);

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => authenticate(headers(token), CFG)),
    );

    for (const outcome of outcomes) {
      expect(outcome.ok && outcome.auth.userDid).toBe(user.did);
    }
    expect(validatorOptions).toHaveLength(1);
  });

  it('accepts the token again when it is verified a second time (verdict no longer cached)', async () => {
    const user = await generateKeypair();
    const token = await invocation(user.signer, nowSeconds() + 300);
    const first = await authenticate(headers(token), CFG);
    expect(first.ok).toBe(true);
    expect(validatorOptions).toHaveLength(1);

    // A cache miss for this token builds a validator with these same options.
    const options = validatorOptions[0];
    if (!options) throw new Error('no validator was built');
    const { createUCANValidator } =
      await vi.importActual<typeof ucan>('@ixo/ucan');
    const again = await (
      await createUCANValidator(options)
    ).validate(
      token,
      defineCapability({ can: '*', protocol: 'ixo:' }),
      'ixo:oracle',
    );

    expect(again.ok).toBe(true);
    expect(again.invoker).toBe(user.did);
  });

  it('fails an expired token for every waiting caller, and verifies it anew afterwards', async () => {
    const user = await generateKeypair();
    const token = await invocation(user.signer, nowSeconds() - 1);

    const outcomes = await Promise.all([
      authenticate(headers(token), CFG),
      authenticate(headers(token), CFG),
    ]);
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ ok: false, status: 401 });
    expect(validatorOptions).toHaveLength(1);

    const later = await authenticate(headers(token), CFG);
    expect(later.ok).toBe(false);
    expect(validatorOptions).toHaveLength(2);
  });

  it('fails a token signed by someone other than its issuer for every caller', async () => {
    const victim = await generateKeypair();
    const attacker = await generateKeypair();
    const token = await invocation(
      attacker.signer.withDID(victim.signer.did()),
      nowSeconds() + 300,
    );

    const outcomes = await Promise.all([
      authenticate(headers(token), CFG),
      authenticate(headers(token), CFG),
      authenticate(headers(token), CFG),
    ]);

    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ ok: false, status: 401 });
  });
});
