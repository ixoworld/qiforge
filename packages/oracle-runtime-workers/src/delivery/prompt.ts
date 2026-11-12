import {
  FILE_SAFETY_NOTE,
  SENDABLE_FILE_TYPES,
} from '../plugins/sandbox/send-file';
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
 * The section for the rich-message tools bound this turn, placed after the
 * oracle's own instructions so it is read last and its precedence over an
 * instruction to write choices as a list is plain. Generic: any oracle, any
 * reply. Empty when no rich tool is bound.
 */
export function renderRichSection(tools: readonly string[]): string {
  if (tools.length === 0) return '';
  const lines = [
    '## Buttons in this chat',
    '',
    'This chat can show buttons. They decide how choices and links are shown, not what you say, and they take precedence over any instruction above to show choices as a numbered or bulleted list: chats without buttons still receive that list.',
    '',
    ...(tools.includes('offer_choices')
      ? [
          '- Before you send a reply, check how it ends. If it asks a closed question, one the person answers by picking from options you can name, do not write those options in your text, neither as a list nor in a sentence: call `offer_choices` with a short question and the options, each title a few words. Closed questions include a menu of what you can help with or what to do next, which one of a few named items, this or that, and yes or no (titles like "Yes, start now" and "Not now"). A lead-in, if any, is one short line of text before the call. Example: asked "what can you help me with?", write at most one short line, then call `offer_choices` with the question "What would you like to do?" and one option per thing you can do ("Book a visit", "See prices", "Talk to someone").',
          '- An open question, one the person answers in their own words (their name, an amount, what they are interested in, their situation), stays text, even with a few examples in it. At most one `offer_choices` per reply.',
        ]
      : []),
    ...(tools.includes('send_link_button')
      ? [
          '- A link the person must open (a sign-in, a form, a page to register or apply on) goes out with `send_link_button` instead of in your text.',
        ]
      : []),
    ...(tools.includes('send_cards')
      ? [
          '- A few concrete items to browse that each have a picture and a link (opportunities, places, products) can go out with `send_cards`.',
        ]
      : []),
    '- Each of these tools sends its message as the last of your reply: write what you need to say first, in the same step, and nothing after it (no "Done.", no repeat of what it sent).',
  ];
  return lines.join('\n');
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
          `- Deliver every file meant for the user with \`send_file\` (${SENDABLE_FILE_TYPES} only): ${deliversAttachments(surface) ? 'the user receives the file itself here, as an attachment' : 'a link to the file is posted here for you'}. When the user asks for a file in a particular format, build it yourself in the sandbox and send it this way. Do not send a file you downloaded from the internet unless the user asked for that exact file. Never paste a download link, and do not describe how to open or download it. Do not send helper scripts or intermediate files. Call it once per file, after the sandbox call that saved the file has finished.${deliversAttachments(surface) ? ` ${FILE_SAFETY_NOTE}` : ''}`,
        ]
      : []),
    artifacts
      ? `- Use \`create_artifact\` ${files ? 'for a document with no particular file format' : 'only when the user asks for a document or file'}, or when the output is genuinely document-length: several screens of text, long code, a long report. Even then, its message carries the conclusions, decisions and next actions, and the document holds the detail. Call it last: the user gets the message, the document, then at most one follow-up question.`
      : '- Everything you write is delivered as messages; when something is genuinely long, put the essential part first.',
    '- The user sees a typing indicator while you work. Do not narrate your steps or announce tool calls.',
    '- End with at most one question.',
  ].join('\n');
}
