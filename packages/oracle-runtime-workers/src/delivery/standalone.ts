/**
 * Standalone messages: text a plugin tool hands the Reply Plan to deliver
 * verbatim, each as a chat message of its own, after the model's reply.
 * A dial code, a PIN, a reference number: something the person copies with
 * one long-press, which the shaper's grouping must never join to another
 * message and which the model never has to repeat word for word.
 *
 * The tool returns `withStandaloneMessages(ctx, { name, content, messages })`:
 * a `ToolMessage` whose `content` is what the model reads and whose
 * `artifact` carries the messages. The model never receives the artifact
 * (no chat model converter sends it); the checkpoint keeps it, and the plan
 * reads it back when the run finishes. Only chat surfaces build a plan: on
 * the Portal (`ctx.session.surface.kind === 'stream'`) the messages are not
 * delivered, so a tool that also serves the Portal puts the text in its
 * result there instead.
 */
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { isBlank } from './shaper';

/** The key of `ToolMessage.artifact` that holds a call's standalone messages. */
export const STANDALONE_MESSAGES_KEY = 'standaloneMessages';

/**
 * Standalone messages one tool call may hand over, and one reply delivers
 * as messages of their own: over it, the rest of the run's are joined to
 * its last standalone message, so nothing is lost.
 */
export const MAX_STANDALONE_MESSAGES = 4;

/** Characters of one standalone message at most. */
export const MAX_STANDALONE_MESSAGE_CHARS = 1024;

const StandaloneMessagesSchema = z
  .array(
    z
      .string()
      .max(MAX_STANDALONE_MESSAGE_CHARS)
      .refine((text) => !isBlank(text), 'must not be blank'),
  )
  .min(1)
  .max(MAX_STANDALONE_MESSAGES);

/**
 * The standalone messages a call's `ToolMessage.artifact` carries, in order;
 * `[]` for any other artifact (a `send_file` file, an MCP tool's resources)
 * or a malformed list, which delivers nothing rather than a part the helper
 * would have refused.
 */
export function standaloneMessagesOf(artifact: unknown): string[] {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
    return [];
  const parsed = StandaloneMessagesSchema.safeParse(
    Reflect.get(artifact, STANDALONE_MESSAGES_KEY),
  );
  return parsed.success ? parsed.data : [];
}

export interface StandaloneMessagesResult {
  /** The tool's name, as registered. */
  name: string;
  /**
   * What the model reads: a string, or a value sent as JSON. Say there that
   * the messages go out after the reply, each on its own, and that the reply
   * must not repeat them; leave out anything the model must not hold.
   */
  content: unknown;
  /**
   * Chat Markdown, each delivered verbatim as its own message, in this
   * order: 1 to `MAX_STANDALONE_MESSAGES`, each at most
   * `MAX_STANDALONE_MESSAGE_CHARS` characters and not blank.
   */
  messages: readonly string[];
}

/**
 * A plugin tool's result that delivers `messages` as standalone messages on
 * a chat surface (see the module comment). Throws a `TypeError` when the
 * messages break the limits, so a mistake shows in the tool's own tests
 * instead of as a reply that silently lacks them.
 */
export function withStandaloneMessages(
  ctx: { toolCallId?: string },
  result: StandaloneMessagesResult,
): ToolMessage {
  const parsed = StandaloneMessagesSchema.safeParse(result.messages);
  if (!parsed.success)
    throw new TypeError(
      `withStandaloneMessages: \`messages\` must hold 1 to ${MAX_STANDALONE_MESSAGES} non-blank strings of at most ${MAX_STANDALONE_MESSAGE_CHARS} characters.`,
    );
  return new ToolMessage({
    tool_call_id: ctx.toolCallId ?? '',
    name: result.name,
    content:
      typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content),
    artifact: { [STANDALONE_MESSAGES_KEY]: parsed.data },
  });
}
