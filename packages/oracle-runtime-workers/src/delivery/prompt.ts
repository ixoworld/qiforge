import type { DeliveryProfile } from './types';

/**
 * The prompt section a chat turn gets: write for the surface. Empty on the
 * Portal. `artifacts` says whether `create_artifact` is bound this turn.
 */
export function renderSurfaceSection(
  profile: DeliveryProfile | undefined,
  artifacts: boolean,
): string {
  if (!profile || profile.kind !== 'chat') return '';
  const { label, limits } = profile;
  return [
    '## Where this conversation is happening',
    '',
    `You are replying in ${label}. The user reads your reply as chat messages, not as a document.`,
    '',
    '- Lead with the answer. Write like a sharp person texting: short sentences, no preamble, no sign-off.',
    `- Aim for one to three short messages. A blank line starts a new message; keep each under about ${limits.bubbleTarget} characters.`,
    `- No headings, tables or horizontal rules. Short lists (up to ${limits.maxListItems} items) and **bold** for the key fact are fine.`,
    artifacts
      ? '- Anything longer, such as a plan, report, comparison, draft, table or code, goes in `create_artifact`: the full Markdown as the document, a one-line message, and at most one follow-up question. The user gets the message, a link that opens the document in their browser, then the question.'
      : '- When something is too long for chat, send the short version and offer the rest.',
    '- The user sees a typing indicator while you work. Do not narrate your steps or announce tool calls.',
    '- End with at most one question.',
  ].join('\n');
}
