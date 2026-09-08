/**
 * A minimal Mustache renderer covering exactly what the system-prompt
 * template uses — replaces the `mustache` package the Node runtime pulled in
 * through `@langchain/core`'s `PromptTemplate` (`templateFormat: 'mustache'`).
 *
 * Supported syntax (Mustache spec semantics for each):
 *   - `{{name}}` and `{{{name}}}` — interpolation. Both are unescaped, which
 *     is also how LangChain configures Mustache (`mustache.escape = identity`).
 *   - `{{#name}} … {{/name}}` — section, rendered once when the value is
 *     truthy (a non-empty string, `true`, a non-zero number, a non-empty
 *     array, or an object). Not iterated: the prompt has no list slots.
 *   - `{{^name}} … {{/name}}` — inverted section.
 *   - `{{! comment }}` — dropped.
 *   - Standalone tag lines: a section/inverted/close/comment tag that is the
 *     only non-whitespace on its line is removed together with that line's
 *     newline, exactly as the spec requires. Interpolation tags are never
 *     standalone.
 *
 * Unsupported on purpose: partials, dotted names, set-delimiters, and
 * iteration. Values are looked up on the flat `values` record only.
 */

export type TemplateValues = Record<string, unknown>;

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'section'; name: string; inverted: boolean; children: Node[] };

interface Token {
  kind: 'text' | 'var' | 'open' | 'open-inverted' | 'close' | 'comment';
  value: string;
  /** Standalone-line detection needs to know where the tag sat in the source. */
  start: number;
  end: number;
}

const TAG_RE =
  /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([#^/!])?\s*([^{}]*?)\s*\}\}/g;

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of template.matchAll(TAG_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > last) {
      tokens.push({
        kind: 'text',
        value: template.slice(last, start),
        start: last,
        end: start,
      });
    }
    const triple = match[1];
    if (triple !== undefined) {
      tokens.push({ kind: 'var', value: triple, start, end });
    } else {
      const sigil = match[2];
      const name = match[3] ?? '';
      const kind: Token['kind'] =
        sigil === '#'
          ? 'open'
          : sigil === '^'
            ? 'open-inverted'
            : sigil === '/'
              ? 'close'
              : sigil === '!'
                ? 'comment'
                : 'var';
      tokens.push({ kind, value: name, start, end });
    }
    last = end;
  }
  if (last < template.length) {
    tokens.push({
      kind: 'text',
      value: template.slice(last),
      start: last,
      end: template.length,
    });
  }
  return stripStandaloneLines(tokens);
}

/**
 * Remove the surrounding whitespace + newline of every tag that stands alone
 * on its line. Operates on the adjacent text tokens so the parse tree never
 * sees the dead whitespace.
 */
function stripStandaloneLines(tokens: Token[]): Token[] {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (
      tok.kind !== 'open' &&
      tok.kind !== 'open-inverted' &&
      tok.kind !== 'close' &&
      tok.kind !== 'comment'
    ) {
      continue;
    }
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    // Text before the tag on the same line must be whitespace-only (or the
    // tag must start the template / follow another tag's stripped line).
    let prevOk: boolean;
    let prevCut = 0;
    if (prev === undefined) {
      prevOk = true;
    } else if (prev.kind !== 'text') {
      prevOk = false;
    } else {
      const nl = prev.value.lastIndexOf('\n');
      const tail = prev.value.slice(nl + 1);
      prevOk = /^[ \t]*$/.test(tail);
      prevCut = tail.length;
    }
    if (!prevOk) continue;

    // Text after the tag up to and including the newline must be whitespace.
    let nextOk: boolean;
    let nextCut = 0;
    if (next === undefined) {
      nextOk = true;
    } else if (next.kind !== 'text') {
      nextOk = false;
    } else {
      const m = /^[ \t]*(\r?\n|$)/.exec(next.value);
      nextOk = m !== null;
      nextCut = m ? m[0].length : 0;
    }
    if (!nextOk) continue;

    if (prev && prev.kind === 'text' && prevCut > 0) {
      prev.value = prev.value.slice(0, prev.value.length - prevCut);
    }
    if (next && next.kind === 'text' && nextCut > 0) {
      next.value = next.value.slice(nextCut);
    }
  }
  return tokens.filter((t) => !(t.kind === 'text' && t.value.length === 0));
}

function parse(tokens: Token[]): Node[] {
  const root: Node[] = [];
  const stack: Array<{ name: string; children: Node[] }> = [];
  let current = root;

  for (const tok of tokens) {
    switch (tok.kind) {
      case 'text':
        current.push({ kind: 'text', text: tok.value });
        break;
      case 'var':
        current.push({ kind: 'var', name: tok.value });
        break;
      case 'comment':
        break;
      case 'open':
      case 'open-inverted': {
        const node: Node = {
          kind: 'section',
          name: tok.value,
          inverted: tok.kind === 'open-inverted',
          children: [],
        };
        current.push(node);
        stack.push({ name: tok.value, children: current });
        current = node.children;
        break;
      }
      case 'close': {
        const open = stack.pop();
        if (!open || open.name !== tok.value) {
          throw new Error(
            `template: unbalanced section — closing "${tok.value}" ${
              open ? `while "${open.name}" is open` : 'with no open section'
            }`,
          );
        }
        current = open.children;
        break;
      }
    }
  }
  if (stack.length > 0) {
    throw new Error(
      `template: section "${stack[stack.length - 1]!.name}" was never closed`,
    );
  }
  return root;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function render(nodes: Node[], values: TemplateValues): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.text;
        break;
      case 'var':
        out += stringify(values[node.name]);
        break;
      case 'section': {
        const truthy = isTruthy(values[node.name]);
        if (truthy !== node.inverted) out += render(node.children, values);
        break;
      }
    }
  }
  return out;
}

/** A parsed template that can be rendered repeatedly. */
export interface CompiledTemplate {
  render(values: TemplateValues): string;
}

/** Parse once, render many. Throws on unbalanced sections. */
export function compileTemplate(template: string): CompiledTemplate {
  const nodes = parse(tokenize(template));
  return { render: (values) => render(nodes, values) };
}

/** One-shot convenience for `compileTemplate(template).render(values)`. */
export function renderTemplate(
  template: string,
  values: TemplateValues,
): string {
  return compileTemplate(template).render(values);
}
