import { z } from 'zod';
import type { UserContextData } from '../plugin-api/types';

export const memorySlotSchema = z.enum([
  'identity',
  'work',
  'goals',
  'interests',
  'relationships',
  'recent',
]);
export const memoryScopeSchema = z.object({
  userDid: z.string().min(1),
  oracleDid: z.string().min(1),
  knowledgeScope: z.literal('personal'),
});
export const memoryFactSchema = z.object({
  reference: z.string().startsWith('memory:fact:'),
  revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  text: z.string().min(1).max(12000),
  scope: memoryScopeSchema,
});
export const memorySearchSchema = z.object({
  representation: z.literal(1),
  scope: memoryScopeSchema,
  observedAt: z.string().datetime(),
  facts: z.array(memoryFactSchema).max(50),
});
export const memoryStampSchema = z.object({
  userDid: z.string(),
  oracleDid: z.string(),
  network: z.string(),
  sourceOrigin: z.string().url(),
  roomId: z.string(),
  sessionId: z.string(),
  grantRevision: z.string(),
  generation: z.number().int().nonnegative(),
});
export type MemoryStamp = z.infer<typeof memoryStampSchema>;
export const retainedMemorySchema = z.object({
  stamp: memoryStampSchema,
  facts: z.array(memoryFactSchema.extend({ slot: memorySlotSchema })).max(100),
});
export type RetainedMemory = z.infer<typeof retainedMemorySchema>;

export async function contentDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function retainedMemory(value: unknown): RetainedMemory | undefined {
  const envelope = z.object({ _memory: retainedMemorySchema }).safeParse(value);
  return envelope.success ? envelope.data._memory : undefined;
}

export function memoryContext(memory: RetainedMemory): UserContextData {
  const context: UserContextData = { _memory: memory };
  for (const slot of memorySlotSchema.options) {
    context[slot] = {
      facts: memory.facts
        .filter((fact) => fact.slot === slot)
        .map((fact) => ({ fact: fact.text })),
    };
  }
  return context;
}

export function sameMemoryStamp(
  left: MemoryStamp,
  right: MemoryStamp,
): boolean {
  return memoryStampSchema
    .keyof()
    .options.every((key) => left[key] === right[key]);
}
