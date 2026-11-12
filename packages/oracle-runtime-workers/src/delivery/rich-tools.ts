/**
 * The rich-message tools every oracle gets on a turn whose gateway can show
 * them (`render`): `offer_choices`, `send_link_button`, `send_cards`. Each
 * returns a `ToolMessage` whose artifact carries one part (`withRichParts`
 * shape); the Reply Plan delivers it where the call stands in the turn.
 * What the model reads says which format went out and holds the part's text
 * version, so the history reads the same on every surface.
 */
import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper';
import type { PluginTool } from '../plugin-api/types';
import {
  cardsPart,
  choicesPart,
  chooseFormat,
  codePointLength,
  richPartsOf,
  isSingleLine,
  LINK_LABELS,
  linkButtonPart,
  linkButtonText,
  OPTION_KEY,
  RICH_LIMITS,
  RICH_PARTS_KEY,
  type ChoiceFormat,
} from './rich';
import type { RenderCapability, RichContent } from './types';

export const OFFER_CHOICES_TOOL = 'offer_choices';
export const SEND_LINK_BUTTON_TOOL = 'send_link_button';
export const SEND_CARDS_TOOL = 'send_cards';

/** Tools whose parts stand where the call stands in the turn. */
export const RICH_MESSAGE_TOOLS: ReadonlySet<string> = new Set([
  OFFER_CHOICES_TOOL,
  SEND_LINK_BUTTON_TOOL,
  SEND_CARDS_TOOL,
]);

const line = (max: number) =>
  z.string().trim().min(1).max(max).refine(isSingleLine, 'must be one line');

const FORMAT_WORDS: Record<ChoiceFormat, string> = {
  buttons: 'as reply buttons',
  list: 'as a list menu',
  text: 'as a numbered list in a normal message',
};

function result(
  name: string,
  callId: string | undefined,
  content: Record<string, unknown>,
  part: RichContent | { kind: 'text'; text: string },
): ToolMessage {
  return new ToolMessage({
    tool_call_id: callId ?? '',
    name,
    content: JSON.stringify(content),
    // A text part rides as a rich artifact too, so it stands where the call
    // stands: the plan delivers it as an ordinary message.
    artifact:
      part.kind === 'text'
        ? { [RICH_PARTS_KEY]: [], text: part.text }
        : { [RICH_PARTS_KEY]: [part] },
  });
}

/** The text a rich tool's call delivers when it went out as plain text. */
export function richToolTextOf(artifact: unknown): string | null {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
    return null;
  const text: unknown = Reflect.get(artifact, 'text');
  return typeof text === 'string' && text.trim() ? text : null;
}

/**
 * Why a set of options would go out as text only because a title or
 * description is too long, naming each with its length; null when it fits
 * a format, or when no interactive format could carry it anyway (more than
 * 10 options, or neither buttons nor a list available here).
 */
export function titlesTooLong(
  options: readonly { title: string; description?: string }[],
  render: RenderCapability,
): string | null {
  const trimmed = options.map((o) => ({
    title: o.title.trim(),
    ...(o.description?.trim() ? { description: o.description.trim() } : {}),
  }));
  if (chooseFormat(trimmed, render) !== 'text') return null;
  const buttons = render.kinds.includes('reply_buttons');
  const list = render.kinds.includes('list');
  if (trimmed.length > RICH_LIMITS.listRows || (!buttons && !list)) return null;
  // The limit the set is aiming at: buttons for 2–3 options without a
  // description where buttons exist, else a list.
  const aim =
    buttons &&
    (!list ||
      (trimmed.length <= RICH_LIMITS.buttonOptions &&
        trimmed.every((o) => o.description === undefined)))
      ? RICH_LIMITS.buttonTitle
      : RICH_LIMITS.rowTitle;
  const long = [
    ...trimmed
      .filter((o) => codePointLength(o.title) > aim)
      .map(
        (o) => `title "${o.title}" is ${codePointLength(o.title)} characters`,
      ),
    ...trimmed
      .filter(
        (o) =>
          o.description !== undefined &&
          codePointLength(o.description) > RICH_LIMITS.rowDescription,
      )
      .map(
        (o) =>
          `the description of "${o.title}" is ${codePointLength(o.description ?? '')} characters`,
      ),
  ];
  if (long.length === 0) return null;
  return `${long.join('; ')}. Titles must be ${RICH_LIMITS.buttonTitle} characters or fewer for buttons (2–3 options) or ${RICH_LIMITS.rowTitle} or fewer for a list; put extra detail in description (${RICH_LIMITS.rowDescription} or fewer).`;
}

