import { z } from 'zod';

/** USDC IBC denom used for agent-work pricing on mainnet (portal parity). */
export const MAINNET_USDC_IBC_DENOM =
  'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B';

/** Micro-unit scale — a USD price is `Math.round(priceUsd * 1e6)` in the denom. */
export const MICRO_UNITS_PER_UNIT = 1_000_000;

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
