/**
 * Splits extracted document text into chunks the Memory Engine accepts: every
 * chunk is at most `maxChunkBytes` UTF-8 bytes, cut at the largest natural
 * boundary that fits (paragraph, line, sentence) and only then mid-text, never
 * inside a UTF-8 sequence or surrogate pair.
 */

export interface ChunkerOptions {
  /** Upper bound of one chunk in UTF-8 bytes (default 12 000). */
  maxChunkBytes: number;
  /** Most chunks to return (default 64). */
  maxChunks: number;
}

export interface DocumentChunk {
  /** Zero-based position in the document. */
  index: number;
  /** `p. 3`, `p. 3–5` when the text carries page markers, else `part 2 of 7`. */
  label: string;
  content: string;
}

export interface ChunkedDocument {
  chunks: DocumentChunk[];
  /** More chunks were needed than `maxChunks`; only the first ones are returned. */
  truncated: boolean;
  /** UTF-8 size of the normalised text. */
  totalBytes: number;
}

export const DEFAULT_CHUNK_BYTES = 12_000;
export const DEFAULT_MAX_CHUNKS = 64;

const MIN_CHUNK_BYTES = 4;
/** A whole line that only names a page: `--- page 3 ---`, `Page 3`, `p. 3`, `Page 3 of 10`. */
const PAGE_MARKER =
  /^\s*(?:---\s*page\s+(\d+)\s*---|(?:page|p\.)\s*(\d+)(?:\s*(?:of|\/)\s*\d+)?)\s*$/i;

/** UTF-8 length of a string, counting a lone surrogate as U+FFFD (3 bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

interface Paragraph {
  text: string;
  page: number | undefined;
}

interface Unit {
  text: string;
  /** What joins this unit to the previous one inside a chunk. */
  sep: string;
  page: number | undefined;
}

/** Drops trailing spaces and tabs in one backwards pass (no regex backtracking; a form feed stays). */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return end === line.length ? line : line.slice(0, end);
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(trimLineEnd)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isMarkerOnly(text: string): boolean {
  return !text.includes('\n') && PAGE_MARKER.test(text);
}

function groupText(group: readonly Unit[]): string {
  return group.reduce(
    (acc, u, i) => (i === 0 ? u.text : acc + u.sep + u.text),
    '',
  );
}

/**
 * A group that only names pages (`--- page 4 ---`) says nothing: it joins the
 * start of the next group, else the end of the previous one, if it fits, and
 * is dropped otherwise (the page of every unit is already known).
 */
function absorbMarkerGroups(groups: Unit[][], maxBytes: number): Unit[][] {
  const out: Unit[][] = [];
  let carry: Unit[] = [];
  for (const group of groups) {
    if (group.every((u) => isMarkerOnly(u.text))) {
      carry = [...carry, ...group];
      continue;
    }
    if (
      carry.length > 0 &&
      utf8ByteLength(groupText([...carry, ...group])) <= maxBytes
    ) {
      out.push([...carry, ...group]);
    } else {
      const last = out[out.length - 1];
      if (
        carry.length > 0 &&
        last &&
        utf8ByteLength(groupText([...last, ...carry])) <= maxBytes
      ) {
        last.push(...carry);
      }
      out.push(group);
    }
    carry = [];
  }
  const last = out[out.length - 1];
  if (
    carry.length > 0 &&
    last &&
    utf8ByteLength(groupText([...last, ...carry])) <= maxBytes
  ) {
    last.push(...carry);
  }
  return out;
}

