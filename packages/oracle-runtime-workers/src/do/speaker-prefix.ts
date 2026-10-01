/**
 * Node's group-room speaker prefix (`MessagesService`): in a room with more
 * than two members every user message the model sees starts with
 * `[DisplayName]: ` so it knows who is speaking. Applied to the stored
 * message, exactly as on Node; a message already carrying the prefix is left
 * alone. Node only ever prefixed strings — the attachment pipeline's block
 * content gets the prefix on its first text block, or a leading text block
 * when there is none.
 */
import type { MessageContent } from '@langchain/core/messages';

export function speakerPrefix(displayName: string): string {
  return `[${displayName}]: `;
}

export function prefixSpeaker(
  content: MessageContent,
  displayName: string,
): MessageContent {
  const prefix = speakerPrefix(displayName);
  if (typeof content === 'string')
    return content.startsWith(prefix) ? content : `${prefix}${content}`;
  const index = content.findIndex(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  );
  if (index === -1)
    return [{ type: 'text', text: prefix.trimEnd() }, ...content];
  const block = content[index] as { type: 'text'; text: string };
  if (block.text.startsWith(prefix)) return content;
  const out = content.slice();
  out[index] = { ...block, text: `${prefix}${block.text}` };
  return out;
}
