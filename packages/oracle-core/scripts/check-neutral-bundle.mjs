/**
 * Portability gate: bundle the core entrypoint for a NEUTRAL platform with
 * all bare package imports external. Two properties are proven:
 *
 *  1. Every module in THIS package resolves and bundles without a Node
 *     platform — any `node:*` (or bare Node built-in) import in our source
 *     is a hard resolution error here, not a runtime surprise in workerd.
 *  2. The emitted bundle contains no `node:` specifiers, so nothing snuck
 *     through via re-exports.
 *
 * Dependencies are external ON PURPOSE: their portability is vouched
 * separately (langchain publishes Cloudflare-Workers support; zod,
 * node-emoji, eventemitter2 are platform-free) and re-verified by the
 * worker adapter's own build. `nodejs_compat` is deliberately NOT part of
 * this check — compat stubs proving nothing is the failure mode this gate
 * exists to avoid.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const result = await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  packages: 'external',
  write: false,
  logLevel: 'silent',
});

const output = result.outputFiles.map((f) => f.text).join('\n');
const nodeSpecifiers = output.match(/from\s*["']node:[^"']+["']/g) ?? [];
if (nodeSpecifiers.length > 0) {
  console.error(
    `Neutral bundle contains Node specifiers:\n  ${nodeSpecifiers.join('\n  ')}`,
  );
  process.exit(1);
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
console.log(
  `${pkg.name}: neutral-platform bundle OK (${(output.length / 1024).toFixed(1)} KiB, 0 node: specifiers).`,
);
