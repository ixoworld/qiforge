/**
 * Test support for the chain REST kinds: a stubbed REST gateway answering
 * recorded routes, a kind context over it, and a runner for a kind's plan.
 * Lives under `fixtures/` so it is not published.
 */
import { vi } from 'vitest';
import { ibcDenomTable, resetDenomMetadataCache } from '../../../denoms';
import {
  TOOL_BUDGET_MS,
  resetUpstreamHealth,
  type ChainCall,
} from '../../../http';
import { callContexts } from '../../../lookup';
import type { KindContext, KindDef, KindResult } from '../../types';
import { resetChainKindCaches } from '../shared';
import upayMetadata from './metadata-upay.json';

export const REST = 'https://rest.test/rest';
/** Michael's mainnet account, the fixtures' subject. */
export const MICHAEL = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
/** The DenomMetadata route of `upay` (the PAY liquid staking token). */
export const UPAY_METADATA =
  '/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=upay';
export const upayRoute = { [UPAY_METADATA]: upayMetadata };

/** A non-200 answer for a route. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown = {},
  ) {}
}
export const reply = (status: number, body?: unknown) =>
  new Reply(status, body);

/**
 * A fetch answering each path (query included) under {@link REST} with its
 * route: a JSON body (200) or a {@link Reply}. Any other path answers 418,
 * which `rest.ts` neither retries nor reads as "none".
 */
export function chainFetch(routes: Record<string, unknown>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const path = url.startsWith(REST) ? url.slice(REST.length) : url;
    if (!(path in routes)) return new Response('{}', { status: 418 });
    const route = routes[path];
    const { status, body } =
      route instanceof Reply ? route : { status: 200, body: route };
    return new Response(JSON.stringify(body), { status });
  });
}

/** The paths (query included) `fetcher` asked for, in order. */
export function pathsOf(fetcher: { mock: { calls: unknown[][] } }): string[] {
  return fetcher.mock.calls.map(([input]) => String(input).slice(REST.length));
}

/**
 * A kind context over `fetcher`, as the executor builds it (the network's
 * IBC table unless `ibcDenoms` overrides it): the user is Michael unless
 * `address` says otherwise (null: no account); `signal` and `deadline`
 * default to a fresh signal and the full tool budget.
 */
export function contextOf(
  fetcher: typeof fetch,
  options: {
    address?: string | null;
    first?: number;
    network?: ChainCall['network'];
    ibcDenoms?: unknown;
    signal?: AbortSignal;
    deadline?: number;
  } = {},
): KindContext {
  const address = options.address === undefined ? MICHAEL : options.address;
  const did = address ? `did:ixo:${address}` : 'did:key:z6MkTest';
  const call: ChainCall = {
    network: options.network ?? 'mainnet',
    restUrl: REST,
    blocksyncUrl: 'https://blocksync.test/graphql',
    user: did,
    deadline: options.deadline ?? Date.now() + TOOL_BUDGET_MS,
    signal: options.signal ?? new AbortController().signal,
    fetch: fetcher,
  };
  return callContexts(
    call,
    { did, address },
    { ibcDenoms: ibcDenomTable(call.network, options.ibcDenoms) },
  )(options.first ?? 10);
}

/** Runs a chain kind's plan; throws when the kind refuses the arguments. */
export async function run(
  kind: KindDef,
  args: unknown,
  ctx: KindContext,
): Promise<KindResult> {
  const plan = kind.plan(args, ctx);
  if ('invalid' in plan) throw new Error(`refused: ${plan.invalid}`);
  if (plan.source !== 'chain')
    throw new Error(`${kind.name} is not a chain kind`);
  return plan.run();
}

/** Why the kind refuses `args`, or null when it accepts them. */
export function refusal(
  kind: KindDef,
  args: unknown,
  ctx: KindContext,
): string | null {
  const plan = kind.plan(args, ctx);
  return 'invalid' in plan ? plan.invalid : null;
}

/** Forgets every per-isolate cache and upstream mark between tests. */
export function resetChainState(): void {
  resetChainKindCaches();
  resetDenomMetadataCache();
  resetUpstreamHealth();
}

/** The failure `rest.ts` gives an HTTP 500 (not retried). */
export const HTTP_500_FAILURE = {
  ok: false,
  reason: 'unavailable',
  detail: 'The chain node is unavailable right now (HTTP 500).',
  retryable: true,
};
