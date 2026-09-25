/**
 * Chat delivery in Matrix rooms: one `m.text` per Reply Plan part, in the
 * thread, rendered to HTML like the room replays (`formatReplay`). Each part
 * has its own transaction id, so a replayed turn is deduplicated part by part.
 */
import type { ReplyPart } from '../delivery/types';
import { formatReplay } from './replay-format';
import { matrixTxnId } from './txn-id';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function replyPartContent(part: ReplyPart): {
  body: string;
  formattedBody: string;
} {
  if (part.kind === 'text')
    return formatReplay({
      message: part.text,
      isOracle: true,
      disablePrefix: true,
    });
  const { title, url } = part.artifact;
  return {
    body: `${title}\n${url}`,
    formattedBody: `<p><strong>${escapeHtml(title)}</strong><br><a href="${escapeHtml(url)}">Open document</a></p>`,
  };
}

export function replyPartTxnId(eventId: string, part: ReplyPart): string {
  return matrixTxnId('reply', eventId, part.partId);
}
