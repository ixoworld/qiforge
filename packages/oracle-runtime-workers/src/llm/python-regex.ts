/**
 * Whether a JSON-schema `pattern` compiles under Python's `re` module, which
 * is how OpenAI (and Azure OpenAI) check the `pattern` of a function's
 * parameters: a pattern `re.compile` refuses makes the whole request fail
 * with HTTP 400 `invalid_function_parameters` ("… is not a 'regex'").
 *
 * Measured on 2026-11-13 against `openai/gpt-5.6-luna` on OpenRouter, with
 * the provider pinned to OpenAI and then to Azure: 79 patterns, and in every
 * case but one the provider's verdict was Python's (`re.compile`). The one
 * difference is `\Z` inside a class, which OpenAI accepts and Python 3.14
 * refuses, so the service runs an older Python; this module follows the
 * service. The cases are kept as test vectors (`python-regex.test.ts`).
 *
 * The check reports only what it is sure Python refuses. A pattern it cannot
 * follow (verbose mode, `(?x)`) is reported as accepted: the cost of a wrong
 * "refused" is a validation hint the model no longer sees, the cost of a
 * wrong "accepted" is the request failing as before.
 */

const HEX = /^[0-9a-fA-F]$/;
const OCTAL = /^[0-7]$/;
const DIGIT = /^[0-9]$/;
/** Escapes Python reads as a whole class (`\d`) — never a range bound. */
const CLASS_ESCAPES = new Set(['d', 'D', 's', 'S', 'w', 'W']);
/** Zero-width escapes outside a class (`\A`, `\b`, `\B`, `\Z`). */
const AT_ESCAPES = new Set(['A', 'b', 'B', 'Z']);
/** Single-character escapes Python knows, outside and inside a class. */
const CHAR_ESCAPES = new Set(['a', 'f', 'n', 'r', 't', 'v', '\\']);
const IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_]*$/u;
const FLAG_LETTERS = new Set(['a', 'i', 'L', 'm', 's', 'u', 'x']);

/** Width bounds of a subpattern, for the fixed-width look-behind rule. */
interface Width {
  min: number;
  max: number;
}

class RegexRefused extends Error {}
/** Thrown when the pattern uses something this check does not follow. */
class Unfollowable extends Error {}

const refuse = (reason: string): never => {
  throw new RegexRefused(reason);
};

class PythonRegexChecker {
  private pos = 0;
  private groups = 0;
  private readonly open = new Set<number>();
  private readonly names = new Map<string, number>();
  private readonly conditionalRefs: Array<string | number> = [];
  /** Only global flag groups and comments so far: where `(?i)` may stand. */
  private atStart = true;
  private readonly chars: string[];

  constructor(pattern: string) {
    // Code points, so a character outside the BMP is one character.
    this.chars = Array.from(pattern);
  }

  check(): void {
    this.alternation(false);
    if (this.pos < this.chars.length) {
      // Only a `)` stops the top-level alternation early.
      refuse('unbalanced parenthesis');
    }
    for (const ref of this.conditionalRefs) {
      if (typeof ref === 'number' ? ref > this.groups : !this.names.has(ref))
        refuse('invalid group reference in a conditional');
    }
  }

  private peek(offset = 0): string | undefined {
    return this.chars[this.pos + offset];
  }

  private take(): string {
    const c = this.chars[this.pos];
    if (c === undefined) return refuse('unexpected end of pattern');
    this.pos += 1;
    return c;
  }

  /** `a|b|…` up to a `)` or the end; the widths of its branches. */
  private alternation(inLookbehind: boolean): Width {
    let width = this.sequence(inLookbehind);
    while (this.peek() === '|') {
      this.pos += 1;
      const next = this.sequence(inLookbehind);
      width = {
        min: Math.min(width.min, next.min),
        max: Math.max(width.max, next.max),
      };
    }
    return width;
  }

