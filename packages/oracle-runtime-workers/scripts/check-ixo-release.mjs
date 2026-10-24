import { Buffer } from 'node:buffer';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  assessRelease,
  candidateSchema,
  evidenceSchema,
  digest,
} from './ixo-release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
async function bounded(path) {
  if ((await stat(path)).size > 16 * 1024 * 1024)
    throw new Error('Artifact too large');
  return readFile(path);
}
async function contained(root, path) {
  if (isAbsolute(path)) throw new Error('Absolute artifact path');
  const actual = await realpath(resolve(root, path));
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('Artifact escapes root');
  return actual;
}
const git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error('Source checkout unavailable');
  return result.stdout.trim();
};
try {
  const args = process.argv.slice(2);
  const accepted = new Set([
    '--candidate',
    '--evidence',
    '--source',
    '--network',
  ]);
  if (
    args.length !== 8 ||
    args.some((a, i) => i % 2 === 0 && !accepted.delete(a)) ||
    accepted.size
  ) {
    throw new Error(
      'Usage: --candidate FILE --evidence FILE --source EXACT_QIFORGE --network devnet|testnet|mainnet',
    );
  }
  const options = Object.fromEntries(
    Array.from({ length: 4 }, (_, i) => [args[i * 2], args[i * 2 + 1]]),
  );
  const candidate = candidateSchema.parse(
    JSON.parse(await bounded(resolve(options['--candidate']))),
  );
  const evidencePath = await realpath(resolve(options['--evidence']));
  const evidence = evidenceSchema.parse(
    JSON.parse(await bounded(evidencePath)),
  );
  const root = dirname(evidencePath);
  const artifacts = new Map();
  const refs = [
    evidence.localConformance,
    ...evidence.receipts.flatMap((r) => [
      r.review.attestation,
      ...r.cases.flatMap((c) => c.artifacts),
    ]),
  ].filter(Boolean);
  for (const ref of refs) {
    try {
      artifacts.set(ref.path, await bounded(await contained(root, ref.path)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const sourceRoot = await realpath(resolve(options['--source']));
  const source = {
    head: git(sourceRoot, ['rev-parse', 'HEAD']),
    dirty: git(sourceRoot, ['status', '--porcelain']).length > 0,
    digests: {},
  };
  const local =
    evidence.localConformance && artifacts.get(evidence.localConformance.path);
  if (local) {
    const report = JSON.parse(local.toString('utf8'));
    for (const path of Object.keys(report.sourceDigests ?? {})) {
      try {
        source.digests[path] = digest(
          await bounded(await contained(sourceRoot, path)),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const gateSha256 = digest(
    Buffer.concat(
      await Promise.all(
        [
          'ixo-release.mjs',
          'check-ixo-release.mjs',
          'ixo-conformance-report.mjs',
          '../../../pnpm-lock.yaml',
        ].map((name) => readFile(resolve(here, name))),
      ),
    ),
  );
  const result = assessRelease({
    candidate,
    evidence,
    artifacts,
    source,
    gateSha256,
    network: options['--network'],
    now: Date.now(),
  });
  process.stdout.write(
    `${JSON.stringify({ ...result, observedGateSha256: gateSha256 }, null, 2)}\n`,
  );
  process.exitCode =
    result.assessment === 'RECORDS_COMPLETE_FOR_REVIEW' ? 0 : 3;
} catch {
  process.stderr.write(
    'Malformed or unreadable release input. Expected --candidate FILE --evidence FILE --source EXACT_QIFORGE --network devnet|testnet|mainnet. No deployment was authorized.\n',
  );
  process.exitCode = 2;
}
