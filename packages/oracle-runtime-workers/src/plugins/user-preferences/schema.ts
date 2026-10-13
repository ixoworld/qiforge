/**
 * The stored preferences record — identical to the Node runtime's
 * `UserPreferencesSchema` so both runtimes accept each other's payloads.
 */
import { z } from 'zod';

/** Room-state key under `ixo.room.state` (shared with the Node runtime). */
export const USER_PREFS_STATE_KEY = 'user_prefs';

export const FORMALITY_LEVELS = [
  'casual',
  'friendly',
  'neutral',
  'semi-formal',
  'professional',
  'formal',
  'technical',
  'academic',
] as const;

/**
 * Longest `tone` label. The tone is pasted into every system prompt, so new
 * writes over this length are rejected by the tool schema, and a longer value
 * already stored (an older write, or one from the Node runtime, which never
 * capped it) is cut to this length when it is read.
 */
export const MAX_TONE_LENGTH = 120;

export const UserPreferencesSchema = z.object({
  agentName: z.string().max(80).optional(),
  userName: z.string().max(80).optional(),
  language: z.string().max(20).optional(), // BCP-47-ish, free-form
  tone: z
    .string()
    .transform((t) => t.slice(0, MAX_TONE_LENGTH))
    .optional(), // e.g. "casual", "playful"
  formality: z.enum(FORMALITY_LEVELS).optional(),
  customInstructions: z.string().max(2000).optional(),
  updatedAt: z.iso.datetime().optional(), // the store sets it on every write
});

export type StoredUserPreferences = z.infer<typeof UserPreferencesSchema>;
