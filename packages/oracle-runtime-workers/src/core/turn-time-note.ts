/**
 * The exact time of a turn rides on the message the user sent, not in the
 * system prompt: the system prompt then stays identical from turn to turn
 * (the provider's prompt cache keeps the whole history), and the model still
 * sees when every message was sent.
 *
 * The note is stored as part of the message the model reads, and recorded
 * verbatim in the message's `additional_kwargs` so everything a person reads
 * (the transcript, a mirror) can take it off again without guessing.
 */
import type { MessageContent } from '@langchain/core/messages';

/** `additional_kwargs` key holding the exact note a message was sent with. */
export const TURN_TIME_NOTE_KWARG = 'turn_time_note';

const SEPARATOR = '\n\n';

/** The content the model reads: the note first, then what the user sent. */
export function withTurnTimeNote(
  content: MessageContent,
  note: string,
): MessageContent {
  if (typeof content === 'string') return `${note}${SEPARATOR}${content}`;
  return [{ type: 'text', text: note }, ...content];
}

/**
 * The content the user sent. `note` is the value recorded under
 * `TURN_TIME_NOTE_KWARG`; content that does not start with exactly that
 * note (an older message, a message edited since) is returned unchanged.
 */
export function stripTurnTimeNote(
  content: MessageContent,
  note: unknown,
): MessageContent {
  if (typeof note !== 'string' || note.length === 0) return content;
  if (typeof content === 'string') {
    const lead = `${note}${SEPARATOR}`;
    return content.startsWith(lead) ? content.slice(lead.length) : content;
  }
  const [first, ...rest] = content;
  return first?.type === 'text' && first.text === note ? rest : content;
}
