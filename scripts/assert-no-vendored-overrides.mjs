#!/usr/bin/env node
// prepublishOnly guard: a workspace `overrides` entry that resolves a
// dependency from `file:vendor/...`, or a `file:` dependency of the package
// being published (a locally packed archive or a directory), exists only on
// the machine that wrote it, so a package published while one is in place
// names a version consumers cannot install. Publish the dependency to the
// registry, pin it, remove the override or `file:` spec, then publish.
// prepublishOnly runs in the package's own directory, so `process.cwd()` is
// the package being published.
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

const manifestPath = join(process.cwd(), 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const local = [];
for (const field of [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]) {
  for (const [name, spec] of Object.entries(manifest[field] ?? {}))
    if (typeof spec === 'string' && spec.startsWith('file:'))
      local.push(`${field}: ${name} ${spec}`);
}
if (local.length) {
  console.error(
    `Refusing to publish ${manifest.name ?? manifestPath}: file: dependencies resolve only on this machine:\n  ${local.join('\n  ')}`,
  );
  process.exit(1);
}
