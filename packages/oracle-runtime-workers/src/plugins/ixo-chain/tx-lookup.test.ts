import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_BUDGET_MS, resetUpstreamHealth, type ChainCall } from './http';
import { lookupTransaction } from './tx-lookup';

const HASH = 'AB'.repeat(32);

function callWith(fetcher: typeof fetch): ChainCall {
  return {
    network: 'devnet',
    restUrl: 'https://rest.test/rest/',
    blocksyncUrl: '',
    user: 'did:ixo:ixo1test',
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal: new AbortController().signal,
    fetch: fetcher,
  };
}

const OPTIONS = { label: 'test tx', tag: '[test]', wait: async () => {} };

/** A transaction answer as chain REST gives it, for `txhash`. */
const txAnswer = (txhash: string) =>
  new Response(
    JSON.stringify({
      tx: { body: { messages: [] } },
      tx_response: { txhash, height: '9', code: 0 },
    }),
  );

beforeEach(() => resetUpstreamHealth());
afterEach(() => vi.restoreAllMocks());

describe('lookupTransaction', () => {
  it.each([
    ['too short', 'AB'.repeat(31)],
    ['too long', `${HASH}A`],
    ['not hex', `${'AB'.repeat(31)}ZZ`],
    ['a path', `../../../bank/v1beta1/balances/${'A'.repeat(34)}`],
    ['a query', `${HASH}?x=1`],
    ['empty', ''],
  ])('refuses a hash that is %s without any request', async (_what, txHash) => {
    const fetcher = vi.fn(async () => txAnswer(HASH));
    await expect(
      lookupTransaction(callWith(fetcher), txHash, OPTIONS),
    ).resolves.toEqual({
      status: 'unavailable',
      retryable: false,
      message:
        'That is not a transaction hash (64 hex characters), so nothing was read from the chain.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a hash of 64 hex characters, in either case', async () => {
    for (const txHash of [HASH, HASH.toLowerCase()]) {
      const fetcher = vi.fn(async (_input: RequestInfo | URL) =>
        txAnswer(HASH),
      );
      await expect(
        lookupTransaction(callWith(fetcher), txHash, OPTIONS),
      ).resolves.toMatchObject({ status: 'found' });
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        `https://rest.test/rest/cosmos/tx/v1beta1/txs/${txHash}`,
      );
    }
  });
});
