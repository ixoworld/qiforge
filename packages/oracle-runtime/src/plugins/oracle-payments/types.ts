import { z } from 'zod';
import type { CommerceEngagementStart } from '../../modules/messages/commerce-router-port.js';

/**
 * Micro-unit scale — a USD price is `Math.round(priceUsd * 1e6)` in the denom.
 * Exact for every denom this lane settles in: each is 6-decimal and $1-pegged
 * (uPay spec §5 R1), so no per-denom scale table is needed.
 */
export const MICRO_UNITS_PER_UNIT = 1_000_000;

/**
 * `CommerceEngagementStart` plus the denom the portal granted (uPay spec §5
 * R1) — `authz.maxAmount.denom` off the contract record, the denom every coin
 * this job builds must be priced in. The shared router type predates the
 * field, but the core router passes the gate's start object through verbatim,
 * so the denom rides along structurally and `grantedDenom()` reads it back on
 * the far side. A start without it is refused, never priced by guesswork.
 */
export interface GrantedEngagementStart extends CommerceEngagementStart {
  denom: string;
}

/**
 * One service from the oracle's Agent Card, reduced to the fields the runtime
 * and the component cards consume. Display shape only — the engine's schema is
 * the authority at contract time.
 */
export interface AgentCardServiceView {
  id: string;
  name: string;
  description?: string;
  price: { amount: number; currency?: string };
  deliverables: string;
  doneMeans?: string[];
  tags?: string[];
  examples?: string[];
}

/** The resolved Agent Card, reduced to what the runtime consumes. */
export interface ResolvedAgentCard {
  oracleEntityDid: string;
  /** The LinkedResource's on-chain `proof` — opaque version string. */
  cardProof: string;
  services: AgentCardServiceView[];
}

/**
 * Display-shape validation for a fetched Agent Card. Mirrors the portal's
 * `parseDisplayCard`: `credentialSubject.id` must equal the entity DID (checked
 * by the caller), services non-empty, each service has a string id/name/
 * deliverables and a numeric `price.amount`. Extra card fields are ignored.
 */
const AgentCardServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  price: z.object({
    amount: z.number(),
    currency: z.string().optional(),
  }),
  deliverables: z.string(),
  doneMeans: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

export const DisplayCardSchema = z.object({
  credentialSubject: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    services: z.array(AgentCardServiceSchema).min(1),
  }),
});

/** The AuthZ snapshot the engine folds into its contract-lookup response. */
export const ContractAuthzSnapshotSchema = z.object({
  granted: z.boolean(),
  agentQuotaRemaining: z.number(),
  maxAmount: z.object({ amount: z.string(), denom: z.string() }),
  intentDurationNs: z.union([z.string(), z.number()]),
});

/**
 * The engine's oracle-facing contract record (spec §3.4) — the contract row
 * plus the live AuthZ snapshot. Extra fields are ignored so the engine can add
 * to the payload without breaking the client.
 */
export const ContractRecordSchema = z.object({
  collectionId: z.string(),
  adminAddress: z.string(),
  serviceIds: z.array(z.string()),
  rubricId: z.string(),
  cardProof: z.string(),
  status: z.string(),
  authz: ContractAuthzSnapshotSchema,
});

export type ContractRecord = z.infer<typeof ContractRecordSchema>;
