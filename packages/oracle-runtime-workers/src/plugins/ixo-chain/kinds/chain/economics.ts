/**
 * `network_economics`: how new IXO is minted. The x/mint parameters, the
 * provisions the chain mints this epoch and the epoch clock, each from a
 * 10 min per-isolate cache.
 */
import { z } from 'zod';
import { defineKind, type KindContext, type KindResult } from '../types';
import { displayCoin } from '../coins';
import { clip } from '../../summaries';
import {
  DEC_ONE,
  ReadCache,
  decMul,
  decPercent,
  durationText,
  failed,
  parseDec,
  sharePercent,
} from './shared';

/** Mint parameters, provisions and epochs are reused for 10 min. */
export const ECONOMICS_TTL_MS = 600_000;
/** Reductions replayed at most when checking the schedule (one per period; mainnet has had one). */
const MAX_REDUCTIONS = 1_000n;

const paramsResponse = z.object({
  params: z.object({
    mint_denom: z.string(),
    genesis_epoch_provisions: z.string(),
    epoch_identifier: z.string(),
    reduction_period_in_epochs: z.string(),
    reduction_factor: z.string(),
    distribution_proportions: z.object({
      staking: z.string(),
      impact_rewards: z.string(),
      community_pool: z.string(),
    }),
    minting_rewards_distribution_start_epoch: z.string(),
  }),
});
const provisionsResponse = z.object({ epoch_provisions: z.string() });
const epochsResponse = z.object({
  epochs: z.array(
    z.object({
      identifier: z.string(),
      duration: z.string(),
      current_epoch: z.string(),
      current_epoch_start_time: z.string(),
      epoch_counting_started: z.boolean(),
    }),
  ),
});

type Params = z.infer<typeof paramsResponse>['params'];
type Epoch = z.infer<typeof epochsResponse>['epochs'][number];

const params = new ReadCache<z.infer<typeof paramsResponse>>(
  ECONOMICS_TTL_MS,
  8,
);
const provisions = new ReadCache<z.infer<typeof provisionsResponse>>(
  ECONOMICS_TTL_MS,
  8,
);
const epochs = new ReadCache<z.infer<typeof epochsResponse>>(
  ECONOMICS_TTL_MS,
  8,
);

const cached = <S extends z.ZodType>(
  cache: ReadCache<z.infer<S>>,
  ctx: KindContext,
  path: string,
  schema: S,
  label: string,
) => cache.get(ctx, path, () => ctx.rest(path, schema, { label }));

const COUNT = /^\d{1,12}$/;

/**
 * The next provisions reduction. x/mint cuts the provisions by
 * `reduction_factor` at the end of the epoch `start + n × period`
 * (`start` = the distribution start epoch); the chain does not expose
 * the epoch of the last cut, so the schedule is replayed from the
 * genesis provisions with the chain's own decimal rounding and used only
 * when it reproduces exactly the provisions the chain reports now (a
 * parameter changed by governance on the way would not). Null otherwise,
 * or before minting started.
 */
function nextReduction(
  values: Params,
  current: bigint,
  epoch: Epoch,
): { epoch: string; around: string | null; provisionsAfter: bigint } | null {
  const genesis = parseDec(values.genesis_epoch_provisions);
  const factor = parseDec(values.reduction_factor);
  const count = (value: string) => (COUNT.test(value) ? BigInt(value) : null);
  const start = count(values.minting_rewards_distribution_start_epoch);
  const period = count(values.reduction_period_in_epochs);
  const now = count(epoch.current_epoch);
  if (
    genesis === null ||
    factor === null ||
    start === null ||
    period === null ||
    now === null
  )
    return null;
  // The epoch in progress has not ended: the last one ended is now − 1.
  const lastEnded = now - 1n;
  if (period <= 0n || !epoch.epoch_counting_started || lastEnded < start)
    return null;
  const cuts = (lastEnded - start) / period;
  if (cuts > MAX_REDUCTIONS) return null;
  let expected = genesis;
  for (let n = 0n; n < cuts; n += 1n) expected = decMul(expected, factor);
  if (expected !== current) return null;
  const target = start + (cuts + 1n) * period;
  const seconds = /^(\d{1,12})s$/.exec(epoch.duration)?.[1];
  const startedAt = Date.parse(epoch.current_epoch_start_time);
  // The reduction runs when the target epoch ends.
  const around =
    seconds && Number.isFinite(startedAt)
      ? new Date(
          startedAt + Number((target - now + 1n) * BigInt(seconds)) * 1000,
        ).toISOString()
      : null;
  return {
    epoch: target.toString(),
    around,
    provisionsAfter: decMul(current, factor),
  };
}

