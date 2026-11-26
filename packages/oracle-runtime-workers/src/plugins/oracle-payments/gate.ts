import type { Coin } from '../../chain';
import type { RuntimeContext } from '../../plugin-api/types';
import { readOwnAgreement, type AgreedService } from './agreement';
import { getCollectionInfo, listSubmitGrants } from './chain-reads';
import { MICRO_USD_PER_USD, type ResolvedPaymentsEnv } from './config';
export type { AgreedService };

export type GateFailureReason =
  | 'not_contracted'
  | 'service_not_contracted'
  | 'quota_exhausted'
  | 'max_amount_too_low'
  | 'intents_not_allowed'
  | 'contract_check_failed';

export interface GatePass {
  ok: true;
  collectionId: string;
  /** Collection admin — the claim's `adminAddress`. */
  admin: string;
  /** The deed's homeserver; decides the claim bot. */
  homeServer: string | null;
  service: AgreedService;
  /** What the job escrows: the AGREED price, in the payment denom. */
  amount: Coin;
  intentDurationSeconds: number;
}

export interface GateFailure {
  ok: false;
  reason: GateFailureReason;
  detail: string;
}

export type GateResult = GatePass | GateFailure;

/** `did:ixo:ixo1…` → `ixo1…`; null for any other DID method. */
export function addressOfDid(did: string): string | null {
  const m = /^did:ixo:(ixo1[0-9a-z]+)$/.exec(did);
  return m?.[1] ?? null;
}

/** The evaluator's own match: exact `id`, or `name` trimmed and case-insensitive. */
function matchService(
  services: readonly AgreedService[],
  serviceId: string,
): AgreedService | undefined {
  const key = serviceId.trim().toLowerCase();
  return (
    services.find((s) => s.id === serviceId) ??
    services.find((s) => s.name.trim().toLowerCase() === key)
  );
}

function maxFor(maxAmount: readonly Coin[], denom: string): bigint | null {
  const coin = maxAmount.find((c) => c.denom === denom);
  return coin ? BigInt(coin.amount) : null;
}

/**
 * May this oracle start paid work for `senderDid` on `serviceId`? Every
 * answer comes from sources the requester cannot write:
 *
 *  1. chain — this oracle's `SubmitClaimAuthorization` grants (collection,
 *     quota, max amount, intent window);
 *  2. Blocksync — the collection's deed must belong to the sender (a
 *     subscription deed links them as its `user`, or they own the deed);
 *  3. decision-engine — the buyer's agreement for this oracle must list the
 *     service; its price is what gets escrowed.
 *
 * Never throws: a lookup failure is `contract_check_failed`.
 */
export async function checkContract(input: {
  ctx: RuntimeContext;
  env: ResolvedPaymentsEnv;
  oracleAddress: string;
  senderDid: string;
  serviceId: string;
}): Promise<GateResult> {
  const { ctx, env, oracleAddress, senderDid, serviceId } = input;
  const sender = addressOfDid(senderDid);
  if (!sender) {
    return {
      ok: false,
      reason: 'not_contracted',
      detail: `The requester (${senderDid}) is not an ixo account.`,
    };
  }
  try {
    const grants = await listSubmitGrants(env.restUrl, oracleAddress);
    const collectionIds = [...new Set(grants.map((g) => g.collectionId))];
    const infos = await Promise.all(
      collectionIds.map((id) => getCollectionInfo(env.blocksyncUrl, id)),
    );
    const mine = infos.filter(
      (info) =>
        info !== null &&
        (info.owner === sender || info.linkedUsers.includes(sender)),
    );
    if (mine.length === 0) {
      return {
        ok: false,
        reason: 'not_contracted',
        detail:
          'The user has not authorised this oracle on any claim collection of theirs.',
      };
    }
    let lastFailure: GateFailure | null = null;
    for (const info of mine) {
      if (!info) continue;
      if (info.intents === 1) {
        lastFailure = {
          ok: false,
          reason: 'intents_not_allowed',
          detail: `Collection ${info.id} does not allow payment reservations.`,
        };
        continue;
      }
      const agreement = await readOwnAgreement(
        ctx,
        env.decisionEngineUrl,
        info.id,
        oracleAddress,
      );
      if (!agreement.ok) {
        lastFailure = {
          ok: false,
          reason:
            agreement.reason === 'no_agreement'
              ? 'not_contracted'
              : 'contract_check_failed',
          detail: agreement.detail,
        };
        continue;
      }
      const service = matchService(agreement.doc.services, serviceId);
      if (!service) {
        lastFailure = {
          ok: false,
          reason: 'service_not_contracted',
          detail: `The agreement covers ${agreement.doc.services
            .map((s) => `"${s.name}" (${s.id})`)
            .join(', ')}, not "${serviceId}".`,
        };
        continue;
      }
      const amount: Coin = {
        denom: env.denom,
        amount: String(Math.round(service.priceUsd * MICRO_USD_PER_USD)),
      };
      const usable = grants.filter(
        (g) => g.collectionId === info.id && g.agentQuota > 0,
      );
      if (usable.length === 0) {
        lastFailure = {
          ok: false,
          reason: 'quota_exhausted',
          detail: `No submissions left on collection ${info.id}.`,
        };
        continue;
      }
      // A grant without an intent window cannot reserve the escrow at all.
      const reservable = usable.filter((g) => g.intentDurationSeconds > 0);
      if (reservable.length === 0) {
        lastFailure = {
          ok: false,
          reason: 'intents_not_allowed',
          detail: `The authorisation on collection ${info.id} allows no payment reservation (no intent window).`,
        };
        continue;
      }
      const fits = reservable.find((g) => {
        const max = maxFor(g.maxAmount, env.denom);
        return max === null || max >= BigInt(amount.amount);
      });
      if (!fits) {
        lastFailure = {
          ok: false,
          reason: 'max_amount_too_low',
          detail: `The authorisation caps a job below the agreed ${service.priceUsd} USD.`,
        };
        continue;
      }
      return {
        ok: true,
        collectionId: info.id,
        admin: info.admin,
        homeServer: info.homeServer,
        service,
        amount,
        intentDurationSeconds: fits.intentDurationSeconds,
      };
    }
    return (
      lastFailure ?? {
        ok: false,
        reason: 'not_contracted',
        detail: 'No usable contract found.',
      }
    );
  } catch (err) {
    return {
      ok: false,
      reason: 'contract_check_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
