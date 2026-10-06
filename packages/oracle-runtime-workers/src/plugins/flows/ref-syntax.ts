/**
 * The `{{ … }}` placeholder syntax, scanned by hand in one forward pass.
 *
 * Placeholders are read out of document content on every flow read, and any
 * room member can write that content, so the scan must stay linear in the
 * input length whatever the input looks like. A regex with a lazy group next
 * to optional whitespace backtracks polynomially on "{{" followed by a long
 * run of spaces and no closing braces; this scanner looks at each character a
 * bounded number of times instead.
 *
 * A placeholder is "{{", then at least one character that is not a brace,
 * then "}}". Whitespace just inside the braces is kept apart from the
 * reference itself so callers can rewrite the reference and keep the
 * author's spacing.
 *
 * This module has no imports on purpose: the boot-loaded schema module
 * (`types.ts`) uses it, and nothing it pulls in may reach `@ixo/editor`.
 */

/**
 * Strings longer than this are passed through untouched instead of scanned.
 * One Matrix event carries at most 64 KiB, so no single authored value in a
 * flow document can legitimately be longer.
 */
export const MAX_REF_SCAN_CHARS = 65_536;

export interface RefToken {
  /** Index of the opening "{{". */
  start: number;
  /** Index just past the closing "}}". */
  end: number;
  /** The reference with the surrounding whitespace removed (may be empty). */
  ref: string;
  /** Whitespace between "{{" and the reference. */
  leading: string;
  /** Whitespace between the reference and "}}". */
  trailing: string;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/** Every `{{ … }}` placeholder in `text`, in order. */
export function scanRefTokens(text: string): RefToken[] {
  const tokens: RefToken[] = [];
  if (text.length > MAX_REF_SCAN_CHARS) return tokens;

  let from = 0;
  while (from < text.length) {
    const start = text.indexOf('{{', from);
    if (start < 0) break;

    // The first brace after the opener decides the outcome: "}}" closes the
    // placeholder; anything else means no placeholder opens at `start`.
    let cursor = start + 2;
    while (cursor < text.length && text[cursor] !== '{' && text[cursor] !== '}')
      cursor += 1;
    const closes =
      cursor > start + 2 && text[cursor] === '}' && text[cursor + 1] === '}';
    if (!closes) {
      // The brace-free run after the opener cannot hold another opener, so
      // resume at the brace — except for "{{{", where the next opener starts
      // one character later.
      from = cursor === start + 2 ? start + 1 : cursor;
      continue;
    }

    const inner = text.slice(start + 2, cursor);
    let head = 0;
    while (head < inner.length && isWhitespace(inner.charAt(head))) head += 1;
    let tail = inner.length;
    while (tail > head && isWhitespace(inner.charAt(tail - 1))) tail -= 1;
    tokens.push({
      start,
      end: cursor + 2,
      ref: inner.slice(head, tail),
      leading: inner.slice(0, head),
      trailing: inner.slice(tail),
    });
    from = cursor + 2;
  }
  return tokens;
}

/**
 * The reference when the whole string is exactly one placeholder
 * ("{{ a.output.b }}"), else `undefined`. "{{a}} and {{b}}" is two embedded
 * placeholders, not one reference.
 */
export function wholeRef(text: string): string | undefined {
  if (!text.startsWith('{{') || !text.endsWith('}}')) return undefined;
  const tokens = scanRefTokens(text);
  const only = tokens.length === 1 ? tokens[0] : undefined;
  if (!only || only.start !== 0 || only.end !== text.length) return undefined;
  return only.ref.length > 0 ? only.ref : undefined;
}

/** Rewrite the reference inside every placeholder, keeping its spacing. */
export function rewriteRefTokens(
  text: string,
  mapRef: (ref: string) => string,
): string {
  const tokens = scanRefTokens(text);
  if (tokens.length === 0) return text;
  let out = '';
  let last = 0;
  for (const token of tokens) {
    out += text.slice(last, token.start);
    out += `{{${token.leading}${token.ref.length > 0 ? mapRef(token.ref) : ''}${token.trailing}}}`;
    last = token.end;
  }
  return out + text.slice(last);
}

/**
 * True when any string anywhere inside `value` (nested objects and arrays
 * included) holds a placeholder whose reference starts with `<id>.`.
 */
export function referencesId(value: unknown, id: string): boolean {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return false;
    return scanRefTokens(value).some((token) => token.ref.startsWith(`${id}.`));
  }
  if (Array.isArray(value)) return value.some((item) => referencesId(item, id));
  if (value && typeof value === 'object')
    return Object.values(value).some((item) => referencesId(item, id));
  return false;
}
