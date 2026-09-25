/**
 * The deterministic shaper: one model step's Markdown → chat messages, or a
 * spill (lead message, artefact, closing question) when the step is too long
 * or too structured for chat. No model call; the same input always gives the
 * same output, which is what makes a Reply Plan safe to rebuild on recovery.
 */
import { marked, type Token, type Tokens } from 'marked';
import type { ChatLimits } from './types';

export interface SpillShape {
  title: string;
  /** The whole step as the model wrote it: the artefact's content. */
  markdown: string;
  /** What stays in chat: the first block, or a list's lead-in and first items. */
  lead: string;
  /** The step's closing question, kept as its own message after the link. */
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

const sentenceSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'sentence',
});

/** Real tags only: `a < b and c > d` is left alone. */
function stripHtmlTags(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/g, '');
}

function plainText(text: string): string {
  return stripHtmlTags(text)
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableAsList(table: Tokens.Table): string {
  return table.rows
    .map((row) => {
      const [first, ...rest] = row.map((cell) => cell.text.trim());
      const pairs = rest.map((value, i) => {
        const header = table.header[i + 1]?.text.trim();
        return header ? `${header}: ${value}` : value;
      });
      return `- **${first ?? ''}**${pairs.length ? ` · ${pairs.join(' · ')}` : ''}`;
    })
    .join('\n');
}

function toBlocks(markdown: string, limits: ChatLimits): Block[] {
  const blocks: Block[] = [];
  for (const token of marked.lexer(markdown)) {
    if (token.type === 'space' || token.type === 'hr' || token.type === 'def')
      continue;
    if (isHeading(token)) {
      const text = plainText(token.text);
      if (text) blocks.push({ kind: 'heading', md: `**${text}**`, token });
    } else if (isList(token)) {
      blocks.push({ kind: 'list', md: token.raw.trim(), token });
    } else if (isCode(token)) {
      blocks.push({ kind: 'code', md: token.raw.trim(), token });
    } else if (isTable(token)) {
      blocks.push({
        kind: 'table',
        md: limits.tables ? token.raw.trim() : tableAsList(token),
        token,
      });
    } else if (token.type === 'blockquote') {
      blocks.push({ kind: 'quote', md: token.raw.trim(), token });
    } else {
      const md = (
        isHtml(token) ? stripHtmlTags(token.text) : stripHtmlTags(token.raw)
      ).trim();
      if (md) blocks.push({ kind: 'paragraph', md, token });
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
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Split at the largest boundary that works: paragraph, line, sentence, word. */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  for (const separator of ['\n\n', '\n']) {
    const pieces = text.split(separator);
    if (pieces.length > 1) return packPieces(pieces, separator, max);
  }
  const sentences = sentencesOf(text);
  if (sentences.length > 1) return packPieces(sentences, '', max);
  const words = text.split(/(?<=\s)/);
  if (words.length > 1) return packPieces(words, '', max);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** A code block too long for one message is re-fenced per piece. */
function splitBlock(block: Block, max: number): string[] {
  if (block.md.length <= max) return [block.md];
  if (isCode(block.token)) {
    const fence = '```' + (block.token.lang ?? '');
    return splitText(block.token.text, max - fence.length - 5).map(
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
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function titleOf(text: string): string {
  const plain = plainText(sentencesOf(text)[0] ?? text).replace(/[:.]$/, '');
  if (plain.length <= TITLE_MAX) return plain;
  const cut = plain.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

function preview(list: Tokens.List, count: number): string {
  const start = typeof list.start === 'number' ? list.start : 1;
  const items = list.items
    .slice(0, count)
    .map(
      (item, i) =>
        `${list.ordered ? `${start + i}.` : '-'} ${firstLine(item.text)}`,
    );
  const more = list.items.length - count;
  return items.join('\n') + (more > 0 ? `\n…and ${more} more` : '');
}

const endsWithColon = (md: string): boolean => /:\s*$/.test(md);
const joinBlocks = (a: string, b: string): string => (a ? `${a}\n\n${b}` : b);

/** Blocks → messages: headings and "…:" lead-ins stay with what follows. */
function pack(blocks: Block[], limits: ChatLimits): string[] {
  const units: string[] = [];
  let carry = '';
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
    const pieces = splitBlock(block, limits.bubbleMax);
    pieces.forEach((piece, j) => {
      units.push(j === 0 ? joinBlocks(carry, piece) : piece);
    });
    carry = '';
  });
  if (carry) units.push(carry);
  const merged: string[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (unit.length < limits.minBubble && i + 1 < units.length)
      units[i + 1] = joinBlocks(unit, units[i + 1]!);
    else merged.push(unit);
  }
  return merged;
}

function spillOf(
  markdown: string,
  blocks: Block[],
  limits: ChatLimits,
): SpillShape {
  const heading = blocks.find((b) => b.kind === 'heading');
  const content = blocks.filter((b) => b.kind !== 'heading');
  const [first, second] = content;
  let lead = '';
  if (first && isList(first.token))
    lead = preview(first.token, limits.previewItems);
  else if (
    first?.kind === 'paragraph' &&
    endsWithColon(first.md) &&
    second &&
    isList(second.token)
  )
    lead = joinBlocks(first.md, preview(second.token, limits.previewItems));
  else if (first && (first.kind === 'paragraph' || first.kind === 'quote'))
    lead = trimToSentence(first.md, limits.bubbleTarget);
  const last = content.at(-1);
  const closing =
    last &&
    last !== first &&
    last.kind === 'paragraph' &&
    /\?\s*$/.test(last.md) &&
    last.md.length <= limits.bubbleMax
      ? last.md
      : undefined;
  const titleSource =
    heading?.md ?? (first?.kind === 'paragraph' ? first.md : undefined);
  return {
    title: (titleSource && titleOf(titleSource)) || 'Details',
    markdown,
    lead,
    ...(closing ? { closing } : {}),
  };
}

/**
 * Shape one model step for a chat surface. With `canSpill` false (no
 * artefact storage configured) the step is always split into messages:
 * tables become lists and nothing is dropped.
 */
export function shapeStep(
  markdown: string,
  limits: ChatLimits,
  canSpill: boolean,
): StepShape {
  const blocks = toBlocks(markdown.trim(), limits);
  const messages = pack(blocks, limits);
  if (!canSpill) return { kind: 'messages', messages };
  const length = blocks.reduce((n, b) => n + b.md.length + 2, 0);
  const tooStructured = blocks.some(
    (b) =>
      (b.kind === 'table' && !limits.tables) ||
      (isCode(b.token) &&
        b.token.text.split('\n').length > limits.maxCodeLines) ||
      (isList(b.token) && b.token.items.length > limits.maxListItems),
  );
  if (
    length > limits.spillChars ||
    tooStructured ||
    messages.length > limits.maxBubbles
  )
    return { kind: 'spill', spill: spillOf(markdown.trim(), blocks, limits) };
  return { kind: 'messages', messages };
}
