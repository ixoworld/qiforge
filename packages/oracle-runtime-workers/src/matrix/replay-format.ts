/**
 * Room replay formatting — a port of `@ixo/matrix`'s `formatMsg`. The Node
 * runtime replays every HTTP/SSE turn into the user's oracle room as a thread
 * under the session's root event: the user message prefixed `**You:**`, the
 * reply prefixed with the oracle's name, both rendered to HTML with marked —
 * with raw HTML escaped, as for every room reply (`reply-parts.ts`): the
 * text may come from a model or a user and must not become room markup.
 */
import { renderRoomMarkdown } from './reply-parts';

export interface FormatReplayParams {
  message: string;
  /** `true` for the oracle's reply, `false` for the user's message. */
  isOracle: boolean;
  oracleName?: string;
  /** Skip the speaker prefix (Node's `disablePrefix`). */
  disablePrefix?: boolean;
}

export interface FormattedReplay {
  body: string;
  formattedBody: string;
}

export function formatReplay({
  message,
  isOracle,
  oracleName = 'Oracle',
  disablePrefix = false,
}: FormatReplayParams): FormattedReplay {
  const body = disablePrefix
    ? message
    : `**${isOracle ? oracleName : 'You'}:**\n${message}`;
  const formattedBody = renderRoomMarkdown(body);
  return { body, formattedBody };
}
