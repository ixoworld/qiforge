/**
 * `set_user_preferences`: the Node runtime's tool, the same schema with
 * shorter text (the model reads it on every call). The handler writes
 * through the host's `ctx.preferences` surface for the active room.
 */
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type {
  Logger,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { FORMALITY_LEVELS, MAX_TONE_LENGTH } from './schema';

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
    .describe('What the user wants to call you, in exactly their form.'),
  userName: z
    .string()
    .max(80)
    .optional()
    .describe('What the user wants to be called, in exactly their form.'),
  language: z
    .string()
    .max(20)
    .optional()
    .describe(
      "Reply language, code or name, with any dialect (e.g. 'ar', 'Egyptian Arabic').",
    ),
  tone: z
    .string()
    .max(MAX_TONE_LENGTH)
    .optional()
    .describe(
      "Short descriptive tone label (e.g. 'playful and warm', 'concise and dry').",
    ),
  formality: z
    .enum(FORMALITY_LEVELS)
    .optional()
    .describe('The value closest to what the user actually wants.'),
  customInstructions: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Instructions you will read on every turn, like a system prompt: specific, complete, with the why when it matters (e.g. \'User has dyslexia: short sentences, no long lists\'). This field is replaced whole: write the full new set, keeping what is still relevant from "User Preferences" in your system prompt.',
    ),
});

export const SET_USER_PREFERENCES_DESCRIPTION =
  "Save how the user wants you to behave (e.g. 'call me Yousef', 'reply in Arabic', 'be more casual'). Takes effect from their NEXT message. Only the fields you pass change.\n\n" +
  "You are writing for your FUTURE SELF, who reads this text cold on every later turn with no memory of why. Be specific and self-contained: not 'be more casual' but 'Use a casual, conversational tone. Use contractions. Avoid corporate phrasing.' Capture the intent as what to do ('stop being so formal' becomes what to do instead). Between two readings pick the more specific one.";

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
