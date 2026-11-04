/**
 * The deterministic shaper: one model step's Markdown → chat messages, or a
 * spill (lead message, artefact, closing message) when the step is
 * document-length: longer than `spillChars`, or holding a list, table or
 * code block too long to read in chat. Everything else stays in chat: short
 * messages are grouped toward `maxBubbles`, a step that cannot fit that many
 * keeps more messages rather than losing text, a table is rewritten as one
 * line per row, and no message is longer than `bubbleMax`. No model call; the same
 * input always gives the same output, which is what makes a Reply Plan safe
 * to rebuild on recovery.
 */
import { marked, type Token, type Tokens } from 'marked';
import type { ChatLimits } from './types';

export interface SpillShape {
  title: string;
  /** The whole step as the model wrote it: the artefact's content. */
  markdown: string;
  /**
   * What stays in chat before the link, within `bubbleMax`: the first block
   * whole (a paragraph over `bubbleMax` cut at a sentence), or a list's or
   * table's lead-in and first items.
   */
  lead: string;
  /**
   * What stays in chat after the link, within `bubbleMax`: the step's last
   * paragraph (with the paragraph before it when both fit), or its closing
   * list or table previewed. Its conclusion, next actions or question.
   */
  closing?: string;
}

export type StepShape =
  | { kind: 'messages'; messages: string[] }
  | { kind: 'spill'; spill: SpillShape };

type BlockKind = 'heading' | 'paragraph' | 'list' | 'code' | 'table' | 'quote';

interface Block {
  kind: BlockKind;
  md: string;
  token: Token;
}

const TITLE_MAX = 60;

const isHeading = (t: Token): t is Tokens.Heading => t.type === 'heading';
const isList = (t: Token): t is Tokens.List => t.type === 'list';
const isCode = (t: Token): t is Tokens.Code => t.type === 'code';
const isTable = (t: Token): t is Tokens.Table => t.type === 'table';
const isHtml = (t: Token): t is Tokens.HTML => t.type === 'html';

// A pinned locale, so a rebuilt plan splits the same way on every runtime.
const sentenceSegmenter = new Intl.Segmenter('en', {
  granularity: 'sentence',
});
const graphemeSegmenter = new Intl.Segmenter('en', {
  granularity: 'grapheme',
});

/**
 * HTML elements a model mixes into Markdown. Anything else in angle brackets
 * (`Promise<string>`, `<name>` placeholders) is text and stays.
 */
const HTML_ELEMENTS = new Set(
  (
    'a abbr address article aside b bdi bdo blockquote body br button ' +
    'caption center cite code col colgroup dd del details dfn div dl dt ' +
    'em figcaption figure font footer form h1 h2 h3 h4 h5 h6 head ' +
    'header hr html i iframe img input ins kbd label li main mark nav ' +
    'ol p picture pre q s samp script section select small source span ' +
    'strike strong style sub summary sup table tbody td textarea tfoot ' +
    'th thead tr tt u ul var video wbr'
  ).split(' '),
);

/**
 * Raw HTML → its text: HTML elements' tags and comments removed, `<br>` a
 * line break. Only ever applied to what the lexer read as raw HTML, never to
 * code. `a < b and c > d` is left alone.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?\/?>/g,
      (tag, name: string) => (HTML_ELEMENTS.has(name.toLowerCase()) ? '' : tag),
    );
}

/** Characters that render as nothing: whitespace and zero-width marks. */
const INVISIBLE = /[\s\u200B-\u200D\u2060\uFEFF]/g;

/** True when a message would look empty: only whitespace or zero-width characters. */
export function isBlank(text: string): boolean {
  return text.replace(INVISIBLE, '') === '';
}

function childTokens(token: Token): Token[] {
  if (isList(token)) return token.items;
  return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : [];
}

const isLinkOrImage = (t: Token): t is Tokens.Link | Tokens.Image =>
  t.type === 'link' || t.type === 'image';

/** `[text][ref]`, `[text][]` or `[ref]`, inline: its definition is not delivered. */
function referenceLinkInline(token: Token): string | null {
  if (!isLinkOrImage(token) || token.raw.endsWith(')')) return null;
  const image = token.type === 'image';
  if (!token.raw.startsWith(image ? '![' : '[')) return null;
  const title = token.title ? ` "${token.title.replace(/"/g, '\\"')}"` : '';
  return `${image ? '!' : ''}[${token.text}](${token.href}${title})`;
}

