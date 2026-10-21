import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The topic adapters bundle `@ixo/topic-protocol` into the Worker. Cloudflare
 * Workers forbid code generation from strings, so a build of that package
 * that still compiles its JSON-schema validators with Ajv at run time
 * (`new Ajv2020()` → `new Function`) throws `EvalError` the moment the
 * module is evaluated and takes the whole Worker down with it, switches on
 * or off. The vitest Workers pool allows eval, so only the package's own
 * source can prove the pin is safe: a release with precompiled validators
 * imports no Ajv compiler and generates nothing.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('@ixo/topic-protocol on Workers', () => {
  it('ships precompiled validators: nothing in its dist generates code at run time', () => {
    // The package's `exports` map has no "." entry, so it is located by
    // path: this package's own node_modules link to it.
    const root = fileURLToPath(
      new URL('../../node_modules/@ixo/topic-protocol/', import.meta.url).href,
    );
    const offenders = walk(join(root, 'dist'))
      .filter((file) => file.endsWith('.js'))
      .filter((file) =>
        /\bnew Function\b|\bFunction\(|\beval\(|from ["']ajv(\/dist\/(2020|ajv|core))?(\.js)?["']|new Ajv(2020)?\(/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => file.slice(root.length));
    expect(offenders).toEqual([]);
  });
});
