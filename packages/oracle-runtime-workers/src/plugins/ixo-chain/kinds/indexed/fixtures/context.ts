/**
 * Test helpers for the indexed kinds: identities, a kind context whose
 * only chain reads are denom metadata, and the plan or refusal a request
 * gets.
 */
import type { UserIdentity } from '../../../../../core/user-identity';
import { ibcDenomTable } from '../../../denoms';
import type { ChainCall } from '../../../http';
import { callContexts } from '../../../lookup';
import upayMetadata from '../../chain/fixtures/metadata-upay.json';
import type { KindContext, KindDef, KindPlan, KindResult } from '../../types';

const REST = 'https://rest.test/rest';
/** The DenomMetadata route of `upay` (the PAY liquid staking token). */
const UPAY_METADATA = `${REST}/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=upay`;

/**
 * The chain as the indexed kinds see it (they read only denom displays):
 * `upay`'s recorded metadata (PAY, 6 decimals); anything else answers 404,
 * so any other denom has no metadata or trace.
 */
async function metadataOnly(input: RequestInfo | URL): Promise<Response> {
  return String(input) === UPAY_METADATA
    ? new Response(JSON.stringify(upayMetadata), { status: 200 })
    : new Response('{}', { status: 404 });
}

export const ADDRESS = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
export const USER: UserIdentity = {
  did: `did:ixo:${ADDRESS}`,
  address: ADDRESS,
};
/** Another account (its bech32 checksum valid: account arguments verify it). */
export const OTHER = 'ixo1x4p6j0h3mzv8e7mhd6q9wquh2vqd9yh5n8r6gq';
export const NO_ADDRESS: UserIdentity = {
  did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  address: null,
};
/** An address carrying GraphQL syntax: refused before any document is built. */
export const INJECTION = `${ADDRESS}" } }) { nodes { secret } } x: claims(filter: { a: "`;

export function contextOf(
  identity: UserIdentity = USER,
  first = 10,
  network: ChainCall['network'] = 'mainnet',
): KindContext {
  const call: ChainCall = {
    network,
    restUrl: REST,
    blocksyncUrl: 'https://blocksync.test/graphql',
    user: identity.did,
    deadline: Date.now() + 20_000,
    signal: new AbortController().signal,
    fetch: metadataOnly,
  };
  return callContexts(call, identity, {
    ibcDenoms: ibcDenomTable(network, undefined),
  })(first);
}

type BlocksyncPlan = Extract<KindPlan, { source: 'blocksync' }>;

/** The kind's Blocksync plan for `args`; throws when it refuses them. */
export function planOf(
  kind: KindDef,
  args: unknown,
  ctx: KindContext = contextOf(),
): BlocksyncPlan {
  const plan = kind.plan(args, ctx);
  if ('invalid' in plan) throw new Error(`refused: ${plan.invalid}`);
  if (plan.source !== 'blocksync') throw new Error('not a Blocksync plan');
  return plan;
}

/** Why the kind refuses `args`; throws when it plans them. */
export function refusalOf(
  kind: KindDef,
  args: unknown,
  ctx: KindContext = contextOf(),
): string {
  const plan = kind.plan(args, ctx);
  if (!('invalid' in plan)) throw new Error('expected a refusal');
  return plan.invalid;
}

/** The `ok` answer `raw` shapes to; throws on a failure. */
export async function answerOf(plan: BlocksyncPlan, raw: unknown) {
  const result: KindResult = await plan.shape(raw);
  if (!result.ok) throw new Error(`failed: ${result.detail}`);
  return result;
}

/** The failure `raw` shapes to; throws on an answer. */
export async function failureOf(plan: BlocksyncPlan, raw: unknown) {
  const result: KindResult = await plan.shape(raw);
  if (result.ok) throw new Error('expected a failure');
  return result;
}

/** A string of `length` characters, for the clipping tests. */
export const long = (length: number, char = 'x') => char.repeat(length);
