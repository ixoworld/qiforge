import type { DeliveryProfile } from './types';

/** `maxBubbles` as the prompt asks for it: "two or three messages". */
function preferredMessages(maxBubbles: number): string {
  if (maxBubbles <= 1) return 'one message';
  if (maxBubbles === 2) return 'one or two messages';
  if (maxBubbles === 3) return 'two or three messages';
  return `up to ${maxBubbles} messages`;
}

/**
 * The prompt section a chat turn gets: write for the surface. Empty on the
 * Portal. `artifacts` says whether `create_artifact` is bound this turn.
 * Agrees with the shaper and the tool's own description: ordinary answers
 * stay in chat, and only document-length output becomes an artefact.
 */
export function renderSurfaceSection(
  profile: DeliveryProfile | undefined,
  artifacts: boolean,
): string {
  if (!profile || profile.kind !== 'chat') return '';
  const { label, limits } = profile;
  const preferred = preferredMessages(limits.maxBubbles);
  return [
    '## Where this conversation is happening',
    '',
    `You are replying in ${label}. The user reads your reply as chat messages, often on a phone with a chat-only data plan and no browser, so the answer itself belongs in the messages.`,
    '',
    '- Lead with the answer. Write like a sharp person texting: short sentences, no preamble, no sign-off.',
    `- Prefer ${preferred}. A blank line marks where a message may break; short paragraphs are grouped so the reply reads as ${preferred}. Keep each paragraph under about ${limits.bubbleTarget} characters. Use more messages when the answer needs them; never leave content out to fit.`,
    `- Ordinary answers stay in chat, including explanations, comparisons, short plans and step-by-step instructions. No headings or horizontal rules. Lists up to ${limits.maxListItems} items, code up to ${limits.maxCodeLines} lines and **bold** for the key fact are fine in chat. Write a small comparison as one short line per item, not a table.`,
    artifacts
      ? '- Use `create_artifact` only when the user asks for a document or file, or when the output is genuinely document-length: several screens of text, long code, a long report. Even then, its message carries the conclusions, decisions and next actions, and the document holds the detail. Call it last: the user gets the message, a link to the document, then at most one follow-up question.'
      : '- Everything you write is delivered as messages; when something is genuinely long, put the essential part first.',
    '- The user sees a typing indicator while you work. Do not narrate your steps or announce tool calls.',
    '- End with at most one question.',
  ].join('\n');
}