export const networkEconomicsKind = defineKind({
  name: 'network_economics',
  summary:
    'How new IXO is minted: provisions per epoch, the next reduction, where it goes.',
  explain: [
    'IXO inflation (x/mint): at the end of every epoch (`epoch.identifier`, e.g. "day", each `epoch.length`) the chain mints `provisionsPerEpoch` new IXO and splits it by `distribution` (staking rewards to delegators, impact rewards, the community pool).',
    'Every `reduction.everyEpochs` epochs the provisions are multiplied by `reduction.factor` (a cut of `reduction.cutPercent`). `reduction.next` gives the epoch of the next cut, roughly when (`around`, the end of that epoch) and the provisions after it; it is left out when the current parameters do not reproduce the provisions the chain reports (e.g. after a governance change), so it is never a guess.',
    'Amounts are display units (`amount` + `symbol`) with `amountBaseUnits` (fractions of a base unit dropped).',
  ].join('\n'),
  source: 'chain',
  list: false,
  args: z.strictObject({}),
  example: {},
  plan(_input, ctx) {
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const [paramsRead, provisionsRead, epochsRead] = await Promise.all([
          cached(
            params,
            ctx,
            '/ixo/mint/v1beta1/params',
            paramsResponse,
            'mint params',
          ),
          cached(
            provisions,
            ctx,
            '/ixo/mint/v1beta1/epoch_provisions',
            provisionsResponse,
            'epoch provisions',
          ),
          cached(
            epochs,
            ctx,
            '/ixo/epochs/v1beta1/epochs',
            epochsResponse,
            'epochs',
          ),
        ]);
        if (!paramsRead.ok) return failed(paramsRead.failure);
        if (!provisionsRead.ok) return failed(provisionsRead.failure);
        if (!epochsRead.ok) return failed(epochsRead.failure);
        const values = paramsRead.value.params;
        const denom = values.mint_denom;
        const current = parseDec(provisionsRead.value.epoch_provisions);
        const epoch = epochsRead.value.epochs.find(
          (entry) => entry.identifier === values.epoch_identifier,
        );
        const coin = (scaled: bigint) =>
          displayCoin(ctx, { denom, amount: (scaled / DEC_ONE).toString() });
        const next =
          current !== null && epoch
            ? nextReduction(values, current, epoch)
            : null;
        const factor = parseDec(values.reduction_factor);
        const split = values.distribution_proportions;
        return {
          ok: true,
          data: {
            mintDenom: clip(denom, 60),
            ...(epoch
              ? {
                  epoch: {
                    identifier: clip(epoch.identifier, 40),
                    length: durationText(epoch.duration),
                    current: epoch.current_epoch,
                    startedAt: epoch.current_epoch_start_time,
                  },
                }
              : {}),
            ...(current !== null
              ? { provisionsPerEpoch: await coin(current) }
              : {}),
            reduction: {
              factor: clip(values.reduction_factor, 30),
              ...(factor !== null && factor <= DEC_ONE
                ? { cutPercent: sharePercent(DEC_ONE - factor, DEC_ONE) }
                : {}),
              everyEpochs: values.reduction_period_in_epochs,
              ...(next
                ? {
                    next: {
                      epoch: next.epoch,
                      around: next.around,
                      provisionsAfter: await coin(next.provisionsAfter),
                    },
                  }
                : {}),
            },
            distribution: {
              staking: decPercent(split.staking),
              impactRewards: decPercent(split.impact_rewards),
              communityPool: decPercent(split.community_pool),
            },
            distributionStartEpoch:
              values.minting_rewards_distribution_start_epoch,
          },
        };
      },
    };
  },
});