/**
 * Ends the reply once `offer_choices` sent its choices message: the
 * question is the reply's last message. Runs before the next model call, so
 * a call sent back for shorter titles (no message went out) lets the model
 * call again.
 */
export function createChoicesEndMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: 'ChoicesEndMiddleware',
    beforeModel: {
      canJumpTo: ['end'],
      hook: (state): { jumpTo: 'end' } | undefined => {
        const messages: unknown[] = state.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (!ToolMessage.isInstance(message)) break;
          if (
            message.name === OFFER_CHOICES_TOOL &&
            (richPartsOf(message.artifact).length > 0 ||
              richToolTextOf(message.artifact) !== null)
          )
            return { jumpTo: 'end' };
        }
        return undefined;
      },
    },
  });
}

const labelsLine = (render: RenderCapability) =>
  render.linkLabels.map((key) => `"${key}" (${LINK_LABELS[key]})`).join(', ');

/**
 * The tools a turn with `render` gets, only those whose element kinds the
 * gateway listed. `offer_choices` ends the reply (the question is the last
 * message) and runs once per turn.
 */
export function buildRichMessageTools(
  render: RenderCapability,
): Array<{ tool: PluginTool; returnDirect: boolean }> {
  const tools: Array<{ tool: PluginTool; returnDirect: boolean }> = [];
  const canChoose =
    render.kinds.includes('reply_buttons') || render.kinds.includes('list');
  const canLink =
    render.kinds.includes('link_button') &&
    render.linkLabels.length > 0 &&
    render.linkOrigins.length > 0;
  const canCard =
    (render.kinds.includes('card') || render.kinds.includes('carousel')) &&
    render.linkLabels.length > 0 &&
    render.linkOrigins.length > 0;
  const labelKey = z.string().describe(`One of: ${labelsLine(render)}.`);

  if (canChoose) {
    // Per turn: whether a choices message went out, and whether a call was
    // already sent back for shorter titles (one retry at most, never a loop).
    let offered = false;
    let retried = false;
    const schema = z.object({
      question: z
        .string()
        .trim()
        .min(1)
        .max(RICH_LIMITS.body)
        .describe(
          'The question, as the message the options belong to. Do not also write it in your reply.',
        ),
      options: z
        .array(
          z.object({
            id: z
              .string()
              .regex(OPTION_KEY)
              .optional()
              .describe(
                'Optional short id (letters, digits, _ or -) you will recognise when it is tapped; default: its position.',
              ),
            title: line(100).describe(
              'What the person taps: a few words, 20 characters or fewer ("Find jobs", "My wallet", "Get help"); at most 24 in a list. Put the rest in description.',
            ),
            description: line(200)
              .optional()
              .describe('Optional second line, up to 72 characters.'),
          }),
        )
        .min(2)
        .max(20),
      menuLabel: line(RICH_LIMITS.menuLabel)
        .optional()
        .describe(
          `Label of the button that opens a list (at most ${RICH_LIMITS.menuLabel} characters). Default "Choose".`,
        ),
    });
    tools.push({
      // It ends the reply once a choices message went out
      // (`createChoicesEndMiddleware`), not on every call: a call sent back
      // for shorter titles must let the model call again.
      returnDirect: false,
      tool: tool(
        async (rawArgs, ctx) => {
          const args = schema.parse(rawArgs);
          if (offered)
            return 'Not sent: only one choices message is sent per reply, and one was sent already.';
          const tooLong = retried ? null : titlesTooLong(args.options, render);
          if (tooLong) {
            retried = true;
            return `Not sent yet: ${tooLong} Call offer_choices again now with shorter titles (the same options, a few words each, extra detail in description); write nothing else first. If a title cannot be shorter, call it again as it is and the options go out as a numbered list.`;
          }
          const built = choicesPart(
            {
              body: args.question,
              options: args.options.map((o) => ({
                ...(o.id ? { key: o.id } : {}),
                title: o.title,
                ...(o.description ? { description: o.description } : {}),
              })),
              ...(args.menuLabel ? { menuLabel: args.menuLabel } : {}),
            },
            render,
          );
          offered = true;
          return result(
            OFFER_CHOICES_TOOL,
            ctx.toolCallId,
            {
              status: 'asked',
              format: built.format,
              options: built.options.map((o, i) => ({
                id: args.options[i]?.id ?? String(i + 1),
                title: o.title,
              })),
              note: `The question was sent ${FORMAT_WORDS[built.format]}, and your reply ends with it. Their answer comes as their next message: a tap arrives as the option's title with a note naming the option; they may also type an answer, a number, or something else.`,
              shown: built.part.text,
            },
            built.part,
          );
        },
        {
          name: OFFER_CHOICES_TOOL,
          description: [
            'Ask the person to pick one of a set of options, shown as tappable reply buttons or a list menu where the chat supports them, and as a numbered list everywhere else.',
            'Titles are what the person taps: write them like "Find jobs", "My wallet", "Get help": 20 characters or fewer, never a sentence; use description (72 characters or fewer) for the rest. 2–3 options with titles of 20 or fewer and no descriptions become buttons; up to 10 options with titles of 24 or fewer become a list. A call whose titles are too long is sent back once so you can shorten them; nothing is ever cut. More than 10 options go out as a numbered list.',
            'Use it whenever your reply would end with a numbered or bulleted list of options for the person to pick one from: a menu of what you can help with or what to do next, a pick-one question (which job, which plan, which day), a yes/no confirmation. This includes menus that other instructions tell you to show as a numbered list: where buttons cannot be shown, the person receives exactly that numbered list. Keep each title short (the option itself, not a sentence). Never use it for open questions (a name, an amount, a description of their situation).',
            'It ends your reply: write anything you need to say first, in the same step, then call it with the question. Do not write the question or the options in your text. At most one per reply.',
          ].join('\n\n'),
          schema,
          effect: 'read',
        },
      ),
    });
  }

  if (canLink) {
    const schema = z.object({
      text: z
        .string()
        .trim()
        .min(1)
        .max(RICH_LIMITS.body)
        .describe(
          'The message above the button: what the link is for and what happens there. Without the link itself.',
        ),
      url: z.string().url().describe('The https link the button opens.'),
      label: labelKey,
      imageUrl: z
        .string()
        .url()
        .optional()
        .describe(
          'Optional picture shown above the text: a public https image link anyone can open without signing in.',
        ),
    });
    tools.push({
      returnDirect: false,
      tool: tool(
        async (rawArgs, ctx) => {
          const args = schema.parse(rawArgs);
          const built = linkButtonPart(
            {
              body: args.text,
              url: args.url,
              label: args.label,
              ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
            },
            render,
          );
          const part: RichContent | { kind: 'text'; text: string } =
            built.part ?? {
              kind: 'text',
              text: linkButtonText({
                body: args.text,
                url: args.url,
                label: args.label,
                ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
              }),
            };
          return result(
            SEND_LINK_BUTTON_TOOL,
            ctx.toolCallId,
            {
              status: 'sent',
              format: built.part ? 'link_button' : 'text',
              ...(built.reason ? { reason: built.reason } : {}),
              note: built.part
                ? 'Sent as a message with a button that opens the link, where this call stands in your reply. Do not repeat the link or its text.'
                : 'Sent as a normal message with the link written out, where this call stands in your reply. Do not repeat the link or its text.',
              shown: part.text,
            },
            part,
          );
        },
        {
          name: SEND_LINK_BUTTON_TOOL,
          description: [
            'Send a message with one button that opens a link: a tidy way to hand over a link the person must open (a sign-in, a form, a check, a page to register on). Where buttons are not available, or the link is not on an approved site, the same message goes out as text with the link written out.',
            `The button label comes from a fixed set; pick the key that fits: ${labelsLine(render)}. The text (up to ${RICH_LIMITS.body} characters) says what the link is for; it must read well on its own as a normal message. An optional picture link must be a public https image link anyone can open; private or signed-in links do not show.`,
            'Use it for a link the person needs to act on, not for every link you mention. Write what you want to say before it in the same step; do not repeat the link in your text.',
          ].join('\n\n'),
          schema,
          effect: 'read',
        },
      ),
    });
  }

  if (canCard) {
    const schema = z.object({
      intro: z
        .string()
        .trim()
        .min(1)
        .max(RICH_LIMITS.body)
        .describe('One line introducing the cards.'),
      cards: z
        .array(
          z.object({
            title: line(RICH_LIMITS.cardTitle).describe(
              'Short title, bold on the card.',
            ),
            text: z
              .string()
              .trim()
              .max(RICH_LIMITS.body)
              .describe(
                'The card text. With 2 or more cards, title and text together must stay within 157 characters, with at most one line break.',
              ),
            imageUrl: z
              .string()
              .url()
              .describe(
                'A public https image link anyone can open without signing in.',
              ),
            url: z
              .string()
              .url()
              .describe('The https link the card button opens.'),
            label: labelKey,
          }),
        )
        .min(1)
        .max(RICH_LIMITS.cardsMax),
    });
    tools.push({
      returnDirect: false,
      tool: tool(
        async (rawArgs, ctx) => {
          const args = schema.parse(rawArgs);
          const built = cardsPart(
            {
              body: args.intro,
              items: args.cards.map((card) => ({
                title: card.title,
                body: card.text,
                imageUrl: card.imageUrl,
                link: { url: card.url, label: card.label },
              })),
            },
            render,
          );
          const format = built.reason
            ? 'text'
            : args.cards.length === 1
              ? 'card'
              : 'carousel';
          return result(
            SEND_CARDS_TOOL,
            ctx.toolCallId,
            {
              status: 'sent',
              format,
              ...(built.reason ? { reason: built.reason } : {}),
              note:
                format === 'text'
                  ? 'Sent as one normal message listing the items with their links, where this call stands in your reply. Do not repeat them.'
                  : `Sent as ${format === 'card' ? 'an image card' : 'a carousel of image cards'}, each with a button, where this call stands in your reply. Do not repeat the items.`,
              shown: built.part.text,
            },
            built.part,
          );
        },
        {
          name: SEND_CARDS_TOOL,
          description: [
            'Show items to browse as image cards, each with a picture, a short text and one link button: one card alone, or a swipeable carousel of 2 to 10. Where cards are not available, they go out as one message listing each item with its picture link and link.',
            `Every card has a public https image link (anyone must be able to open it; private or signed-in images do not show), a title, a short text and a link with a label from the fixed set: ${labelsLine(render)}. With 2 or more cards, title and text together stay within 157 characters with at most one line break in the text. If any card does not fit, or its link is not on an approved site, all of them go out as text.`,
            'Use it for a few concrete things the person may want to look at or open (opportunities, products, places), not for ordinary answers. Do not repeat the items in your text.',
          ].join('\n\n'),
          schema,
          effect: 'read',
        },
      ),
    });
  }
  return tools;
}
