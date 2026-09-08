/**
 * `set_user_preferences` — the Node runtime's tool, verbatim in schema and
 * description (the description is prompt material the model has been tuned
 * against; keep it in sync with `packages/oracle-runtime`). The handler
 * writes through the host's `ctx.preferences` surface for the active room.
 */
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type {
  Logger,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { FORMALITY_LEVELS } from './schema';

export const SET_USER_PREFERENCES_TOOL_NAME = 'set_user_preferences';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const setUserPreferencesSchema = z.object({
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
    .enum(FORMALITY_LEVELS)
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

export const SET_USER_PREFERENCES_DESCRIPTION =
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
  logger?: Logger;
}

/**
 * Builds the `set_user_preferences` tool. Merges the supplied partial
 * preferences into the active room's stored preferences; only the provided
 * fields change. Errors come back as descriptive strings (never thrown) so
 * the agent can recover — the Node tool's contract.
 */
export function createSetUserPreferencesTool(
  options: CreateSetUserPreferencesToolOptions = {},
): PluginTool {
  const logger = options.logger ?? NOOP_LOGGER;

  return tool(
    async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = setUserPreferencesSchema.parse(rawArgs);
      const roomId = ctx.session.roomId;
      if (!roomId) {
        return '[Error updating user preferences: no active room on this session]';
      }
      const surface = ctx.preferences;
      if (!surface) {
        return '[Error updating user preferences: preferences are not available on this host]';
      }
      try {
        const merged = await surface.set(roomId, args);
        return `Updated. New preferences: ${JSON.stringify(merged, null, 2)}`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`set_user_preferences error: ${msg}`);
        return `[Error updating user preferences: ${msg}]`;
      }
    },
    {
      name: SET_USER_PREFERENCES_TOOL_NAME,
      description: SET_USER_PREFERENCES_DESCRIPTION,
      schema: setUserPreferencesSchema,
    },
  );
}
