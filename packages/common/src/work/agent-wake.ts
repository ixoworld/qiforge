import { z } from 'zod';

export const AgentWakeSchema = z
  .object({
    version: z.literal(1),
    wakeId: z.string().min(1),
    principal: z.string().regex(/^did:[a-z0-9]+:/i),
    source: z.string().min(1),
    resourceRef: z.string().min(1),
    observedRevision: z.string().min(1).optional(),
    evaluatedThrough: z.string().min(1).optional(),
    reason: z.string().min(1),
    occurredAt: z.string().datetime(),
    notifyOnly: z.literal(true),
  })
  .strict();

export const AgentWakeAcknowledgementSchema = z
  .object({
    version: z.literal(1),
    wakeId: z.string().min(1),
    principal: z.string().regex(/^did:[a-z0-9]+:/i),
    receivedAt: z.string().datetime(),
    status: z.enum(['received', 'duplicate', 'superseded']),
  })
  .strict();

export type AgentWake = z.infer<typeof AgentWakeSchema>;
export type AgentWakeAcknowledgement = z.infer<
  typeof AgentWakeAcknowledgementSchema
>;

export function agentWakeDedupeKey(wake: AgentWake): string {
  return `${wake.principal}\u0000${wake.wakeId}`;
}
