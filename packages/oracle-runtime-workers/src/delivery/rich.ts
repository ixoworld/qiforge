/**
 * Rich messages: reply buttons, list menus, link buttons and image cards on
 * a chat surface whose gateway can show them (today WhatsApp through IXO
 * Channels), while the same Reply Plan reads as plain text everywhere else.
 *
 * The gateway says what it can show on each turn (`render`, see
 * `RenderCapabilityWire`); only then are the rich-message tools offered and
 * rich parts emitted. Every rich part carries its whole channel-neutral
 * fallback in `text`: what Matrix, the room mirror, quotes and the thread's
 * history show, and what the gateway sends when it cannot show the part.
 *
 * This module holds the rules both the model's tools (`rich-tools.ts`) and
 * plugin code use: the WhatsApp limits, the fixed link-button labels, the
 * format choice for a set of options, and the text renderings.
 */
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type {
  CardItem,
  ChoiceOption,
  RenderCapability,
  RenderKind,
  RichContent,
} from './types';

/** The turn-result feature that tells a gateway it may send `render` and `choice`. */
export const RICH_MESSAGES_FEATURE = 'rich_messages';

export const RENDER_KINDS: readonly RenderKind[] = [
  'reply_buttons',
  'list',
  'link_button',
  'card',
  'carousel',
];

/**
 * The fixed link-button labels: the key travels, the gateway shows its own
 * text for it (translatable later). The English label is used in text
 * fallbacks. Each label is at most 20 characters (WhatsApp's limit).
 */
export const LINK_LABELS: Readonly<Record<string, string>> = {
  open: 'Open',
  allow: 'Allow',
  start_check: 'Start check',
  sign_in: 'Sign in',
  view: 'View',
  register: 'View & register',
  continue: 'Continue',
};

/**
 * WhatsApp's limits (Meta's Cloud API guides for reply buttons, list
 * messages, CTA URL buttons and media carousels, checked 2026-11-12), in
 * code points. Every body uses 1,024: the most every interactive kind and
 * vendor takes.
 */
export const RICH_LIMITS = {
  body: 1024,
  buttonOptions: 3,
  buttonTitle: 20,
  listRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  menuLabel: 20,
  carouselMin: 2,
  cardsMax: 10,
  /** A carousel card's text (`*title*\nbody`). */
  cardText: 160,
  /** Line breaks in a carousel card's text, the title's own included. */
  cardLineBreaks: 2,
  cardTitle: 60,
  url: 2000,
} as const;

/** The list's menu button label when none is given. */
export const DEFAULT_MENU_LABEL = 'Choose';

const KEY = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The `render` object a gateway adds to a turn once it has seen
 * `rich_messages` in a turn result. Unknown kinds and labels pass (and are
 * dropped by `renderCapabilityOf`), so a newer gateway never breaks an
 * older runtime.
 */
export const RenderCapabilityWire = z.strictObject({
  v: z.literal(1),
  kinds: z.array(z.string().regex(KEY)).max(16),
  linkLabels: z.array(z.string().regex(KEY)).max(32),
  linkOrigins: z.array(z.string().min(1).max(200)).max(32),
});
export type RenderCapabilityWire = z.infer<typeof RenderCapabilityWire>;

/** An https origin exactly as `URL.origin` prints it, or null. */
function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/** The wire object, with only the kinds, labels and origins this runtime can use. */
export function renderCapabilityOf(
  wire: RenderCapabilityWire,
): RenderCapability {
  return {
    kinds: RENDER_KINDS.filter((kind) => wire.kinds.includes(kind)),
    linkLabels: Object.keys(LINK_LABELS).filter((key) =>
      wire.linkLabels.includes(key),
    ),
    linkOrigins: [
      ...new Set(
        wire.linkOrigins.flatMap((origin) => {
          const ok = httpsOrigin(origin);
          return ok ? [ok] : [];
        }),
      ),
    ],
  };
}

/** Length as WhatsApp counts it: code points. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

const LINE_BREAK = /[\r\n\u2028\u2029]/;

export function isSingleLine(text: string): boolean {
  return !LINE_BREAK.test(text);
}

function lineBreaks(text: string): number {
  return (text.match(/\r\n|[\r\n\u2028\u2029]/g) ?? []).length;
}

/**
 * Characters that make one link string read differently by different
 * parsers (WHATWG drops or rewrites them; WhatsApp's client, the gateway or
 * a browser may not): a backslash, any whitespace, control or format
 * character (bidi marks, zero-width characters).
 */
const AMBIGUOUS_LINK = /[\\\s\p{Cc}\p{Cf}]/u;

