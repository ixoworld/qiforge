import { describe, expect, it } from 'vitest';
import { isExpiredIntentFailure } from './claim-lane.js';

/**
 * The wordings come from the chain itself (`x/claims`): `ErrIntentNotFound`
 * and the invalid-request wrap `SubmitClaim` raises when the intent it found is
 * past its deadline. Both reach the runtime as free text — inside a tx
 * `rawLog`, or inside the error the wallet client's pre-broadcast simulate
 * throws — so text is what the matcher has to work with.
 */
describe('isExpiredIntentFailure', () => {
  it('matches a claim refused because the reservation is no longer held', () => {
    expect(
      isExpiredIntentFailure(
        'failed to execute message; message index: 0: for agent ixo1abc and collection 42: intent not found',
      ),
    ).toBe(true);
  });

  it('matches a claim refused because the reservation is past its deadline', () => {
    expect(
      isExpiredIntentFailure(
        'failed to execute message; message index: 0: intent ixo1abc/42/1 is expired: invalid request',
      ),
    ).toBe(true);
  });

  it('matches the same wording wrapped in a simulate rejection', () => {
    expect(
      isExpiredIntentFailure(
        'Query failed with (6): rpc error: code = Unknown desc = intent not found',
      ),
    ).toBe(true);
  });

  it('never matches an unrelated chain refusal', () => {
    // These must keep the ordinary lane: engagement stays active, the signed
    // claim resumes at submission on the next attempt.
    expect(isExpiredIntentFailure('out of gas')).toBe(false);
    expect(isExpiredIntentFailure('insufficient funds')).toBe(false);
    expect(
      isExpiredIntentFailure('authorization not found for submit claim'),
    ).toBe(false);
    expect(isExpiredIntentFailure('')).toBe(false);
  });

  it('never matches the reservation lane refusing a SECOND reservation', () => {
    // `ErrIntentExists` says an intent is very much alive — the opposite
    // situation, and treating it as expiry would re-reserve in a loop.
    expect(isExpiredIntentFailure('active intent found')).toBe(false);
  });
});
