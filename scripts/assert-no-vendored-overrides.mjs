#!/usr/bin/env node
// prepublishOnly guard: a workspace `overrides` entry that resolves a
// dependency from `file:vendor/...` exists only in this repository, so a
// package published while one is in place names a version consumers cannot
// install. Publish the vendored package to the registry, pin it, remove the
// override, then publish.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split(
  '\n',
);
const vendored = [];
let inOverrides = false;
for (const line of lines) {
  if (/^\S/.test(line)) inOverrides = /^overrides:\s*$/.test(line);
  else if (inOverrides && /file:vendor\//.test(line))
    vendored.push(line.trim());
}
if (vendored.length) {
  console.error(
    `Refusing to publish: pnpm-workspace.yaml overrides resolve from vendored archives:\n  ${vendored.join('\n  ')}`,
  );
  process.exit(1);
}
