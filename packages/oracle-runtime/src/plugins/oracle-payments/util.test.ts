import { describe, expect, it } from 'vitest';
import {
  claimDeepLink,
  creditsInChainText,
  formatCredits,
  grantedDenom,
  isEngagementExpired,
  isMatrixNotFound,
  microUnitsToCredits,
  priceToCoin,
  priceToCredits,
  resolveEvalEngineUrl,
  resolvePortalUrl,
} from './util.js';

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
  it('prices in the granted denom, scaled by 1e6', () => {
    expect(priceToCoin(20, 'upay')).toEqual({
      denom: 'upay',
      amount: 20_000_000,
    });
  });

  it('follows whatever denom the grant names — nothing is network-guessed', () => {
    expect(priceToCoin(20, 'uusdc')).toEqual({
      denom: 'uusdc',
      amount: 20_000_000,
    });
  });
});

describe('credits — the only money unit the user is quoted in', () => {
  it('prices a service in credits: 1 PAY ($1) is 100 credits', () => {
    expect(priceToCredits(20)).toBe(2000);
    expect(priceToCredits(0.5)).toBe(50);
  });

  it('reads a micro-unit chain amount as credits', () => {
    // 1 credit = 10_000 micro-units, whichever denom the grant names.
    expect(microUnitsToCredits('20000000')).toBe(2000);
    expect(microUnitsToCredits(10_000)).toBe(1);
  });

  it('rounds a micro-unit amount DOWN', () => {
    // A cap of 1_999_999 that reads as "2,000 credits" would tell the user
    // their limit covers a 2,000-credit job it in fact refuses.
    expect(microUnitsToCredits('19999999')).toBe(1999);
    expect(microUnitsToCredits('9999')).toBe(0);
  });

  it('is undefined for an amount that is not a number', () => {
    expect(microUnitsToCredits('not-a-number')).toBeUndefined();
  });

  it('formats credits for prose, singular and separated', () => {
    expect(formatCredits(1)).toBe('1 credit');
    expect(formatCredits(500)).toBe('500 credits');
    expect(formatCredits(20_000)).toBe('20,000 credits');
  });
});

describe('creditsInChainText', () => {
  it("rewrites the chain's micro-unit arithmetic as credits", () => {
    expect(
      creditsInChainText(
        'spendable balance 1000000upay is smaller than 20000000upay: insufficient funds',
        'upay',
      ),
    ).toBe(
      'spendable balance 100 credits is smaller than 2,000 credits: insufficient funds',
    );
  });

  it('follows the granted denom, whichever one the job is priced in', () => {
    expect(creditsInChainText('invalid coin 20000000uusdc', 'uusdc')).toBe(
      'invalid coin 2,000 credits',
    );
  });

  it('leaves amounts in any OTHER denom exactly as the chain wrote them', () => {
    // Converting a denom whose scale is unknown here would be guesswork, and a
    // wrong number is worse than an opaque one.
    expect(creditsInChainText('fee 500uixo too low', 'upay')).toBe(
      'fee 500uixo too low',
    );
  });

  it('passes text through untouched when the job has no denom', () => {
    expect(creditsInChainText('rpc down', '')).toBe('rpc down');
  });
});

describe('grantedDenom', () => {
  it('reads the denom the gate stamped on a start or engagement', () => {
    expect(grantedDenom({ priceUsd: 20, denom: 'upay' })).toBe('upay');
  });

  it('is undefined — the fail-closed signal — when absent or empty', () => {
    // A job without a granted denom must be refused, never priced by guess.
    expect(grantedDenom({ priceUsd: 20 })).toBeUndefined();
    expect(grantedDenom({ priceUsd: 20, denom: '' })).toBeUndefined();
  });
});

describe('resolvePortalUrl', () => {
  it('picks the portal deployed for the network', () => {
    expect(resolvePortalUrl(undefined, 'devnet')).toBe(
      'https://dev.portal.qi.space',
    );
    expect(resolvePortalUrl(undefined, 'testnet')).toBe(
      'https://test.portal.qi.space',
    );
    expect(resolvePortalUrl(undefined, 'mainnet')).toBe(
      'https://portal.qi.space',
    );
  });

  it('falls back to devnet when NETWORK is absent or unrecognised', () => {
    expect(resolvePortalUrl(undefined, undefined)).toBe(
      'https://dev.portal.qi.space',
    );
    expect(resolvePortalUrl(undefined, 'localnet')).toBe(
      'https://dev.portal.qi.space',
    );
  });

  it('prefers an explicit PORTAL_URL over the network default', () => {
    expect(resolvePortalUrl('https://portal.example', 'mainnet')).toBe(
      'https://portal.example',
    );
  });
});

describe('resolveEvalEngineUrl', () => {
  it('picks the engine deployed for the network', () => {
    expect(resolveEvalEngineUrl(undefined, 'devnet')).toBe(
      'https://dev.eval.ixo.earth',
    );
    expect(resolveEvalEngineUrl(undefined, 'testnet')).toBe(
      'https://test.eval.ixo.earth',
    );
    expect(resolveEvalEngineUrl(undefined, 'mainnet')).toBe(
      'https://eval.ixo.earth',
    );
  });

  it('falls back to devnet when NETWORK is absent or unrecognised', () => {
    // A devnet engine is the safe miss: an oracle must never read mainnet
    // contract records because its NETWORK was mistyped.
    expect(resolveEvalEngineUrl(undefined, undefined)).toBe(
      'https://dev.eval.ixo.earth',
    );
    expect(resolveEvalEngineUrl(undefined, 'MAINNET')).toBe(
      'https://dev.eval.ixo.earth',
    );
  });

  it('prefers an explicit EVAL_ENGINE_URL over the network default', () => {
    expect(resolveEvalEngineUrl('https://engine.example', 'mainnet')).toBe(
      'https://engine.example',
    );
  });
});

describe('claimDeepLink', () => {
  it('points at the claim page, trailing slash or not', () => {
    expect(claimDeepLink('https://portal.qi.space', 'claim-1')).toBe(
      'https://portal.qi.space/workspace/claims?claimId=claim-1',
    );
    expect(claimDeepLink('https://portal.qi.space/', 'claim-1')).toBe(
      'https://portal.qi.space/workspace/claims?claimId=claim-1',
    );
  });

  it('encodes a claim id that needs it', () => {
    expect(claimDeepLink('https://portal.qi.space', 'claim/1?x')).toBe(
      'https://portal.qi.space/workspace/claims?claimId=claim%2F1%3Fx',
    );
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
