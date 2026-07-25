import { describe, expect, it } from 'vitest';
import { MAINNET_USDC_IBC_DENOM } from './types.js';
import { isEngagementExpired, isMatrixNotFound, priceToCoin } from './util.js';

describe('isEngagementExpired', () => {
  const NOW = new Date('2026-07-22T12:00:00.000Z');
  const intent = (expiresAt?: string) => ({
    intent: {
      txHash: 'INTENT-TX-1',
      submittedAt: '2026-07-22T10:00:00.000Z',
      ...(expiresAt !== undefined && { expiresAt }),
    },
  });

  it('is true once the deadline has passed', () => {
    expect(isEngagementExpired(intent('2026-07-22T11:59:59.999Z'), NOW)).toBe(
      true,
    );
    // The instant itself counts as gone: the escrow releases AT the deadline.
    expect(isEngagementExpired(intent('2026-07-22T12:00:00.000Z'), NOW)).toBe(
      true,
    );
  });

  it('is false while the deadline is still ahead', () => {
    expect(isEngagementExpired(intent('2026-07-22T12:00:00.001Z'), NOW)).toBe(
      false,
    );
  });

  it('treats an unknown deadline as still held, never as expired', () => {
    // Guessing "expired" would close a job whose escrow the chain still holds.
    expect(isEngagementExpired({}, NOW)).toBe(false);
    expect(isEngagementExpired(intent(), NOW)).toBe(false);
    expect(isEngagementExpired(intent('not a date'), NOW)).toBe(false);
  });
});

describe('priceToCoin', () => {
  it('uses uixo off mainnet, scaled by 1e6', () => {
    expect(priceToCoin(20, 'devnet')).toEqual({
      denom: 'uixo',
      amount: 20_000_000,
    });
  });

  it('uses the USDC IBC denom on mainnet', () => {
    expect(priceToCoin(20, 'mainnet')).toEqual({
      denom: MAINNET_USDC_IBC_DENOM,
      amount: 20_000_000,
    });
  });
});

describe('isMatrixNotFound', () => {
  // The two SDKs in the tree report the same HTTP response differently, and
  // the state manager throws the matrix-js-sdk one. Shapes are built by hand
  // rather than imported so a unit test does not pull a Matrix SDK in.
  it('recognises a matrix-js-sdk 404 (what MatrixStateManager throws)', () => {
    const error = Object.assign(
      new Error('MatrixError: [404] Event not found. (…/state/ixo.room.state)'),
      { errcode: 'M_NOT_FOUND', httpStatus: 404 },
    );

    expect(isMatrixNotFound(error)).toBe(true);
  });

  it('recognises a matrix-bot-sdk 404', () => {
    const error = Object.assign(new Error('M_NOT_FOUND: Not found'), {
      errcode: 'M_NOT_FOUND',
      statusCode: 404,
    });

    expect(isMatrixNotFound(error)).toBe(true);
  });

  it('does not treat a genuine failure as "not found"', () => {
    expect(isMatrixNotFound(new Error('socket hang up'))).toBe(false);
    expect(
      isMatrixNotFound(
        Object.assign(new Error('forbidden'), {
          errcode: 'M_FORBIDDEN',
          httpStatus: 403,
        }),
      ),
    ).toBe(false);
    expect(isMatrixNotFound(undefined)).toBe(false);
    expect(isMatrixNotFound('nope')).toBe(false);
  });
});
