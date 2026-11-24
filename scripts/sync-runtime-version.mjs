#!/usr/bin/env node
// Runs after `changeset version` (root `version` script): writes the
// version `changeset version` just gave @ixo/oracle-runtime-workers into
// `src/traces/runtime-version.ts`, the constant the turn tracer reports as
// `runtime_version`. A constant, not a JSON import: the package ships its
// TypeScript source, and an oracle's tsconfig need not allow JSON modules.
// `src/traces/runtime-version.test.ts` fails when the two drift apart.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'oracle-runtime-workers',
);
const { version } = JSON.parse(
  readFileSync(join(pkgDir, 'package.json'), 'utf8'),
);
const target = join(pkgDir, 'src', 'traces', 'runtime-version.ts');
const source = readFileSync(target, 'utf8');
const next = source.replace(
  /export const RUNTIME_VERSION = '[^']*';/,
  `export const RUNTIME_VERSION = '${version}';`,
);
if (!next.includes(`'${version}'`))
  throw new Error(`could not set RUNTIME_VERSION in ${target}`);
if (next !== source) writeFileSync(target, next);
