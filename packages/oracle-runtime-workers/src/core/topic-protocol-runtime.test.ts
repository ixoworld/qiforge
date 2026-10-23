import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The topic adapters bundle `@ixo/topic-protocol` into the Worker. Cloudflare
 * Workers forbid code generation from strings, so a build of that package
 * that still compiles its JSON-schema validators with Ajv (`new Function`)
 * throws `EvalError` the moment the module is evaluated and takes the whole
 * Worker down with it, switches on or off. The vitest Workers pool allows
 * eval, so the proof is a Node child process started with the same ban:
 * importing the pinned package's entry points and validating with them must
 * work there. 1.0.0-rc.7 fails this; 1.0.0-rc.8 (precompiled validators)
 * passes it.
 */
describe('@ixo/topic-protocol on Workers', () => {
  // The package's `exports` map has no "." entry, so it is located by path:
  // this package's own node_modules link to it.
  const root = fileURLToPath(
    new URL('../../node_modules/@ixo/topic-protocol/', import.meta.url).href,
  );
  const probe = `
    const main = await import(${JSON.stringify(join(root, 'dist/src/index.js'))});
    const v2 = await import(${JSON.stringify(join(root, 'dist/src/v2/validate.js'))});
    if (typeof main.validateContract !== 'function') throw new Error('validateContract missing');
    const result = main.validateContract('topic-root', {});
    if (result === undefined) throw new Error('validateContract returned nothing');
    if (typeof v2.validateV2 !== 'function') throw new Error('validateV2 missing');
    console.log('ok');
  `;

  it('imports and validates with code generation from strings forbidden', () => {
    expect(existsSync(join(root, 'dist/src/index.js'))).toBe(true);
    const run = () =>
      execFileSync(
        process.execPath,
        [
          '--disallow-code-generation-from-strings',
          '--input-type=module',
          '-e',
          probe,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        },
      );
    let output: string;
    try {
      output = run();
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error
          ? String(error.stderr)
          : String(error);
      throw new Error(
        `The pinned @ixo/topic-protocol generates code at run time and would fail a Worker at boot; pin a release with precompiled validators (1.0.0-rc.8 or later).\n${stderr.slice(0, 2000)}`,
      );
    }
    expect(output.trim()).toBe('ok');
  });
});
