import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECONOMICS_TTL_MS, networkEconomicsKind } from './economics';
import epochs from './fixtures/epochs.json';
import {
  HTTP_500_FAILURE,
  chainFetch,
  contextOf,
  pathsOf,
  refusal,
  reply,
  resetChainState,
  run,
} from './fixtures/context';
import provisions from './fixtures/mint-epoch-provisions.json';
import mintParams from './fixtures/mint-params.json';

const PARAMS = '/ixo/mint/v1beta1/params';
const PROVISIONS = '/ixo/mint/v1beta1/epoch_provisions';
const EPOCHS = '/ixo/epochs/v1beta1/epochs';
const routes = (overrides: Record<string, unknown> = {}) => ({
  [PARAMS]: mintParams,
  [PROVISIONS]: provisions,
  [EPOCHS]: epochs,
  ...overrides,
});
const ixoCoin = (amount: string, amountBaseUnits: string) => ({
  amount,
  symbol: 'IXO',
  denom: 'uixo',
  amountBaseUnits,
  verified: true,
});

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('network_economics', () => {
  it('takes no arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(networkEconomicsKind, {}, ctx)).toBeNull();
    expect(refusal(networkEconomicsKind, undefined, ctx)).toBeNull();
    expect(refusal(networkEconomicsKind, { network: 'mainnet' }, ctx)).toMatch(
      /^Invalid args for kind "network_economics"/,
    );
  });

  it('shows the provisions, the next reduction and the split (recorded mainnet answers)', async () => {
    const fetcher = chainFetch(routes());
    const result = await run(
      networkEconomicsKind,
      {},
      contextOf(fetcher, { address: null }),
    );
    expect(pathsOf(fetcher)).toEqual([PARAMS, PROVISIONS, EPOCHS]);
    expect(result).toEqual({
      ok: true,
      data: {
        mintDenom: 'uixo',
        epoch: {
          identifier: 'day',
          length: '1 day',
          current: '688',
          startedAt: '2026-10-29T05:09:01.539486940Z',
        },
        provisionsPerEpoch: ixoCoin('28999.999999', '28999999999'),
        reduction: {
          factor: '0.666666666666666666',
          cutPercent: '33.33%',
          everyEpochs: '365',
          // Epoch 1 started minting and epoch 366 made the one cut so far
          // (43,500 → 29,000 IXO a day): the next is at the end of epoch 731.
          next: {
            epoch: '731',
            around: '2026-12-12T05:09:01.539Z',
            provisionsAfter: ixoCoin('19333.333333', '19333333333'),
          },
        },
        distribution: {
          staking: '100%',
          impactRewards: '0%',
          communityPool: '0%',
        },
        distributionStartEpoch: '1',
      },
    });
  });

  it('leaves the next reduction out when the parameters do not reproduce the current provisions', async () => {
    const result = await run(
      networkEconomicsKind,
      {},
      contextOf(
        chainFetch(
          routes({
            [PROVISIONS]: {
              epoch_provisions: '30000000000.000000000000000000',
            },
          }),
        ),
      ),
    );
    expect(result.ok && result.data).toMatchObject({
      provisionsPerEpoch: ixoCoin('30000', '30000000000'),
      reduction: { factor: '0.666666666666666666', everyEpochs: '365' },
    });
    expect(result.ok && result.data).not.toHaveProperty('reduction.next');
  });

  it('keeps all three reads for 10 minutes', async () => {
    const fetcher = chainFetch(routes());
    await run(networkEconomicsKind, {}, contextOf(fetcher));
    await run(networkEconomicsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher)).toHaveLength(3);
    vi.setSystemTime(Date.now() + ECONOMICS_TTL_MS + 1);
    await run(networkEconomicsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher)).toHaveLength(6);
  });

  it('shares a read in flight between calls', async () => {
    const fetcher = chainFetch(routes());
    await Promise.all([
      run(networkEconomicsKind, {}, contextOf(fetcher)),
      run(networkEconomicsKind, {}, contextOf(fetcher)),
    ]);
    expect(pathsOf(fetcher)).toHaveLength(3);
  });

  it('passes a failure of any read through and does not keep it', async () => {
    for (const broken of [PARAMS, PROVISIONS, EPOCHS]) {
      resetChainState();
      expect(
        await run(
          networkEconomicsKind,
          {},
          contextOf(chainFetch(routes({ [broken]: reply(500) }))),
        ),
      ).toEqual(HTTP_500_FAILURE);
    }
    // The last call kept the two reads that succeeded, not the failed one.
    const fetcher = chainFetch(routes());
    expect(
      await run(networkEconomicsKind, {}, contextOf(fetcher)),
    ).toMatchObject({ ok: true });
    expect(pathsOf(fetcher)).toEqual([EPOCHS]);
  });
});
