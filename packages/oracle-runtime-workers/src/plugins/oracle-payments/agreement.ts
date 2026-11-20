import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';

/**
 * The buyer's `agent-services/v1` agreement — what they hired this oracle
 * for, at what price. Written by the buyer (subscriptions-api proxies it for
 * a subscription collection) to decision-engine with `counterparty` = this
 * oracle's address; the Agent Work evaluator judges the claim against the
 * same document.
 */
export const AgreedServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceUsd: z.number(),
  doneMeans: z.array(z.string()).default([]),
  deliveryTime: z.string().nullable().optional(),
});

export type AgreedService = z.infer<typeof AgreedServiceSchema>;

export const AgentServicesDocSchema = z.object({
  kind: z.literal('agent-services/v1'),
  services: z.array(AgreedServiceSchema),
  maxAmount: z
    .object({ denom: z.string(), amount: z.string() })
    .nullable()
    .optional(),
  consentedAt: z.string().nullable().optional(),
});

export type AgentServicesDoc = z.infer<typeof AgentServicesDocSchema>;

const AgreementRowSchema = z.object({
  id: z.string(),
  digest: z.string(),
  counterparty: z.string().nullable(),
  doc: z.unknown(),
  capturedAt: z.string(),
});

export type AgreementRead =
  | { ok: true; doc: AgentServicesDoc; digest: string }
  | { ok: false; reason: 'no_agreement' | 'unreadable'; detail: string };

/**
 * decision-engine's counterparty self-read: the oracle reads ONLY the
 * agreement written for its own address (no whole-collection fallback).
 * Auth is a self-signed UCAN; the engine admits the caller when its
 * principal address equals `counterparty`, so the oracle DID must be
 * `did:ixo:<secp address>`.
 */
export async function readOwnAgreement(
  ctx: RuntimeContext,
  engineUrl: string,
  collectionId: string,
  oracleAddress: string,
): Promise<AgreementRead> {
  const minted = await ctx.ucan.mintSelfSignedInvocation(engineUrl, {
    // decision-engine kept eval-engine's resource name.
    with: 'ixo:eval-engine',
    can: 'agreement/read',
  });
  if ('error' in minted) {
    return { ok: false, reason: 'unreadable', detail: minted.error };
  }
  const res = await fetch(
    `${engineUrl}/v1/collections/${encodeURIComponent(collectionId)}/agreements?counterparty=${oracleAddress}`,
    {
      headers: {
        authorization: `Bearer ${minted.invocation}`,
        'x-auth-type': 'ucan',
      },
    },
  );
  if (res.status === 404) {
    return {
      ok: false,
      reason: 'no_agreement',
      detail: `No agreement for this oracle on collection ${collectionId}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `decision-engine answered ${res.status}: ${await res.text()}`,
    };
  }
  const row = AgreementRowSchema.safeParse(await res.json());
  const doc = row.success
    ? AgentServicesDocSchema.safeParse(row.data.doc)
    : null;
  if (!row.success || !doc?.success) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: 'The agreement is not an agent-services/v1 document',
    };
  }
  return { ok: true, doc: doc.data, digest: row.data.digest };
}
