#!/usr/bin/env node
/**
 * `pnpm lint`: ESLint over every workspace package and the example app, one
 * process per package.
 *
 * A single `eslint packages` process holds the typed program of every package
 * at once (typescript-eslint's projectService keeps them all alive) and has
 * outgrown Node's default heap: it dies with "JavaScript heap out of memory"
 * at ~4 GB on CI and on a laptop alike. One process per package keeps the
 * peak to the largest package on its own, and the failing package is named
 * on its own line.
 *
 *   node scripts/lint.mjs            # everything
 *   node scripts/lint.mjs oracle-runtime-workers apps/qiforge-example
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** Packages that ship linted sources: a `src/` directory under packages/<name>. */
function lintablePackages() {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && existsSync(join(root, 'packages', d.name, 'src')),
    )
    .map((d) => `packages/${d.name}`)
    .sort();
}

const requested = process.argv.slice(2);
const targets =
  requested.length > 0
    ? requested.map((t) => (t.includes('/') ? t : `packages/${t}`))
    : [...lintablePackages(), 'apps/qiforge-example'];

let failed = 0;
for (const target of targets) {
  const started = Date.now();
  const result = spawnSync('pnpm', ['exec', 'eslint', target], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`lint ok: ${target} (${seconds}s)`);
    continue;
  }
  failed += 1;
  console.error(
    `lint FAILED: ${target} (exit ${result.status ?? result.signal}, ${seconds}s)`,
  );
}
if (failed > 0) {
  console.error(`\n${failed} lint target(s) failed`);
  process.exit(1);
}
