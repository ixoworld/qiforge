import { z } from 'zod';

/**
 * One service the agent offers. `price.amount` is a display price in whole
 * units of `price.currency` (PAY, the platform settlement currency — 1 PAY =
 * 1 USD) — NOT a chain amount. Callers that turn a service price into an
 * on-chain `maxAmount` or claim amount own that conversion, because the coin
 * is built in the denom the contract was granted in.
 */
export const AgentCardServiceSchema = z.object({
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

/**
 * Display-shape validation for a fetched Agent Card, deliberately loose: it
 * checks only the fields a consumer renders or prices from, and ignores
 * everything else the credential carries (`@context`, `issuer`, `validFrom`,
 * proofs). The eval-engine's schema is the authority at contract time — this
 * one decides "is there a usable card to show", nothing more.
 */
export const AgentCardSchema = z.object({
  credentialSubject: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    services: z.array(AgentCardServiceSchema).min(1),
  }),
});

export type TAgentCardService = z.infer<typeof AgentCardServiceSchema>;
export type TAgentCard = z.infer<typeof AgentCardSchema>;

/** A card resolved off-chain, paired with the entity + revision it came from. */
export interface TResolvedAgentCard {
  oracleDid: string;
  card: TAgentCard;
  /**
   * The LinkedResource's on-chain `proof` — an opaque version string. Echoed
   * back when registering a contract so the engine can reject a card that moved
   * underneath the user mid-flow.
   */
  cardProof: string;
}
