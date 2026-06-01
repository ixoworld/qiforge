import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type {
  Logger,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import type { UserPreferencesWriter } from './service/user-preferences.service.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const setUserPreferencesSchema = z.object({
  agentName: z
    .string()
    .max(80)
    .optional()
    .describe(
      "What the user wants you (the agent) to be called (e.g. 'Companion'). Use exactly the form the user asked for. Max 80 characters.",
    ),
  userName: z
    .string()
    .max(80)
    .optional()
    .describe(
      "What the user wants you to call them (e.g. 'Yousef'). Use exactly the form the user asked for. Max 80 characters.",
    ),
  language: z
    .string()
    .max(20)
    .optional()
    .describe(
      "Preferred reply language as a free-form code or name (e.g. 'en', 'ar', 'Arabic', 'Egyptian Arabic'). " +
        'Be precise — if the user specified a dialect or variant, capture that. Max 20 characters.',
    ),
  tone: z
    .string()
    .optional()
    .describe(
      "Short tone label your future self will see at the top of every prompt (e.g. 'playful and warm', " +
        "'concise and dry', 'patient teacher'). Pick descriptive words, not vague ones.",
    ),
  formality: z
    .enum([
      'casual',
      'friendly',
      'neutral',
      'semi-formal',
      'professional',
      'formal',
      'technical',
      'academic',
    ])
    .optional()
    .describe(
      'How formal the replies should be. Pick the value closest to what the user actually wants, ' +
        'not what the request literally said.',
    ),
  customInstructions: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Free-form custom instructions your FUTURE SELF will read every turn. Treat this like writing ' +
        'a system prompt: be specific, complete, and unambiguous. Include the WHY when it matters ' +
        "(e.g. 'User has dyslexia — keep sentences short and avoid long lists'). " +
        'When updating, MERGE with existing instructions rather than replacing — read what is already ' +
        'there (visible in your current system prompt under "User Preferences") and write the full new ' +
        'instruction set, preserving anything still relevant. Max 2000 characters.',
    ),
});

const SET_USER_PREFERENCES_DESCRIPTION =
  "Update the user's preferences. Call this whenever the user asks you to change how you behave " +
  "(e.g. 'call me Yousef', 'reply in Arabic', 'be more casual').\n\n" +
  'IMPORTANT — you are writing instructions for your FUTURE SELF. ' +
  'On every later turn this exact text will be injected back into your system prompt and you will read it cold, ' +
  'with no memory of this conversation or why the user asked. So:\n' +
  "  • Be specific and self-contained. Don't write 'be more casual' — write 'Use casual, conversational " +
  "tone. Avoid corporate phrasing. Use contractions. Drop filler words.'\n" +
  "  • Capture intent, not just the literal request. If the user says 'stop being so formal', infer the " +
  'positive form: what should you do instead?\n' +
  '  • Preserve existing instructions when adding new ones — only overwrite the fields you mean to change. ' +
  'Other fields are kept as-is.\n' +
  "  • If unsure between two interpretations, pick the more specific one — your future self can't ask back.\n\n" +
  "Note: changes apply from the user's NEXT message (the current turn's prompt is already built).";

export interface CreateSetUserPreferencesToolOptions {
  /** Service the tool delegates writes to (typically the singleton). */
  service: UserPreferencesWriter;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Builds the `set_user_preferences` plugin tool. The tool merges the supplied
 * partial preferences into the user's stored preferences for the active room;
 * only the fields provided are updated.
 *
 * The active `roomId` is read off `ctx.session.roomId` per invocation. Tools
 * called from clients without a room (e.g. some non-Matrix flows) get a
 * descriptive error string back rather than throwing — the agent can recover.
 *
 * Note: changes take effect from the user's NEXT message — the system prompt
 * for the current turn has already been built.
 */
export function createSetUserPreferencesTool(
  options: CreateSetUserPreferencesToolOptions,
): PluginTool {
  const logger = options.logger ?? NOOP_LOGGER;
  const { service } = options;

  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const args = setUserPreferencesSchema.parse(rawArgs);
      const roomId = ctx.session.roomId;
      if (!roomId) {
        return '[Error updating user preferences: no active room on this session]';
      }
      try {
        const merged = await service.set(roomId, args);
        return `Updated. New preferences: ${JSON.stringify(merged, null, 2)}`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`set_user_preferences error: ${msg}`);
        return `[Error updating user preferences: ${msg}]`;
      }
    },
    {
      name: 'set_user_preferences',
      description: SET_USER_PREFERENCES_DESCRIPTION,
      schema: setUserPreferencesSchema,
    },
  );
}
