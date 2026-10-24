import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedExports = [
  'CATALOG_VERSION',
  'SOURCE_ENVELOPE_VERSION',
  'catalog',
  'createAgentToolsHost',
  'mcpTools',
  'nativeTools',
].sort();
const expectedTypes = [
  'Adapter',
  'AdapterInput',
  'Adapters',
  'AgentToolsHost',
  'Available',
  'ContextToken',
  'DeepReadonly',
  'DisclosedEvidence',
  'Discovery',
  'EvidenceSource',
  'HostFacts',
  'HostOptions',
  'InvalidRequestReason',
  'Refusal',
  'ResourceReceipt',
  'ToolInput',
  'ToolName',
  'ToolValue',
  'UnauthorizedReason',
  'UnavailableReason',
  'VerifiedGrant',
];

function checkManifest(manifest) {
  assert.equal(manifest.name, '@ixo/agent-tools');
  assert.deepEqual(Object.keys(manifest.exports), ['.']);
  assert.deepEqual(manifest.exports['.'], {
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  });
  assert.deepEqual(manifest.files, ['dist', 'README.md']);
  assert.deepEqual(manifest.dependencies, { zod: '4.4.3' });
  for (const field of [
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
  ]) {
    assert.equal(
      manifest[field],
      undefined,
      `${field} requires explicit boundary review`,
    );
  }
}

function checkExports(names) {
  assert.deepEqual([...names].sort(), expectedExports);
}

function checkDeclarations(source) {
  const file = ts.createSourceFile(
    'index.d.ts',
    source,
    ts.ScriptTarget.ES2022,
  );
  const names = [];
  for (const statement of file.statements) {
    assert.ok(ts.isExportDeclaration(statement));
    assert.ok(
      statement.exportClause && ts.isNamedExports(statement.exportClause),
    );
    names.push(
      ...statement.exportClause.elements.map((element) => element.name.text),
    );
  }
  assert.deepEqual(names.sort(), [...expectedExports, ...expectedTypes].sort());
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
checkManifest(manifest);
assert.throws(() =>
  checkManifest({
    ...manifest,
    exports: { ...manifest.exports, './internal': './dist/host.js' },
  }),
);
assert.throws(() =>
  checkManifest({
    ...manifest,
    dependencies: { ...manifest.dependencies, '@ixo/ucan': '*' },
  }),
);
assert.throws(() =>
  checkExports([...expectedExports, 'rawSubscriptionsClient']),
);

const scratch = await mkdtemp(join(tmpdir(), 'ixo-agent-tools-package-'));
let worker;
try {
  run('pnpm', ['pack', '--pack-destination', scratch], root);
  const tarballs = (await readdir(scratch)).filter((name) =>
    name.endsWith('.tgz'),
  );
  assert.equal(tarballs.length, 1);
  const [tarball] = tarballs;
  const tarballPath = join(scratch, tarball);
  await writeFile(
    join(scratch, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballPath,
    ],
    scratch,
  );

  const installed = join(scratch, 'node_modules/@ixo/agent-tools');
  checkManifest(
    JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')),
  );
  const artifact = await import(
    pathToFileURL(join(installed, 'dist/index.js')).href
  );
  checkExports(Object.keys(artifact));
  const declarations = await readFile(
    join(installed, 'dist/index.d.ts'),
    'utf8',
  );
  checkDeclarations(declarations);
  assert.throws(() =>
    checkDeclarations(
      `${declarations}\nexport type { RawClient } from './host.js';`,
    ),
  );
  const consumer = join(scratch, 'consumer.ts');
  await writeFile(
    consumer,
    `
import { createAgentToolsHost } from '@ixo/agent-tools';
const host = createAgentToolsHost();
const token = host.bindContext({});
const result = await host.invoke(token, 'ixo_credits_get', {});
if (result.status === 'available') {
  const amount: string = result.value.amount;
  const denomination: 'upay' = result.value.denomination;
}
`,
  );
  const program = ts.createProgram([consumer], {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => scratch,
      getNewLine: () => '\n',
    }),
  );
  assert.throws(() => checkExports([...Object.keys(artifact), 'rawClient']));
  await writeFile(
    join(scratch, 'denied.mjs'),
    `import '@ixo/agent-tools/dist/host.js';`,
  );
  const denied = spawnSync(process.execPath, ['denied.mjs'], {
    cwd: scratch,
    encoding: 'utf8',
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  const files = run('tar', ['-tzf', tarballPath], scratch).trim().split('\n');
  for (const required of [
    'package/README.md',
    'package/dist/index.js',
    'package/dist/index.d.ts',
  ]) {
    assert.ok(files.includes(required), `Missing packed artifact ${required}`);
  }
  assert.ok(
    files.every((file) =>
      /^package\/(dist\/[^/]+\.(js|d\.ts)|package\.json|README\.md)$/.test(
        file,
      ),
    ),
    files.join('\n'),
  );

  await writeFile(
    join(scratch, 'worker.js'),
    await readFile(join(root, 'test/worker.mjs'), 'utf8'),
  );
  const bundle = await build({
    entryPoints: [join(scratch, 'worker.js')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(bundle.metafile.inputs).some((file) =>
      file.includes('node_modules/@ixo/agent-tools/dist/'),
    ),
  );
  assert.equal(bundle.outputFiles.length, 1);
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-08-20',
      compatibilityFlags: [],
    }),
  );
  const response = await worker.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    runtime: 'workerd',
    availableAmount: '123456789012345678901.001',
    invalidArguments: 'invalid_arguments',
    forgedContext: 'invalid_context',
    revoked: 'grant_missing',
    catalogParity: true,
  });
  console.log(
    'Packed package passes export/dependency negative controls and isolated workerd invocation without nodejs_compat.',
  );
} finally {
  await worker?.dispose();
  await rm(scratch, { recursive: true, force: true });
}