/**
 * A block's Markdown for chat: `token.raw` with raw HTML reduced to its text
 * and reference links written inline (their definitions are not delivered).
 * Code spans and code blocks stay verbatim, so `` `<div>` `` survives.
 */
function chatMarkdown(token: Token): string {
  const raw = token.raw;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  const locate = (part: string): number => {
    const at = part ? raw.indexOf(part, cursor) : -1;
    if (at >= 0) cursor = at + part.length;
    return at;
  };
  const visit = (node: Token): void => {
    if (node.type === 'code' || node.type === 'codespan') {
      locate(node.raw);
      return;
    }
    const inline = referenceLinkInline(node);
    const replacement = node.type === 'html' ? stripHtmlTags(node.raw) : inline;
    if (replacement !== null) {
      const at = locate(node.raw);
      if (at >= 0)
        edits.push({ start: at, end: at + node.raw.length, text: replacement });
      return;
    }
    const children = childTokens(node);
    if (children.length === 0) locate(node.raw);
    else for (const child of children) visit(child);
  };
  for (const child of childTokens(token)) visit(child);
  let out = '';
  let from = 0;
  for (const edit of edits) {
    out += raw.slice(from, edit.start) + edit.text;
    from = edit.end;
  }
  return out + raw.slice(from);
}

function plainText(text: string): string {
  return stripHtmlTags(text)
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One table row as a chat line: `- **first cell** · Header: value · …`. */
function rowLine(first: string, rest: string[]): string {
  const parts = [...(first ? [`**${first}**`] : []), ...rest].filter(Boolean);
  return parts.length ? `- ${parts.join(' · ')}` : '';
}

/** A table's chat lines, one per row; a table with no body rows is its header. */
function tableLines(table: Tokens.Table): string[] {
  const headers = table.header.map((cell) => cell.text.trim());
  const lines =
    table.rows.length === 0
      ? [rowLine(headers[0] ?? '', headers.slice(1))]
      : table.rows.map((row) => {
          const [first, ...rest] = row.map((cell) => cell.text.trim());
          return rowLine(
            first ?? '',
            rest.map((value, i) => {
              const header = headers[i + 1];
              return header && value ? `${header}: ${value}` : value;
            }),
          );
        });
  return lines.filter(Boolean);
}

const tableAsList = (table: Tokens.Table): string =>
  tableLines(table).join('\n');

function toBlocks(markdown: string, limits: ChatLimits): Block[] {
  const blocks: Block[] = [];
  for (const token of marked.lexer(markdown)) {
    if (token.type === 'space' || token.type === 'hr' || token.type === 'def')
      continue;
    if (isHeading(token)) {
      const text = plainText(token.text);
      if (text) blocks.push({ kind: 'heading', md: `**${text}**`, token });
    } else if (isList(token)) {
      blocks.push({ kind: 'list', md: chatMarkdown(token).trim(), token });
    } else if (isCode(token)) {
      blocks.push({ kind: 'code', md: token.raw.trim(), token });
    } else if (isTable(token)) {
      const md = limits.tables ? token.raw.trim() : tableAsList(token);
      if (!isBlank(md)) blocks.push({ kind: 'table', md, token });
    } else if (token.type === 'blockquote') {
      blocks.push({ kind: 'quote', md: chatMarkdown(token).trim(), token });
    } else {
      const md = (
        isHtml(token) ? stripHtmlTags(token.text) : chatMarkdown(token)
      ).trim();
      if (!isBlank(md)) blocks.push({ kind: 'paragraph', md, token });
    }
  }
  return blocks;
}

function sentencesOf(text: string): string[] {
  return Array.from(sentenceSegmenter.segment(text), (s) => s.segment);
}

function packPieces(
  pieces: string[],
  separator: string,
  max: number,
): string[] {
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const candidate = current ? current + separator + piece : piece;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    if (piece.length > max) {
      out.push(...splitText(piece, max));
      current = '';
    } else current = piece;
  }
  if (current) out.push(current);
  return out.map((s) => s.trim()).filter((s) => !isBlank(s));
}

