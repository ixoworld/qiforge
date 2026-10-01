/**
 * What the gateway posts in a Matrix room for one finished turn. Without a
 * Reply Plan (chat style off, the default) it is the reply text as one
 * plain `m.text`, exactly as before chat delivery existed. With a plan it is
 * one `m.text` per part, in the thread, rendered to HTML with raw HTML from
 * the model escaped. Each part has its own transaction id, so a replayed
 * turn is deduplicated part by part.
 */
import { Marked } from 'marked';
import type { TurnResult } from '../do/contracts';
import { parseReplyPlan } from '../delivery/schema';
import type { ReplyPart } from '../delivery/types';
import { matrixTxnId } from './txn-id';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Markdown → `formatted_body` for chat parts. Raw HTML in the model's text
 * (block or inline) is shown as text, never passed through as markup.
 */
const partMarkdown = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

export function replyPartContent(part: ReplyPart): {
  body: string;
  formattedBody: string;
} {
  if (part.kind === 'text')
    return {
      body: part.text,
      formattedBody: partMarkdown.parse(part.text, { async: false }),
    };
  const { title, url } = part.artifact;
  return {
    body: `${title}\n${url}`,
    formattedBody: `<p><strong>${escapeHtml(title)}</strong><br><a href="${escapeHtml(url)}">Open document</a></p>`,
  };
}

export function replyPartTxnId(eventId: string, partId: string): string {
  return matrixTxnId('reply', eventId, partId);
}

/** One room message of a turn's reply; `partId` is set for a plan part. */
export interface RoomReplyMessage {
  body: string;
  formattedBody?: string;
  partId?: string;
}

/** The messages a finished room turn posts, in order; none for an empty reply. */
export function roomReplyMessages(
  result: Pick<TurnResult, 'text' | 'plan'>,
): RoomReplyMessage[] {
  const plan = parseReplyPlan(result.plan);
  if (plan && plan.parts.length > 0)
    return plan.parts.map((part) => ({
      ...replyPartContent(part),
      partId: part.partId,
    }));
  return result.text.trim() ? [{ body: result.text }] : [];
}
