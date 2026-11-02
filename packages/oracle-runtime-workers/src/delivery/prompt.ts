import { SENDABLE_FILE_TYPES } from '../plugins/sandbox/send-file';
import type { DeliveryProfile } from './types';

/**
 * Whether the surface delivers a file as an attachment. A Matrix room has no
 * gateway to fetch it, so a file arrives there as a link line.
 */
export function deliversAttachments(surface: string): boolean {
  return surface !== 'matrix';
}

/** `maxBubbles` as the prompt asks for it: "two or three messages". */
function preferredMessages(maxBubbles: number): string {
  if (maxBubbles <= 1) return 'one message';
  if (maxBubbles === 2) return 'one or two messages';
  if (maxBubbles === 3) return 'two or three messages';
  return `up to ${maxBubbles} messages`;
}

/**
 * The prompt section a chat turn gets: write for the surface. Empty on the
 * Portal. `artifacts` says whether `create_artifact` is bound this turn,
 * `files` whether `send_file` is. Agrees with the shaper and the tools' own
 * descriptions: ordinary answers stay in chat, only document-length output
 * becomes an artefact, and a made file reaches the user as an attachment.
 */
export function renderSurfaceSection(
  profile: DeliveryProfile | undefined,
  artifacts: boolean,
  files: boolean,
): string {
  if (!profile || profile.kind !== 'chat') return '';
  const { label, limits, surface } = profile;
  const preferred = preferredMessages(limits.maxBubbles);
  return [
    '## Where this conversation is happening',
    '',
    `You are replying in ${label}. The user reads your reply as chat messages, often on a phone with a chat-only data plan and no browser, so the answer itself belongs in the messages.`,
    '',
    '- Lead with the answer. Write like a sharp person texting: short sentences, no preamble, no sign-off.',
    `- Prefer ${preferred}. A blank line marks where a message may break; short paragraphs are grouped so the reply reads as ${preferred}. Keep each paragraph under about ${limits.bubbleTarget} characters. Use more messages when the answer needs them; never leave content out to fit.`,
    `- Ordinary answers stay in chat, including explanations, comparisons, short plans and step-by-step instructions. No headings or horizontal rules. Lists up to ${limits.maxListItems} items, code up to ${limits.maxCodeLines} lines and **bold** for the key fact are fine in chat. Write a small comparison as one short line per item, not a table.`,
    ...(files
      ? [
          `- Deliver every file meant for the user with \`send_file\` (${SENDABLE_FILE_TYPES} only): ${deliversAttachments(surface) ? 'the user receives the file itself here, as an attachment' : 'a link to the file is posted here for you'}. When the user asks for a file in a particular format, build it yourself in the sandbox and send it this way. Do not send a file you downloaded from the internet unless the user asked for that exact file. Never paste a download link, and do not describe how to open or download it. Do not send helper scripts or intermediate files. Call it once per file, after the sandbox call that saved the file has finished.`,
        ]
      : []),
    artifacts
      ? `- Use \`create_artifact\` ${files ? 'for a document with no particular file format' : 'only when the user asks for a document or file'}, or when the output is genuinely document-length: several screens of text, long code, a long report. Even then, its message carries the conclusions, decisions and next actions, and the document holds the detail. Call it last: the user gets the message, the document, then at most one follow-up question.`
      : '- Everything you write is delivered as messages; when something is genuinely long, put the essential part first.',
    '- The user sees a typing indicator while you work. Do not narrate your steps or announce tool calls.',
    '- End with at most one question.',
  ].join('\n');
}