/** Paragraphs in order, each tagged with the page it starts on (if paged). */
function splitParagraphs(text: string): {
  paragraphs: Paragraph[];
  paged: boolean;
} {
  const lines = text.replace(/\f/g, '\n\f\n').split('\n');
  const paged =
    text.includes('\f') || lines.some((line) => PAGE_MARKER.test(line));
  const paragraphs: Paragraph[] = [];
  let page: number | undefined = paged ? 1 : undefined;
  let current: string[] = [];
  let currentPage = page;

  const flush = (): void => {
    const joined = current.join('\n').trim();
    if (joined) paragraphs.push({ text: joined, page: currentPage });
    current = [];
  };

  for (const line of lines) {
    if (line === '\f') {
      flush();
      page = (page ?? 1) + 1;
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const marker = PAGE_MARKER.exec(line);
    if (marker) {
      flush();
      page = Number(marker[1] ?? marker[2]);
    }
    if (current.length === 0) currentPage = page;
    current.push(line);
  }
  flush();
  return { paragraphs, paged };
}

interface Level {
  sep: string;
  split: (text: string) => string[];
}

/** Boundaries tried in order when a piece is still too large. */
const LEVELS: readonly Level[] = [
  {
    sep: '\n',
    split: (t) =>
      t
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
  },
  {
    sep: ' ',
    split: (t) =>
      t
        .split(/(?<=[.!?。！？])\s+/u)
        .map((s) => s.trim())
        .filter(Boolean),
  },
];

function hardSplit(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    const size = utf8ByteLength(text.slice(i, i + width));
    if (bytes + size > maxBytes) {
      pieces.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += width;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

function fit(
  text: string,
  sep: string,
  levels: readonly Level[],
  maxBytes: number,
  page: number | undefined,
): Unit[] {
  if (utf8ByteLength(text) <= maxBytes) return [{ text, sep, page }];
  const [level, ...rest] = levels;
  if (!level) {
    return hardSplit(text, maxBytes).map((piece, i) => ({
      text: piece,
      sep: i === 0 ? sep : '',
      page,
    }));
  }
  const parts = level.split(text);
  if (parts.length <= 1) return fit(text, sep, rest, maxBytes, page);
  return parts.flatMap((part, i) =>
    fit(part, i === 0 ? sep : level.sep, rest, maxBytes, page),
  );
}

function pageLabel(first: number, last: number): string {
  return first === last ? `p. ${first}` : `p. ${first}–${last}`;
}

export function chunkDocument(
  text: string,
  opts: Partial<ChunkerOptions> = {},
): ChunkedDocument {
  const maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < MIN_CHUNK_BYTES) {
    throw new RangeError(
      `maxChunkBytes must be an integer >= ${MIN_CHUNK_BYTES}`,
    );
  }
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new RangeError('maxChunks must be a positive integer');
  }

  const normalised = normalise(text);
  if (!normalised) return { chunks: [], truncated: false, totalBytes: 0 };

  const { paragraphs, paged } = splitParagraphs(normalised);
  const units = paragraphs
    .flatMap((p) => fit(p.text, '\n\n', LEVELS, maxChunkBytes, p.page))
    .filter((u) => u.text.trim() !== '');

  const groups: Unit[][] = [];
  let group: Unit[] = [];
  let groupBytes = 0;
  for (const unit of units) {
    const unitBytes = utf8ByteLength(unit.text);
    // Separators are ASCII, so their length is their byte length.
    const joined = groupBytes + unit.sep.length + unitBytes;
    if (group.length > 0 && joined <= maxChunkBytes) {
      group.push(unit);
      groupBytes = joined;
    } else {
      if (group.length > 0) groups.push(group);
      group = [unit];
      groupBytes = unitBytes;
    }
  }
  if (group.length > 0) groups.push(group);

  const kept = absorbMarkerGroups(groups, maxChunkBytes);
  const total = kept.length;
  const chunks = kept.slice(0, maxChunks).map((members, index) => {
    const body = groupText(members);
    const pages = members
      .map((u) => u.page)
      .filter((p): p is number => p !== undefined);
    const label =
      paged && pages.length > 0
        ? pageLabel(Math.min(...pages), Math.max(...pages))
        : `part ${index + 1} of ${total}`;
    return { index, label, content: body };
  });

  return {
    chunks,
    truncated: total > maxChunks,
    totalBytes: utf8ByteLength(normalised),
  };
}
