import {
  createDelegation,
  generateKeypair,
  serializeDelegation,
} from '@ixo/ucan';
import { describe, expect, it, vi } from 'vitest';
import { reporterGrant } from './grant';
import { authenticate, validateDelegation } from '../shell/auth';

async function delegation(
  options: { wrongAudience?: boolean; expired?: boolean; broad?: boolean } = {},
) {
  const user = await generateKeypair();
  const oracle = await generateKeypair();
  const other = await generateKeypair();
  const expiration =
    Math.floor(Date.now() / 1000) + (options.expired ? -60 : 55);
  const raw = await serializeDelegation(
    await createDelegation({
      issuer: user.signer,
      audience: options.wrongAudience ? other.did : oracle.did,
      expiration,
      capabilities: options.broad
        ? [{ can: '*', with: 'ixo:filesystem' }]
        : [
            'fs/list' as const,
            'fs/read' as const,
            'fs/write' as const,
            'fs/delete' as const,
          ].map((can) => ({
            can,
            with: 'ixo:filesystem/.oracles',
            nb: { hidden: ['/.oracles'] },
          })),
    }),
  );
  return {
    user,
    oracle,
    other,
    raw,
    expiration,
    config: {
      oracleDid: oracle.did,
      blocksyncUri: 'https://never-fetched.example/graphql',
    },
  };
}
describe('Reporter local grants and raw delegation validation', () => {
  it('accepts only the bounded owner grant and rejects broader, missing and expired rights', async () => {
    const valid = await delegation();
    expect(
      await reporterGrant(
        JSON.stringify({
          userDid: valid.user.did,
          ucanDelegation: valid.raw,
          ucanDelegationExpiration: valid.expiration,
        }),
      ),
    ).not.toBeNull();
    for (const options of [{ broad: true }, { expired: true }]) {
      const invalid = await delegation(options);
      expect(
        await reporterGrant(
          JSON.stringify({
            userDid: invalid.user.did,
            ucanDelegation: invalid.raw,
            ucanDelegationExpiration: invalid.expiration,
          }),
        ),
      ).toBeNull();
    }
    expect(
      await reporterGrant(JSON.stringify({ userDid: valid.user.did })),
    ).toBeNull();
  });
  it('cryptographically rejects malformed, expired and wrong-audience bytes before deposit', async () => {
    const valid = await delegation();
    expect((await validateDelegation(valid.raw, valid.config)).ok).toBe(true);
    expect((await validateDelegation('forged-token', valid.config)).ok).toBe(
      false,
    );
    const expired = await delegation({ expired: true });
    expect((await validateDelegation(expired.raw, expired.config)).ok).toBe(
      false,
    );
    const wrong = await delegation({ wrongAudience: true });
    expect((await validateDelegation(wrong.raw, wrong.config)).ok).toBe(false);
  });
  it('binds cached authentication to the oracle audience', async () => {
    const valid = await delegation();
    const headers = new Headers({ 'x-ucan-delegation': valid.raw });
    expect((await authenticate(headers, valid.config)).ok).toBe(true);
    expect(
      (
        await authenticate(headers, {
          ...valid.config,
          oracleDid: valid.other.did,
        })
      ).ok,
    ).toBe(false);
  });
});

it('preserves request-local authority through background awaits without reading Portal grants', async () => {
  const { ReporterAuthority } = await import('./grant');
  const authority = new ReporterAuthority();
  const shared = vi.fn(() => 'portal-grant');
  let continueWork = () => {};
  const pending = new Promise<void>((resolve) => {
    continueWork = resolve;
  });
  const work = authority.run({ raw: 'reporter-grant' }, async () => {
    await pending;
    expect(authority.ownerDelegation(shared)).toBe('reporter-grant');
    await Promise.resolve();
    expect(authority.ownerDelegation(shared)).toBe('reporter-grant');
  });
  expect(authority.ownerDelegation(shared)).toBe('portal-grant');
  shared.mockClear();
  continueWork();
  await work;
  expect(shared).not.toHaveBeenCalled();
  expect(authority.ownerDelegation(shared)).toBe('portal-grant');
});