/**
 * A link a button, a card or an image header may carry: the raw string has
 * no ambiguous character, it parses once as https without credentials, and
 * its `href` stays within `RICH_LIMITS.url`. Every check (the origin
 * included) runs on the returned URL, and only its `href` is ever sent, so
 * what was checked is what goes out. Null otherwise.
 */
export function safeHttpsUrl(raw: string): URL | null {
  if (raw.length > RICH_LIMITS.url || AMBIGUOUS_LINK.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href.length > RICH_LIMITS.url ? null : url;
}

/** Whether `raw` passes `safeHttpsUrl`. */
export function isPublicHttpsUrl(raw: string): boolean {
  return safeHttpsUrl(raw) !== null;
}

/**
 * A link as a text version shows it: the parsed, normalised `href` without
 * credentials (so `https://good@evil.example/` shows as
 * `https://evil.example/`, where it really goes), for http and https only.
 * Null for anything else (`javascript:`, `data:`, unparseable): a text
 * version never repeats an odd raw string.
 */
export function displayLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.username = '';
  url.password = '';
  return url.href;
}

/** Why a link cannot be a button on this turn, or null when it can. */
export function linkRefusal(
  url: string,
  label: string,
  render: RenderCapability,
): string | null {
  if (!render.kinds.includes('link_button'))
    return 'link buttons are not available here';
  const parsed = safeHttpsUrl(url);
  if (!parsed) return 'the link is not a plain https link';
  // `origin` of the parsed URL: lower-case, punycode (ASCII) host, so a
  // look-alike or a trailing-dot host never matches an approved origin.
  if (!render.linkOrigins.includes(parsed.origin))
    return 'the link is not on an approved site';
  if (!render.linkLabels.includes(label))
    return `the label "${label}" is not one of the fixed labels`;
  return null;
}

/**
 * `Label: url` (the bare link for an unknown label), the link as
 * `displayLink` shows it; nothing when it shows none.
 */
function labelledLink(label: string, url: string): string[] {
  const link = displayLink(url);
  if (!link) return [];
  const shown = Object.hasOwn(LINK_LABELS, label) ? LINK_LABELS[label] : null;
  return [shown ? `${shown}: ${link}` : link];
}

/** `Image: url` as `displayLink` shows it; nothing when it shows none. */
function imageLine(url: string | undefined): string[] {
  const link = url === undefined ? null : displayLink(url);
  return link ? [`Image: ${link}`] : [];
}

// ── Text renderings ─────────────────────────────────────────────────────

/** A question and its options as text: the body, then a numbered list. */
export function choicesText(
  body: string,
  options: readonly { title: string; description?: string }[],
): string {
  const lines = options.map(
    (option, i) =>
      `${i + 1}. ${option.title}${option.description ? ` — ${option.description}` : ''}`,
  );
  return `${body}\n\n${lines.join('\n')}`;
}

/** A link button as text: the body, the image link if any, `Label: url`. */
export function linkButtonText(input: {
  body: string;
  url: string;
  label: string;
  imageUrl?: string;
}): string {
  return [
    input.body,
    ...(textHasLink(input.body, input.imageUrl)
      ? []
      : imageLine(input.imageUrl)),
    ...(textHasLink(input.body, input.url)
      ? []
      : labelledLink(input.label, input.url)),
  ].join('\n\n');
}

/**
 * Whether `text` already holds the link (as given, or as its normalised
 * `href` with or without a trailing slash): a text version then does not
 * add it again.
 */