  private sequence(inLookbehind: boolean): Width {
    const width: Width = { min: 0, max: 0 };
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === '|' || c === ')') return width;
      const item = this.item(inLookbehind);
      width.min += item.min;
      width.max += item.max;
    }
  }

  /** One atom and its quantifiers. */
  private item(inLookbehind: boolean): Width {
    const c = this.peek()!;
    if (c === '*' || c === '+' || c === '?' || this.quantifierAt() !== null)
      refuse('nothing to repeat');
    const atom = this.atom(inLookbehind);
    if (!atom.noItem) this.atStart = false;
    const q = this.quantifier();
    if (q === null) return atom.width;
    // A comment or a flag group adds no item: Python repeats the item
    // before it. Not followed here.
    if (atom.noItem) throw new Unfollowable();
    if (atom.zeroWidthAt) refuse('nothing to repeat');
    // A lazy (`?`) or possessive (`+`, Python 3.11+) marker.
    if (this.peek() === '?' || this.peek() === '+') this.pos += 1;
    if (
      this.peek() === '*' ||
      this.peek() === '+' ||
      this.peek() === '?' ||
      this.quantifierAt() !== null
    )
      refuse('multiple repeat');
    return {
      min: atom.width.min * q.min,
      max: q.max === Infinity ? Infinity : atom.width.max * q.max,
    };
  }

  /** The quantifier at the cursor, consumed; null when there is none. */
  private quantifier(): Width | null {
    const c = this.peek();
    if (c === '*') {
      this.pos += 1;
      return { min: 0, max: Infinity };
    }
    if (c === '+') {
      this.pos += 1;
      return { min: 1, max: Infinity };
    }
    if (c === '?') {
      this.pos += 1;
      return { min: 0, max: 1 };
    }
    const brace = this.quantifierAt();
    if (brace === null) return null;
    this.pos += brace.length;
    if (brace.max < brace.min) refuse('min repeat greater than max repeat');
    return { min: brace.min, max: brace.max };
  }

  /**
   * A `{m}`, `{m,}`, `{,n}` or `{m,n}` quantifier at the cursor (not
   * consumed), or null: Python reads any other `{` as a literal.
   */
  private quantifierAt(): (Width & { length: number }) | null {
    if (this.peek() !== '{') return null;
    let i = this.pos + 1;
    let lo = '';
    let hi = '';
    while (DIGIT.test(this.chars[i] ?? '')) lo += this.chars[i++];
    let comma = false;
    if (this.chars[i] === ',') {
      comma = true;
      i += 1;
      while (DIGIT.test(this.chars[i] ?? '')) hi += this.chars[i++];
    }
    if (this.chars[i] !== '}') return null;
    if (!comma && lo === '') return null;
    const min = lo === '' ? 0 : Number(lo);
    const max = comma ? (hi === '' ? Infinity : Number(hi)) : min;
    return { min, max, length: i + 1 - this.pos };
  }

  private atom(inLookbehind: boolean): {
    width: Width;
    zeroWidthAt?: boolean;
    /** A comment or global flags: nothing Python could repeat. */
    noItem?: boolean;
  } {
    const c = this.take();
    if (c === '(') return this.group(inLookbehind);
    if (c === '[') {
      this.characterClass();
      return { width: { min: 1, max: 1 } };
    }
    if (c === '\\') return this.escape(inLookbehind);
    if (c === '^' || c === '$')
      return { width: { min: 0, max: 0 }, zeroWidthAt: true };
    return { width: { min: 1, max: 1 } };
  }

  /** After `(`: a capture, or one of Python's `(?…)` extensions. */
  private group(inLookbehind: boolean): { width: Width; noItem?: boolean } {
    const atStart = this.atStart;
    if (this.peek() !== '?') this.atStart = false;
    return this.groupBody(inLookbehind, atStart);
  }

  private groupBody(
    inLookbehind: boolean,
    atStart: boolean,
  ): { width: Width; noItem?: boolean } {
    if (this.peek() !== '?') {
      this.groups += 1;
      const id = this.groups;
      this.open.add(id);
      const width = this.alternation(inLookbehind);
      this.close('missing ), unterminated subpattern');
      this.open.delete(id);
      return { width };
    }
    this.pos += 1;
    // Anything but a comment or global flags ends the start.
    if (this.peek() !== '#' && !/^[aiLmsux-]$/.test(this.peek() ?? ''))
      this.atStart = false;
    const c = this.take();
    if (c === ':' || c === '>') {
      const width = this.alternation(inLookbehind);
      this.close('missing ), unterminated subpattern');
      return { width };
    }
    if (c === '=' || c === '!') {
      this.alternation(false);
      this.close('missing ), unterminated subpattern');
      return { width: { min: 0, max: 0 } };
    }
    if (c === '#') {
      while (this.peek() !== ')') {
        if (this.peek() === undefined)
          refuse('missing ), unterminated comment');
        this.pos += 1;
      }
      this.pos += 1;
      return { width: { min: 0, max: 0 }, noItem: true };
    }
    if (c === '<') {
      const kind = this.take();
      if (kind !== '=' && kind !== '!') refuse(`unknown extension ?<${kind}`);
      const width = this.alternation(true);
      this.close('missing ), unterminated subpattern');
      if (width.min !== width.max || width.max === Infinity)
        refuse('look-behind requires fixed-width pattern');
      return { width: { min: 0, max: 0 } };
    }
    if (c === 'P') {
      const kind = this.take();
      if (kind === '<') {
        const name = this.until('>', 'missing >, unterminated name');
        if (!IDENTIFIER.test(name))
          refuse(`bad character in group name '${name}'`);
        if (this.names.has(name)) refuse('redefinition of group name');
        this.groups += 1;
        const id = this.groups;
        this.names.set(name, id);
        this.open.add(id);
        const width = this.alternation(inLookbehind);
        this.close('missing ), unterminated subpattern');
        this.open.delete(id);
        return { width };
      }
      if (kind === '=') {
        const name = this.until(')', 'missing ), unterminated name');
        const id = this.names.get(name);
        if (id === undefined) refuse(`unknown group name '${name}'`);
        if (this.open.has(id!)) refuse('cannot refer to an open group');
        if (inLookbehind) throw new Unfollowable();
        return { width: { min: 0, max: Infinity } };
      }
      return refuse(`unknown extension ?P${kind}`);
    }
    if (c === '(') {
      const ref = this.until(')', 'missing ), unterminated name');
      if (/^\d+$/.test(ref)) {
        const id = Number(ref);
        if (id === 0) refuse('bad group number');
        this.conditionalRefs.push(id);
      } else if (IDENTIFIER.test(ref)) this.conditionalRefs.push(ref);
      else refuse(`bad character in group name '${ref}'`);
      const yes = this.sequence(inLookbehind);
      let width = yes;
      if (this.peek() === '|') {
        this.pos += 1;
        const no = this.sequence(inLookbehind);
        width = {
          min: Math.min(yes.min, no.min),
          max: Math.max(yes.max, no.max),
        };
        if (this.peek() === '|')
          refuse('conditional backref with more than two branches');
      } else width = { min: 0, max: yes.max };
      this.close('missing ), unterminated subpattern');
      return { width };
    }
    // Inline flags: `(?flags)` (global) or `(?flags-flags:…)` (scoped).
    this.pos -= 1;
    let on = '';
    while (FLAG_LETTERS.has(this.peek() ?? '')) on += this.take();
    let off = '';
    if (this.peek() === '-') {
      this.pos += 1;
      while (FLAG_LETTERS.has(this.peek() ?? '')) off += this.take();
      if (off === '') refuse('missing flag');
    }
    const end = this.take();
    if (on === '' && off === '') refuse(`unknown extension ?${end}`);
    if (on.includes('L'))
      refuse("bad inline flag: cannot use 'L' flag with a str pattern");
    if (on.includes('a') && on.includes('u'))
      refuse("bad inline flag: flags 'a', 'u' and 'L' are incompatible");
    if (/[aLu]/.test(off)) refuse('bad inline flag: cannot turn off flags');
    // Verbose mode changes how the rest is read; not followed here.
    if (on.includes('x')) throw new Unfollowable();
    if (end === ')') {
      if (off !== '') refuse('missing :');
      if (!atStart) refuse('global flags not at the start of the expression');
      return { width: { min: 0, max: 0 }, noItem: true };
    }
    if (end !== ':') refuse('missing -, : or )');
    this.atStart = false;
    const width = this.alternation(inLookbehind);
    this.close('missing ), unterminated subpattern');
    return { width };
  }

  private close(reason: string): void {
    if (this.peek() !== ')') refuse(reason);
    this.pos += 1;
  }

  /** Characters up to `end` (consumed); refuses at the end of the pattern. */
  private until(end: string, reason: string): string {
    let text = '';
    for (;;) {
      const c = this.peek();
      if (c === undefined) return refuse(reason);
      this.pos += 1;
      if (c === end) return text;
      text += c;
    }
  }

  /** After `\` outside a class. */
  private escape(inLookbehind: boolean): {
    width: Width;
    zeroWidthAt?: boolean;
  } {
    const c = this.peek();
    if (c === undefined) refuse('bad escape (end of pattern)');
    this.pos += 1;
    const one = { width: { min: 1, max: 1 } };
    if (AT_ESCAPES.has(c!))
      return { width: { min: 0, max: 0 }, zeroWidthAt: true };
    if (CLASS_ESCAPES.has(c!) || CHAR_ESCAPES.has(c!)) return one;
    if (c === 'x' || c === 'u' || c === 'U') {
      this.hexDigits(c);
      return one;
    }
    if (c === 'N') {
      this.namedCharacter();
      return one;
    }
    if (c === '0') {
      this.octalTail(2);
      return one;
    }
    if (DIGIT.test(c!)) {
      // `\1`–`\99` is a group reference, unless three octal digits make a
      // character (`\123`).
      const d1 = this.peek();
      const d2 = this.peek(1);
      if (
        OCTAL.test(c!) &&
        d1 !== undefined &&
        OCTAL.test(d1) &&
        d2 !== undefined &&
        OCTAL.test(d2)
      ) {
        this.pos += 2;
        if (parseInt(`${c}${d1}${d2}`, 8) > 0o377)
          refuse('octal escape value outside of range 0-0o377');
        return one;
      }
      let digits = c!;
      if (d1 !== undefined && DIGIT.test(d1)) {
        digits += d1;
        this.pos += 1;
      }
      const id = Number(digits);
      if (id > this.groups) refuse(`invalid group reference ${id}`);
      if (this.open.has(id)) refuse('cannot refer to an open group');
      // The width of a reference is its group's; not followed in a
      // look-behind, where it would decide the fixed-width rule.
      if (inLookbehind) throw new Unfollowable();
      return { width: { min: 0, max: Infinity } };
    }
    if (/^[A-Za-z]$/.test(c!)) refuse(`bad escape \\${c}`);
    return one;
  }

  /** `\x` (2), `\u` (4) or `\U` (8) hex digits after the letter. */
  private hexDigits(letter: string): void {
    const count = letter === 'x' ? 2 : letter === 'u' ? 4 : 8;
    let hex = '';
    for (let i = 0; i < count; i += 1) {
      const d = this.peek();
      if (d === undefined || !HEX.test(d))
        refuse(`incomplete escape \\${letter}${hex}`);
      hex += d;
      this.pos += 1;
    }
    if (letter === 'U' && parseInt(hex, 16) > 0x10ffff)
      refuse(`bad escape \\U${hex}`);
  }

  /** `\N{NAME}`: the name itself is not checked (JavaScript has no `\N`). */
  private namedCharacter(): void {
    if (this.peek() !== '{') refuse('missing {');
    this.pos += 1;
    const name = this.until('}', 'missing }, unterminated name');
    if (name === '') refuse('missing character name');
  }

  /** Up to `max` more octal digits after `\0`. */
  private octalTail(max: number): void {
    for (let i = 0; i < max && OCTAL.test(this.peek() ?? ''); i += 1)
      this.pos += 1;
  }

  /** After `[`, up to and including its `]`. */
  private characterClass(): void {
    if (this.peek() === '^') this.pos += 1;
    // A `]` first in the set is a literal.
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) refuse('unterminated character set');
      if (c === ']' && !first) {
        this.pos += 1;
        return;
      }
      first = false;
      const low = this.classMember();
      if (
        this.peek() === '-' &&
        this.peek(1) !== ']' &&
        this.peek(1) !== undefined
      ) {
        this.pos += 1;
        const high = this.classMember();
        if (low.kind === 'class' || high.kind === 'class')
          refuse('bad character range');
        if (
          low.code !== undefined &&
          high.code !== undefined &&
          high.code < low.code
        )
          refuse('bad character range');
      }
    }
  }

  /** One member of a set: a character (its code point when known) or a class escape. */
  private classMember(): { kind: 'char' | 'class'; code?: number } {
    const c = this.take();
    if (c !== '\\') return { kind: 'char', code: c.codePointAt(0) };
    const e = this.peek();
    if (e === undefined) refuse('bad escape (end of pattern)');
    this.pos += 1;
    if (CLASS_ESCAPES.has(e!)) return { kind: 'class' };
    if (e === 'b') return { kind: 'char', code: 8 };
    if (e === 'Z') return { kind: 'char' };
    if (CHAR_ESCAPES.has(e!)) return { kind: 'char' };
    if (e === 'x' || e === 'u' || e === 'U') {
      const startHex = this.pos;
      this.hexDigits(e);
      return {
        kind: 'char',
        code: parseInt(this.chars.slice(startHex, this.pos).join(''), 16),
      };
    }
    if (e === 'N') {
      this.namedCharacter();
      return { kind: 'char' };
    }
    if (OCTAL.test(e!)) {
      this.octalTail(2);
      return { kind: 'char' };
    }
    if (DIGIT.test(e!)) refuse(`bad escape \\${e}`);
    if (/^[A-Za-z]$/.test(e!)) refuse(`bad escape \\${e}`);
    return { kind: 'char', code: e!.codePointAt(0) };
  }
}

/**
 * Why Python's `re.compile` (OpenAI's check of a function parameter's
 * `pattern`) refuses `pattern`, or null when it compiles or this check
 * cannot tell.
 */
export function pythonRegexRefusal(pattern: string): string | null {
  try {
    new PythonRegexChecker(pattern).check();
    return null;
  } catch (error) {
    if (error instanceof RegexRefused) return error.message;
    return null;
  }
}
