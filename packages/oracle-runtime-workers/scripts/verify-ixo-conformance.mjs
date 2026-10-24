#!/usr/bin/env node
import process from 'node:process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  evaluateConformance,
  SUITES,
  SOURCE_PATHS,
  TOOLS,
} from './ixo-conformance-report.mjs';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(packageDir, '../..');
const args = process.argv.slice(2);
let requireHosted = false;
let outputPath;
let validArgs = true;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--require-hosted' && !requireHosted)
    requireHosted = true;
  else if (
    args[index] === '--output' &&
    !outputPath &&
    args[index + 1] &&
    !args[index + 1].startsWith('--')
  )
    outputPath = args[++index];
  else validArgs = false;
}
if (!validArgs) {
  process.stderr.write(
    'Usage: node scripts/verify-ixo-conformance.mjs [--output path] [--require-hosted]\n',
  );
  process.exit(2);
}
const output = resolve(
  packageDir,
  outputPath ?? 'artifacts/ixo-conformance-report.json',
);
const scratch = mkdtempSync(resolve(tmpdir(), 'ixo-conformance-'));
const jsonPath = resolve(scratch, 'vitest.json');
const observationsPath = resolve(scratch, 'observations.jsonl');
const run = (command, commandArgs, cwd = repoDir, env = process.env) =>
  spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
const git = (commandArgs) => run('git', commandArgs).stdout?.trim() ?? '';
const sha = (path) =>
  existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : null;
const sourcePaths = SOURCE_PATHS;
const sourceDigests = Object.fromEntries(
  sourcePaths.map((path) => [path, sha(resolve(repoDir, path))]),
);
const manifestVersion = (name) => {
  try {
    return JSON.parse(
      readFileSync(
        resolve(packageDir, 'node_modules', name, 'package.json'),
        'utf8',
      ),
    ).version;
  } catch {
    return null;
  }
};
const versions = {
  nativePlugin: JSON.parse(
    readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
  ).version,
  officialSdk: manifestVersion('@modelcontextprotocol/sdk'),
  patchedLangchainAdapter: manifestVersion('@langchain/mcp-adapters'),
  vitest: manifestVersion('vitest'),
};
let supportedProtocols = [];
try {
  const sdkTypes = await import('@modelcontextprotocol/sdk/types.js');
  supportedProtocols = [...sdkTypes.SUPPORTED_PROTOCOL_VERSIONS];
} catch {
  supportedProtocols = [];
}
let catalogNames = [];
try {
  catalogNames = [
    ...readFileSync(resolve(repoDir, sourcePaths[0]), 'utf8').matchAll(
      /name: '(ixo_[a-z_]+)'/g,
    ),
  ].map((match) => match[1]);
} catch {
  catalogNames = [];
}
const result = run(
  'pnpm',
  [
    '--config.verify-deps-before-run=false',
    'exec',
    'vitest',
    'run',
    ...SUITES.map((file) => `test/${file}`),
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${jsonPath}`,
  ],
  packageDir,
  { ...process.env, IXO_CONFORMANCE_OBSERVATIONS_FILE: observationsPath },
);
let vitest = null;
try {
  vitest = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch {
  vitest = null;
}
let observations = [];
try {
  observations = readFileSync(observationsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch {
  observations = null;
}
const local = evaluateConformance({
  vitest,
  observations,
  supportedProtocols,
  catalogNames,
});
if (result.status !== 0) local.issues.push('vitest_nonzero_exit');
if (Object.values(versions).some((value) => !value))
  local.issues.push('installed_version_missing');
if (Object.values(sourceDigests).some((value) => !value))
  local.issues.push('source_digest_missing');
local.status = local.issues.length ? 'FAIL' : 'PASS';
const hosted = [
  'ChatGPT hosted client',
  'Claude hosted client',
  'current Companion model journey',
  'deployed source and Worker routing',
].map((source) => ({ source, status: 'NOT_RUN', evidence: null }));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  local,
  clients: {
    native: {
      implementation: 'IxoToolsPlugin',
      runtimePackageVersion: versions.nativePlugin,
      protocol: null,
    },
    officialSdk: {
      implementation: '@modelcontextprotocol/sdk Client',
      installedVersion: versions.officialSdk,
      supportedProtocols,
      negotiatedProtocols: [
        ...new Set(
          local.rows
            .filter((row) => row.client === 'official-sdk')
            .map((row) => row.negotiatedProtocol)
            .filter(Boolean),
        ),
      ],
    },
    langchainAdapter: {
      implementation: '@langchain/mcp-adapters MultiServerMCPClient (patched)',
      installedVersion: versions.patchedLangchainAdapter,
      supportedProtocols,
      negotiatedProtocols: [
        ...new Set(
          local.rows
            .filter((row) => row.client === 'langchain-adapter')
            .map((row) => row.negotiatedProtocol)
            .filter(Boolean),
        ),
      ],
    },
  },
  fixture: 'synthetic local source data and OAuth introspection',
  runtime: {
    name: 'Cloudflare workerd through Vitest pool',
    hostNode: process.version,
    poolPackageVersion: manifestVersion('@cloudflare/vitest-pool-workers'),
  },
  limits: [
    'The client matrix interposes global fetch with synthetic source and OAuth introspection responses; it does not prove live source or hosted authorization behavior.',
    'The official SDK and LangChain adapter use the same pinned SDK transport; these are two real client entry points, not independent protocol stacks.',
    'Worker-entry tests use controlled owner RPC separately from real owner-storage tests; the complete hosted route is not established.',
    'Cross-POST SDK cancellation is advisory because each POST uses a request-local server. Client abort does not prove upstream I/O stopped.',
  ],
  hosted,
  release: 'NOT_ESTABLISHED',
  git: {
    head: git(['rev-parse', 'HEAD']) || null,
    dirty: Boolean(git(['status', '--porcelain'])),
  },
  sourceDigests,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
rmSync(scratch, { recursive: true, force: true });
process.stdout.write(
  `IXO local conformance ${local.status}; ${local.tests.length} observed tests; ${local.rows.filter((row) => row.status === 'PASS').length}/${TOOLS.length * 3} matrix rows. Report: ${output}\n`,
);
if (local.status !== 'PASS') process.exit(1);
if (requireHosted) process.exit(3);
