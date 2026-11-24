import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNTIME_VERSION } from './runtime-version';

describe('RUNTIME_VERSION', () => {
  it('is the version in package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg: unknown = JSON.parse(
      readFileSync(join(here, '..', '..', 'package.json'), 'utf8'),
    );
    expect(pkg).toMatchObject({ version: RUNTIME_VERSION });
  });
});