export function textHasLink(text: string, url: string | undefined): boolean {
  if (!url) return false;
  const href = displayLink(url);
  const forms = [url, ...(href ? [href, href.replace(/\/$/, '')] : [])];
  return forms.some((form) => {
    if (!form) return false;
    // A whole link only: "https://a.example" is not in "https://a.example/b".
    for (
      let at = text.indexOf(form);
      at >= 0;
      at = text.indexOf(form, at + 1)
    ) {
      const rest = text.slice(at + form.length);
      if (rest === '' || /^(?:[.,;:!?]*(?:\s|$)|[\s)\]>"'])/u.test(rest))
        return true;
    }
    return false;
  });
}

/**
 * Cards as text: the intro, then each card numbered, its title bold, its
 * text, its image link (always) and `Label: url`.
 */
export function cardsText(intro: string, items: readonly CardItem[]): string {
  return [
    intro,
    ...items.map((item, i) =>
      [
        `${i + 1}. **${item.title}**`,
        ...(item.body ? [item.body] : []),
        ...(textHasLink(item.body, item.imageUrl)
          ? []
          : imageLine(item.imageUrl)),
        ...(textHasLink(item.body, item.link.url)
          ? []
          : labelledLink(item.link.label, item.link.url)),
      ].join('\n'),
    ),
  ].join('\n\n');
}

// ── Choices ─────────────────────────────────────────────────────────────

/** The prefix of every oracle choice id: never one of the gateway's own ids. */
export const CHOICE_ID_PREFIX = 'oc:';

/** A model- or plugin-given option key. */
export const OPTION_KEY = /^[A-Za-z0-9_-]{1,32}$/;

const CHOICE_ID = /^oc:([0-9a-f]{8}):([A-Za-z0-9_-]{1,32})$/;

/** `oc:<offer>:<key>`. */
export function choiceId(offerId: string, key: string): string {
  return `${CHOICE_ID_PREFIX}${offerId}:${key}`;
}

/** The offer and option key of an oracle choice id, or null. */
export function parseChoiceId(
  id: string,
): { offerId: string; key: string } | null {
  const match = CHOICE_ID.exec(id);
  return match ? { offerId: match[1]!, key: match[2]! } : null;
}

/** A fresh offer id: 8 hex characters. */
export function newOfferId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type ChoiceFormat = 'buttons' | 'list' | 'text';

/**
 * How a set of options is shown:
 *
 * 1. 2–3 options, every title at most 20 characters, no description, reply
 *    buttons available → `buttons`;
 * 2. else 2–10 options, every title at most 24 and every description at
 *    most 72 characters, a list available → `list`;
 * 3. else → `text` (a numbered list).
 *
 * Nothing is cut: an option that does not fit moves the whole set on to the
 * next format. A title or description with a line break fits nowhere but text.
 */
export function chooseFormat(
  options: readonly { title: string; description?: string }[],
  render: RenderCapability | undefined,
): ChoiceFormat {
  if (!render || options.length < 2) return 'text';
  const single = options.every(
    (o) =>
      isSingleLine(o.title) &&
      (o.description === undefined || isSingleLine(o.description)),
  );
  if (!single) return 'text';
  if (
    render.kinds.includes('reply_buttons') &&
    options.length <= RICH_LIMITS.buttonOptions &&
    options.every(
      (o) =>
        codePointLength(o.title) <= RICH_LIMITS.buttonTitle &&
        o.description === undefined,
    )
  )
    return 'buttons';
  if (
    render.kinds.includes('list') &&
    options.length <= RICH_LIMITS.listRows &&
    options.every(
      (o) =>
        codePointLength(o.title) <= RICH_LIMITS.rowTitle &&
        (o.description === undefined ||
          codePointLength(o.description) <= RICH_LIMITS.rowDescription),
    )
  )
    return 'list';
  return 'text';
}

export interface ChoicesInput {
  body: string;
  options: readonly { key?: string; title: string; description?: string }[];
  /** The list's menu button label; `DEFAULT_MENU_LABEL` when absent. */
  menuLabel?: string;
}

/**
 * A question with options as a part: `choices` in the format
 * `chooseFormat` picks, or a `text` part with the numbered list. Option
 * keys default to their position (`1`, `2`, …). Throws a `TypeError` for
 * input no format can carry (fewer than two options, a blank or too long
 * body, a duplicate key or title, a bad key or menu label): a mistake in
 * the caller, not a reason to fall back.
 */
export function choicesPart(
  input: ChoicesInput,
  render: RenderCapability | undefined,
  offerId: string = newOfferId(),
): {
  format: ChoiceFormat;
  part: RichContent | { kind: 'text'; text: string };
  options: ChoiceOption[];
} {
  const body = input.body.trim();
  if (!body || codePointLength(body) > RICH_LIMITS.body)
    throw new TypeError(
      `choices: the question must be 1 to ${RICH_LIMITS.body} characters.`,
    );
  if (input.options.length < 2)
    throw new TypeError('choices: give at least two options.');
  const menuLabel = input.menuLabel?.trim() || DEFAULT_MENU_LABEL;
  if (
    codePointLength(menuLabel) > RICH_LIMITS.menuLabel ||
    !isSingleLine(menuLabel)
  )
    throw new TypeError(
      `choices: the menu label must be one line of at most ${RICH_LIMITS.menuLabel} characters.`,
    );
  const keys = new Set<string>();
  const titles = new Set<string>();
  const options: ChoiceOption[] = input.options.map((option, i) => {
    const key = option.key ?? String(i + 1);
    const title = option.title.trim();
    const description = option.description?.trim() || undefined;
    if (!OPTION_KEY.test(key) || keys.has(key))
      throw new TypeError(
        `choices: option ids must be distinct and match ${OPTION_KEY.source}.`,
      );
    if (!title || titles.has(title.toLowerCase()))
      throw new TypeError(
        'choices: option titles must be distinct and not blank.',
      );
    keys.add(key);
    titles.add(title.toLowerCase());
    return {
      id: choiceId(offerId, key),
      title,
      ...(description ? { description } : {}),
    };
  });
  const format = chooseFormat(options, render);
  const text = choicesText(body, options);
  if (format === 'text')
    return { format, part: { kind: 'text', text }, options };
  return {
    format,
    options,
    part: {
      kind: 'choices',
      text,
      choices: {
        body,
        style: format,
        ...(format === 'list' ? { button: menuLabel } : {}),
        options,
      },
    },
  };
}

// ── Link button ─────────────────────────────────────────────────────────

export interface LinkButtonInput {
  body: string;
  url: string;
  label: string;
  imageUrl?: string;
  /**
   * The text version (other surfaces, and when the button cannot be shown).
   * Default: the body, the image link if any and `Label: url`.
   */
  fallback?: string;
}

/**
 * A message with a link button, or null when this turn cannot show one
 * (no `render`, the link's origin not approved, an unknown label, a body
 * too long or an image link that is not https), with the reason.
 */
export function linkButtonPart(
  input: LinkButtonInput,
  render: RenderCapability | undefined,
): { part: RichContent; reason: null } | { part: null; reason: string } {
  const body = input.body.trim();
  if (!render)
    return { part: null, reason: 'rich messages are not available here' };
  const refused = linkRefusal(input.url, input.label, render);
  if (refused) return { part: null, reason: refused };
  if (!body || codePointLength(body) > RICH_LIMITS.body)
    return {
      part: null,
      reason: `the text must be 1 to ${RICH_LIMITS.body} characters`,
    };
  const image =
    input.imageUrl === undefined ? undefined : safeHttpsUrl(input.imageUrl);
  if (image === null)
    return { part: null, reason: 'the image link is not a plain https link' };
  // What was checked is what is sent: the parsed `href`s, also in the
  // default text version.
  const url = safeHttpsUrl(input.url)!.href;
  const imageUrl = image?.href;
  return {
    reason: null,
    part: {
      kind: 'link_button',
      text:
        input.fallback ??
        linkButtonText({
          body,
          url,
          label: input.label,
          ...(imageUrl ? { imageUrl } : {}),
        }),
      link: {
        body,
        url,
        label: input.label,
        ...(imageUrl ? { imageUrl } : {}),
      },
    },
  };
}

// ── Cards ───────────────────────────────────────────────────────────────

/** Why these cards cannot be shown on this turn, or null when they can. */
export function cardsRefusal(
  intro: string,
  items: readonly CardItem[],
  render: RenderCapability,
): string | null {
  if (items.length < 1 || items.length > RICH_LIMITS.cardsMax)
    return `give 1 to ${RICH_LIMITS.cardsMax} cards`;
  const carousel = items.length >= RICH_LIMITS.carouselMin;
  if (!render.kinds.includes(carousel ? 'carousel' : 'card'))
    return carousel
      ? 'a carousel is not available here'
      : 'an image card is not available here';
  if (!intro || codePointLength(intro) > RICH_LIMITS.body)
    return `the intro must be 1 to ${RICH_LIMITS.body} characters`;
  for (const [i, item] of items.entries()) {
    const n = i + 1;
    if (
      !item.title ||
      !isSingleLine(item.title) ||
      codePointLength(item.title) > RICH_LIMITS.cardTitle
    )
      return `card ${n}: the title must be one line of 1 to ${RICH_LIMITS.cardTitle} characters`;
    const cardText = `*${item.title}*\n${item.body}`;
    if (carousel) {
      if (codePointLength(cardText) > RICH_LIMITS.cardText)
        return `card ${n}: title and text together must stay within ${RICH_LIMITS.cardText - 3} characters in a carousel`;
      if (lineBreaks(cardText) > RICH_LIMITS.cardLineBreaks)
        return `card ${n}: the text may have at most ${RICH_LIMITS.cardLineBreaks - 1} line break in a carousel`;
    } else if (codePointLength(cardText) > RICH_LIMITS.body)
      return `card ${n}: title and text together must stay within ${RICH_LIMITS.body - 3} characters`;
    if (!isPublicHttpsUrl(item.imageUrl))
      return `card ${n}: the image link is not a plain https link`;
    const link = linkRefusal(item.link.url, item.link.label, render);
    if (link) return `card ${n}: ${link}`;
  }
  return null;
}

/**
 * One image card (one item) or a carousel (2 to 10), or the text version
 * of all of them when any card cannot be shown, with the reason.
 */
export function cardsPart(
  input: { body: string; items: readonly CardItem[] },
  render: RenderCapability | undefined,
):
  | { part: RichContent; reason: null }
  | { part: { kind: 'text'; text: string }; reason: string } {
  const intro = input.body.trim();
  const items = input.items.map((item) => ({
    ...item,
    title: item.title.trim(),
    body: item.body.trim(),
  }));
  const text = cardsText(intro, items);
  const refused = render
    ? cardsRefusal(intro, items, render)
    : 'rich messages are not available here';
  if (refused) return { part: { kind: 'text', text }, reason: refused };
  // Every link passed `safeHttpsUrl`: send (and show) the parsed `href`s.
  const sent = items.map((item) => ({
    ...item,
    imageUrl: safeHttpsUrl(item.imageUrl)!.href,
    link: { ...item.link, url: safeHttpsUrl(item.link.url)!.href },
  }));
  return {
    reason: null,
    part: {
      kind: 'cards',
      text: cardsText(intro, sent),
      cards: { body: intro, items: sent },
    },
  };
}

// ── Plan wire shapes ────────────────────────────────────────────────────

const plain = z.string().min(1);
const OptionSchema = z.object({
  id: plain,
  title: plain,
  description: plain.optional(),
});
const LinkSchema = z.object({ url: plain, label: plain });

/** The rich parts' content as a stored plan or a tool's artifact holds it. */
export const RichContentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choices'),
    text: plain,
    choices: z.object({
      body: plain,
      style: z.enum(['buttons', 'list']),
      button: plain.optional(),
      options: z.array(OptionSchema).min(2).max(RICH_LIMITS.listRows),
    }),
  }),
  z.object({
    kind: z.literal('link_button'),
    text: plain,
    link: z.object({
      body: plain,
      url: plain,
      label: plain,
      imageUrl: plain.optional(),
    }),
  }),
  z.object({
    kind: z.literal('cards'),
    text: plain,
    cards: z.object({
      body: plain,
      items: z
        .array(
          z.object({
            title: plain,
            body: z.string(),
            imageUrl: plain,
            link: LinkSchema,
          }),
        )
        .min(1)
        .max(RICH_LIMITS.cardsMax),
    }),
  }),
]);