/** Split at the largest boundary that works: paragraph, line, sentence, word. */
export function splitText(text: string, max: number): string[] {
  // A size below one character would never move through the text.
  const size = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  if (text.length <= size) return [text];
  for (const separator of ['\n\n', '\n']) {
    const pieces = text.split(separator);
    if (pieces.length > 1) return packPieces(pieces, separator, size);
  }
  const sentences = sentencesOf(text);
  if (sentences.length > 1) return packPieces(sentences, '', size);
  const words = text.split(/(?<=\s)/);
  if (words.length > 1) return packPieces(words, '', size);
  // The hard cut never splits a grapheme (an emoji, a surrogate pair); one
  // grapheme longer than `size` is a piece of its own.
  const out: string[] = [];
  let rest = text;
  while (rest) {
    const piece = graphemePrefix(rest, size) || firstGrapheme(rest);
    out.push(piece);
    rest = rest.slice(piece.length);
  }
  return out;
}

/** The longest prefix of whole graphemes within `max` characters. */
function graphemePrefix(text: string, max: number): string {
  let out = '';
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

function firstGrapheme(text: string): string {
  for (const { segment } of graphemeSegmenter.segment(text)) return segment;
  return '';
}

/** `text` cut to `max` characters with "…", at a word when one is near. */
function cutWithEllipsis(text: string, max: number): string {
  const cut = graphemePrefix(text, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A code block too long for one message is re-fenced per piece. */
function splitBlock(block: Block, max: number): string[] {
  if (block.md.length <= max) return [block.md];
  if (isCode(block.token)) {
    const fence = '```' + (block.token.lang ?? '');
    const room = max - fence.length - 5;
    if (room >= 1)
      return splitText(block.token.text, room).map(
        (piece) => `${fence}\n${piece}\n\`\`\``,
      );
  }
  return splitText(block.md, max);
}

function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const sentence of sentencesOf(text)) {
    if ((out + sentence).length > max) break;
    out += sentence;
  }
  if (out.trim()) return out.trim();
  return cutWithEllipsis(text, max);
}

/** The last sentences of `text` that fit `max`, or '' when none does. */
function lastSentences(text: string, max: number): string {
  let out = '';
  for (const sentence of sentencesOf(text).reverse()) {
    if ((sentence + out).trim().length > max) break;
    out = sentence + out;
  }
  return out.trim();
}

function titleOf(text: string): string {
  const plain = plainText(sentencesOf(text)[0] ?? text).replace(/[:.]$/, '');
  if (plain.length <= TITLE_MAX) return plain;
  return cutWithEllipsis(plain, TITLE_MAX);
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

/** A list's or a table's items as chat lines: a list item by its first line. */
function itemLines(block: Block): string[] {
  if (isTable(block.token)) return tableLines(block.token);
  if (!isList(block.token)) return [];
  const list = block.token;
  const start = typeof list.start === 'number' ? list.start : 1;
  return list.items.map(
    (item, i) =>
      `${list.ordered ? `${start + i}.` : '-'} ${firstLine(item.text)}`,
  );
}

function previewText(head: string, lines: string[], total: number): string {
  const more = total - lines.length;
  return joinBlocks(
    head,
    lines.join('\n') + (more > 0 ? `\n…and ${more} more` : ''),
  );
}

/**
 * A list or table previewed within `bubbleMax`, after an optional "…:"
 * lead-in: its first `previewItems` items and "…and N more". Fewer items
 * are kept (down to one) until it fits; then that item, and if needed the
 * lead-in, is cut with "…". The trailer and its count always stay.
 */
function fittedPreview(head: string, block: Block, limits: ChatLimits): string {
  const lines = itemLines(block);
  const max = limits.bubbleMax;
  if (lines.length === 0)
    return head.length <= max ? head : trimToSentence(head, max);
  for (
    let count = Math.min(limits.previewItems, lines.length);
    count >= 1;
    count--
  ) {
    const text = previewText(head, lines.slice(0, count), lines.length);
    if (text.length <= max) return text;
  }
  const more = lines.length - 1;
  const trailer = more > 0 ? `\n…and ${more} more` : '';
  const line = lines[0]!;
  // Room for the item first (up to a third of the message), then the lead-in.
  const itemRoom = Math.min(line.length, Math.floor(max / 3));
  const headMax = max - 2 - itemRoom - trailer.length;
  const fittedHead =
    !head || head.length <= headMax ? head : trimToSentence(head, headMax);
  const lineMax =
    max - (fittedHead ? fittedHead.length + 2 : 0) - trailer.length;
  const fittedLine =
    line.length <= lineMax ? line : cutWithEllipsis(line, lineMax);
  return previewText(fittedHead, [fittedLine], lines.length);
}

const isItems = (block: Block): boolean =>
  block.kind === 'list' || block.kind === 'table';

const endsWithColon = (md: string): boolean => /:\s*$/.test(md);
const joinBlocks = (a: string, b: string): string => (a ? `${a}\n\n${b}` : b);

/**
 * One message being packed: `code` when it holds a fenced code block,
 * `opens` when it must start a message (a heading or lead-in sent ahead of
 * its body; the body may still join it).
 */
interface Unit {
  text: string;
  code: boolean;
  opens?: boolean;
}

/**
 * Units filled left to right into messages of at most `max` characters. A
 * code unit is never joined to another, so a fenced block keeps its own
 * message. Greedy filling gives the fewest messages for the order given.
 */
function fill(units: Unit[], max: number): Unit[] {
  const out: Unit[] = [];
  for (const unit of units) {
    const last = out.at(-1);
    if (
      last &&
      !last.code &&
      !unit.code &&
      !unit.opens &&
      last.text.length + 2 + unit.text.length <= max
    )
      out[out.length - 1] = {
        text: joinBlocks(last.text, unit.text),
        code: false,
        ...(last.opens ? { opens: true } : {}),
      };
    else out.push(unit);
  }
  return out;
}

/**
 * Toward `maxBubbles` messages. A step already within it keeps the model's
 * own message breaks. Otherwise units are filled up to `bubbleTarget`, and
 * when that still leaves too many, the original units are filled again up
 * to `bubbleMax`. A step that cannot fit stays at more messages: nothing is
 * dropped, and nothing spills on count.
 */
function preferFewer(units: Unit[], limits: ChatLimits): Unit[] {
  if (units.length <= limits.maxBubbles) return units;
  const byTarget = fill(units, limits.bubbleTarget);
  return byTarget.length <= limits.maxBubbles
    ? byTarget
    : fill(units, limits.bubbleMax);
}

/**
 * Blocks → messages, each within `bubbleMax`. Headings and "…:" lead-ins
 * start the message that holds what follows them: when joining would pass
 * `bubbleMax`, the block after them is split with the room left, so they
 * ride on its first piece; only a lead-in too long for that (over half of
 * `bubbleMax`) is sent ahead as messages of its own, which nothing joins
 * from behind. Fragments under `minBubble` merge forward when the result
 * fits, then short messages are grouped toward `maxBubbles` (`preferFewer`).
 */
function pack(blocks: Block[], limits: ChatLimits): string[] {
  const units: Unit[] = [];
  let carry = '';
  const flush = (opens: boolean): void => {
    for (const piece of splitText(carry, limits.bubbleMax))
      if (!isBlank(piece))
        units.push({ text: piece, code: false, ...(opens ? { opens } : {}) });
    carry = '';
  };
  blocks.forEach((block, i) => {
    const next = blocks[i + 1];
    const leadIn =
      block.kind === 'paragraph' &&
      endsWithColon(block.md) &&
      next !== undefined &&
      (next.kind === 'list' || next.kind === 'code' || next.kind === 'table');
    if (block.kind === 'heading' || leadIn) {
      carry = joinBlocks(carry, block.md);
      return;
    }
    const code = block.kind === 'code';
    const room = limits.bubbleMax - carry.length - 2;
    let pieces: string[];
    if (!carry || joinBlocks(carry, block.md).length <= limits.bubbleMax)
      pieces = splitBlock(block, limits.bubbleMax);
    else if (room >= limits.bubbleMax / 2) pieces = splitBlock(block, room);
    else {
      flush(true);
      pieces = splitBlock(block, limits.bubbleMax);
    }
    const [head = '', ...rest] = pieces;
    units.push({ text: joinBlocks(carry, head), code });
    for (const piece of rest) units.push({ text: piece, code });
    carry = '';
  });
  if (carry) flush(false);
  const merged: Unit[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    const next = units[i + 1];
    const joined = next ? joinBlocks(unit.text, next.text) : '';
    if (
      next &&
      unit.text.length < limits.minBubble &&
      joined.length <= limits.bubbleMax
    )
      units[i + 1] = {
        text: joined,
        code: unit.code || next.code,
        ...(unit.opens ? { opens: true } : {}),
      };
    else merged.push(unit);
  }
  return preferFewer(merged, limits).map((unit) => unit.text);
}

/**
 * What a spill keeps in chat, so the conversation still carries the
 * substance when the document cannot be opened, each within `bubbleMax`:
 *
 *  - lead: the first block after any heading (after a leading code block,
 *    which only the artefact holds, unless that block is a lone trailing
 *    paragraph, which is the closing instead): a paragraph or quote
 *    whole when it fits, else cut at a sentence; a list or table, with its
 *    "…:" lead-in, previewed (`fittedPreview`);
 *  - closing: the last block, when the lead did not use it: a list or table
 *    (with its lead-in) previewed, or the last paragraph, joined to the
 *    paragraph before it when both fit (a conclusion and its question), or
 *    its last sentences that fit.
 */
function spillOf(
  markdown: string,
  blocks: Block[],
  limits: ChatLimits,
): SpillShape {
  const heading = blocks.find((b) => b.kind === 'heading');
  const content = blocks.filter((b) => b.kind !== 'heading');
  const max = limits.bubbleMax;
  const used = new Set<Block>();
  const start = content.findIndex((b) => b.kind !== 'code');
  const first = start >= 0 ? content[start] : undefined;
  const second = start >= 0 ? content[start + 1] : undefined;
  // After leading code, a lone trailing paragraph ("Want me to apply it?")
  // is the closing, after the link, not the lead.
  const onlyClosing =
    start > 0 && first === content.at(-1) && first?.kind === 'paragraph';
  let lead = '';
  if (onlyClosing) {
    // No lead: the closing below takes the paragraph.
  } else if (first && isItems(first)) {
    lead = fittedPreview('', first, limits);
    used.add(first);
  } else if (
    first?.kind === 'paragraph' &&
    endsWithColon(first.md) &&
    second &&
    isItems(second)
  ) {
    lead = fittedPreview(first.md, second, limits);
    used.add(first).add(second);
  } else if (first && (first.kind === 'paragraph' || first.kind === 'quote')) {
    lead = first.md.length <= max ? first.md : trimToSentence(first.md, max);
    used.add(first);
  }
  const last = content.at(-1);
  const before = content.at(-2);
  let closing: string | undefined;
  if (last && !used.has(last)) {
    if (isItems(last)) {
      const leadIn =
        before?.kind === 'paragraph' &&
        endsWithColon(before.md) &&
        !used.has(before)
          ? before.md
          : '';
      closing = fittedPreview(leadIn, last, limits);
    } else if (last.kind === 'paragraph') {
      const pair =
        before?.kind === 'paragraph' && !used.has(before)
          ? joinBlocks(before.md, last.md)
          : '';
      closing =
        pair && pair.length <= max
          ? pair
          : last.md.length <= max
            ? last.md
            : lastSentences(last.md, max);
    }
  }
  if (closing === lead || (closing !== undefined && isBlank(closing)))
    closing = undefined;
  const titleSource =
    heading?.md ??
    (content[0]?.kind === 'paragraph' ? content[0].md : undefined);
  return {
    title: (titleSource && titleOf(titleSource)) || 'Details',
    markdown,
    lead,
    ...(closing ? { closing } : {}),
  };
}

/**
 * Shape one model step for a chat surface. A step spills only when it is
 * document-length: its rendered text (blocks joined by blank lines) is over
 * `spillChars`, a list or a table has more than `maxListItems` items or
 * rows, or a code block more than `maxCodeLines` lines. Otherwise it stays in
 * chat as the messages it packs into (grouped toward `maxBubbles`, never
 * spilled on count; the run's cap is `capParts`' job). With `canSpill` false
 * (no artefact storage configured) the step is always split into messages
 * and nothing is dropped.
 */
export function shapeStep(
  markdown: string,
  limits: ChatLimits,
  canSpill: boolean,
): StepShape {
  const blocks = toBlocks(markdown.trim(), limits);
  if (canSpill) {
    const length = blocks.map((b) => b.md).join('\n\n').length;
    const tooLongForChat = blocks.some(
      (b) =>
        (isCode(b.token) &&
          b.token.text.split('\n').length > limits.maxCodeLines) ||
        (isList(b.token) && b.token.items.length > limits.maxListItems) ||
        (isTable(b.token) && b.token.rows.length > limits.maxListItems),
    );
    if (length > limits.spillChars || tooLongForChat)
      return { kind: 'spill', spill: spillOf(markdown.trim(), blocks, limits) };
  }
  return { kind: 'messages', messages: pack(blocks, limits) };
}
