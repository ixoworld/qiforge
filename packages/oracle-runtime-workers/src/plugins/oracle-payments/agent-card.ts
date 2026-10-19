import { z } from 'zod';

/**
 * One service the oracle sells. Same shape as a service in the buyer's
 * `agent-services/v1` agreement, so what the card offers and what the
 * Agent Work evaluator checks the claim against read identically.
 */
export const AgentServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  priceUsd: z.number().positive(),
  /** What "done" means — the deliverable checklist the work is judged on. */
  doneMeans: z.array(z.string()).default([]),
  /** The delivery promise (`P4D`, `48h`, `3 days`). */
  deliveryTime: z.string().optional(),
});

export const AgentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  services: z.array(AgentServiceSchema).min(1),
});

export type AgentService = z.infer<typeof AgentServiceSchema>;
export type AgentCard = z.infer<typeof AgentCardSchema>;

let memo: { raw: string; card: AgentCard } | null = null;

/**
 * Parse `AGENT_CARD_JSON`. A configured but invalid card throws — a
 * misconfigured price list must fail loudly, never sell from a guess.
 */
export function loadAgentCard(raw: string | undefined): AgentCard | null {
  if (!raw) return null;
  if (memo?.raw === raw) return memo.card;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_CARD_JSON is not valid JSON');
  }
  const parsed = AgentCardSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `AGENT_CARD_JSON is not a valid agent card: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  memo = { raw, card: parsed.data };
  return parsed.data;
}

export function priceLabel(service: AgentService): string {
  return `${service.priceUsd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  })}`;
}