// ── Tool results that carry rich parts ──────────────────────────────────

/** The key of `ToolMessage.artifact` that holds a call's rich parts. */
export const RICH_PARTS_KEY = 'richParts';

const RichPartsSchema = z.array(RichContentSchema).min(1).max(4);

/** The rich parts a call's `ToolMessage.artifact` carries; `[]` for anything else. */
export function richPartsOf(artifact: unknown): RichContent[] {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
    return [];
  const parsed = RichPartsSchema.safeParse(
    Reflect.get(artifact, RICH_PARTS_KEY),
  );
  return parsed.success ? parsed.data : [];
}

export interface RichPartsResult {
  /** The tool's name, as registered. */
  name: string;
  /**
   * What the model reads: a string, or a value sent as JSON. Say there that
   * the message is sent for it and must not be repeated.
   */
  content: unknown;
  /** 1 to 4 parts from `linkButtonPart`, `choicesPart` or `cardsPart`. */
  parts: readonly RichContent[];
}

/**
 * A plugin tool's result that delivers `parts` (link buttons, choices,
 * cards) after the model's reply, each a message of its own. The model
 * never sees the parts; other surfaces and the history get each part's
 * `text`. Build the parts with `linkButtonPart` / `choicesPart` /
 * `cardsPart` against `ctx.session.surface.render`, and keep today's text
 * when they return none. Throws a `TypeError` for parts that are not valid.
 */
export function withRichParts(
  ctx: { toolCallId?: string },
  result: RichPartsResult,
): ToolMessage {
  const parsed = RichPartsSchema.safeParse(result.parts);
  if (!parsed.success)
    throw new TypeError(
      'withRichParts: `parts` must hold 1 to 4 parts built with linkButtonPart, choicesPart or cardsPart.',
    );
  return new ToolMessage({
    tool_call_id: ctx.toolCallId ?? '',
    name: result.name,
    content:
      typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content),
    artifact: { [RICH_PARTS_KEY]: parsed.data },
  });
}

/** The rich capability of a tool's turn, from `ctx.session.surface`. */
export function renderOf(ctx: {
  session?: { surface?: { kind: string; render?: RenderCapability } };
}): RenderCapability | undefined {
  const surface = ctx.session?.surface;
  return surface?.kind === 'chat' ? surface.render : undefined;
}
