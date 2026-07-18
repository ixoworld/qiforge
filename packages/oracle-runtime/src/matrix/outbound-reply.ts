import type { MatrixManager } from '@ixo/matrix';

/**
 * The two send capabilities this helper needs — structural so tests can pass
 * a plain mock and callers pass the real `MatrixManager`.
 */
export type OutboundMatrixSender = Pick<
  MatrixManager,
  'sendMessage' | 'sendFileMessage'
>;

/**
 * Chat-comfort budget for a single Matrix message. Purely a UX threshold
 * (the protocol ceiling is the 64 KiB event PDU): ~2,000 chars ≈ one mobile
 * screen, matching the prompt composer's own readable-block calibration.
 */
export const MATRIX_MESSAGE_OVERFLOW_CHARS = 2000;

/** Cap for the chat lead-in that accompanies an overflow artefact. */
const LEAD_IN_MAX_CHARS = 300;

export interface SplitOverflowReply {
  /** Post `content` as a normal chat message when true. */
  fitsInChat: boolean;
  /** Short chat lead-in when the full content goes out as a file. */
  leadIn?: string;
}

/**
 * Decide how an agent reply is delivered to a Matrix room. Within budget →
 * normal message. Over budget → the full content becomes an attached `.md`
 * artefact and only a short lead-in (first paragraph, capped at a word
 * boundary) is posted as chat. A lead-in that opens a code fence would render
 * broken, so those fall back to a generic pointer.
 */
export function splitOverflowReply(content: string): SplitOverflowReply {
  if (content.length <= MATRIX_MESSAGE_OVERFLOW_CHARS) {
    return { fitsInChat: true };
  }

  const firstParagraph = content.split(/\n\s*\n/, 1)[0]?.trim() ?? '';
  const usable =
    firstParagraph.length > 0 &&
    !firstParagraph.includes('```') &&
    !firstParagraph.startsWith('#');

  let leadIn: string;
  if (!usable) {
    leadIn = 'Full response attached below. 📎';
  } else if (firstParagraph.length <= LEAD_IN_MAX_CHARS) {
    leadIn = firstParagraph;
  } else {
    const slice = firstParagraph.slice(0, LEAD_IN_MAX_CHARS);
    const boundary = slice.lastIndexOf(' ');
    leadIn = `${slice.slice(0, boundary > LEAD_IN_MAX_CHARS / 2 ? boundary : LEAD_IN_MAX_CHARS).trimEnd()}…`;
  }

  return {
    fitsInChat: false,
    leadIn: `${leadIn}\n\n_(full response attached)_`,
  };
}

export interface PostAgentReplyOptions {
  matrixManager: OutboundMatrixSender;
  roomId: string;
  threadId?: string;
  content: string;
  /** Preserve each call site's existing prefix rendering. */
  disablePrefix: boolean;
}

/**
 * Deliver an agent reply to a Matrix room, enforcing the chat-formatting
 * rule: content over the overflow budget is uploaded as an in-thread
 * markdown artefact with a short lead-in message. If the upload fails, the
 * full text is posted as a normal message — availability over neatness.
 */
export async function postAgentReplyToMatrix({
  matrixManager,
  roomId,
  threadId,
  content,
  disablePrefix,
}: PostAgentReplyOptions): Promise<void> {
  const split = splitOverflowReply(content);

  if (!split.fitsInChat) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await matrixManager.sendFileMessage({
        roomId,
        threadId,
        filename: `response-${timestamp}.md`,
        mimetype: 'text/markdown',
        data: Buffer.from(content, 'utf-8'),
      });
      await matrixManager.sendMessage({
        roomId,
        threadId,
        message: split.leadIn ?? 'Full response attached below. 📎',
        isOracleAdmin: true,
        disablePrefix,
      });
      return;
    } catch {
      // Fall through to posting the full text — the artefact path must
      // never lose the reply.
    }
  }

  await matrixManager.sendMessage({
    roomId,
    threadId,
    message: content,
    isOracleAdmin: true,
    disablePrefix,
  });
}
