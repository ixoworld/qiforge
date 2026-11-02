import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * V8 keeps a Worker's source text in the isolate for as long as it runs, and
 * stores it with two bytes per character as soon as one character is above
 * U+00FF. A minified bundle drops comments, and esbuild (wrangler's bundler)
 * escapes such characters in ordinary strings and templates, but it cannot
 * rewrite a regex literal or a tagged template (`String.raw` and others): their raw
 * text is what they mean. One such character there makes a minified
 * oracle's whole source (about 13M characters) cost twice its size in the
 * 128 MB isolate, so those literals use escapes (`\u3002`, `\u2610`).
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (
      path.endsWith('.ts') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.d.ts')
    )
      out.push(path);
  }
  return out;
}

/** A literal whose raw text reaches the bundle as written. */
function keptVerbatim(node: ts.Node): boolean {
  if (ts.isRegularExpressionLiteral(node)) return true;
  // A tagged template's own literal, or one of its spans' literals.
  let at: ts.Node = node;
  if (ts.isTemplateMiddle(at) || ts.isTemplateTail(at)) at = at.parent.parent;
  if (ts.isTemplateHead(at)) at = at.parent;
  return (
    (ts.isNoSubstitutionTemplateLiteral(at) || ts.isTemplateExpression(at)) &&
    ts.isTaggedTemplateExpression(at.parent)
  );
}

function wideLiterals(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isRegularExpressionLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      keptVerbatim(node)
    ) {
      const raw = node.getText(file);
      if ([...raw].some((char) => (char.codePointAt(0) ?? 0) > 0xff)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        hits.push(`${relative(SRC, path)}:${line + 1} ${raw.slice(0, 60)}`);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return hits;
}

describe('runtime literals the bundler keeps verbatim', () => {
  it('are Latin-1, so a minified bundle is stored at one byte per character', () => {
    const hits = sourceFiles(SRC).flatMap(wideLiterals);
    expect(hits).toEqual([]);
  });
});
