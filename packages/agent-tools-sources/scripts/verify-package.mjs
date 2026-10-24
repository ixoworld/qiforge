import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import ts from 'typescript';
import { protocolResponse } from '../test/source-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'ixo-agent-sources-package-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' },
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
let worker;
let redirectDid = false;
let redirectData = false;
let redirectTargets = 0;
let protocolRequests = 0;
const consumedTokens = new Set();
const server = createServer(async (request, response) => {
  try {
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url, origin);
    if (url.pathname === '/redirect-target') {
      redirectTargets++;
      response.writeHead(200).end('unexpected redirect');
      return;
    }
    if (
      (redirectDid && url.pathname === '/.well-known/did.json') ||
      (redirectData && url.pathname !== '/.well-known/did.json')
    ) {
      response.writeHead(302, { Location: `${origin}/redirect-target` }).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const bearer = request.headers.authorization;
    if (url.pathname !== '/.well-known/did.json') {
      assert.ok(bearer);
      assert.ok(!consumedTokens.has(bearer), 'invocation bearer reused');
      consumedTokens.add(bearer);
      protocolRequests++;
    }
    const result = await protocolResponse(url, {
      headers: request.headers,
      body,
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
try {
  run(
    'pnpm',
    ['pack', '--pack-destination', scratch],
    resolve(root, '../agent-tools'),
  );
  run('pnpm', ['pack', '--pack-destination', scratch], root);
  const tarballs = (await readdir(scratch))
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => join(scratch, file));
  assert.equal(tarballs.length, 2);
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
      ...tarballs,
    ],
    scratch,
  );
  const installed = join(scratch, 'node_modules/@ixo/agent-tools-sources');
  const manifest = JSON.parse(
    await readFile(join(installed, 'package.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(manifest.exports), ['.']);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    '@ixo/agent-tools',
    'zod',
  ]);
  assert.equal(manifest.dependencies.zod, '4.4.3');
  const artifact = await import(
    pathToFileURL(join(installed, 'dist/index.js')).href
  );
  assert.deepEqual(Object.keys(artifact), ['createIXOSourceAdapters']);
  const declarations = ts.createSourceFile(
    'index.d.ts',
    await readFile(join(installed, 'dist/index.d.ts'), 'utf8'),
    ts.ScriptTarget.ES2022,
  );
  const names = [];
  for (const statement of declarations.statements) {
    assert.ok(ts.isExportDeclaration(statement));
    assert.ok(
      statement.exportClause && ts.isNamedExports(statement.exportClause),
    );
    names.push(
      ...statement.exportClause.elements.map((item) => item.name.text),
    );
  }
  assert.deepEqual(
    names.sort(),
    [
      'AttachmentReceipt',
      'SessionAttachments',
      'SourceAuthority',
      'SourceConfig',
      'createIXOSourceAdapters',
    ].sort(),
  );
  await writeFile(
    join(scratch, 'denied.mjs'),
    "import '@ixo/agent-tools-sources/dist/http.js';",
  );
  const denied = spawnSync(process.execPath, ['denied.mjs'], {
    cwd: scratch,
    encoding: 'utf8',
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  await writeFile(
    join(scratch, 'consumer.ts'),
    "import { createIXOSourceAdapters, type SourceConfig } from '@ixo/agent-tools-sources';\nimport type { HostOptions } from '@ixo/agent-tools';\nconst factory: (config: SourceConfig) => Pick<HostOptions, 'adapters' | 'resourceAccess'> = createIXOSourceAdapters;\n",
  );
  const program = ts.createProgram([join(scratch, 'consumer.ts')], {
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
  const template = await readFile(join(root, 'test/worker.mjs'), 'utf8');
  const topic = await readFile(join(root, 'tests/fixtures/topics.md'), 'utf8');
  await writeFile(
    join(scratch, 'worker.js'),
    template.replace("'__TOPIC_BYTES__'", JSON.stringify(topic)),
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
      file.includes('node_modules/@ixo/agent-tools-sources/dist/'),
    ),
  );
  assert.equal(bundle.outputFiles.length, 1);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-08-20',
      compatibilityFlags: [],
      bindings: { SOURCE_ORIGIN: `http://127.0.0.1:${address.port}` },
    }),
  );
  const response = await worker.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.runtime, 'Cloudflare-Workers');
  assert.equal(result.results.length, 10);
  for (const entry of result.results)
    assert.equal(entry.result.status, 'available', JSON.stringify(entry));
  assert.equal(
    result.results.find((entry) => entry.name === 'ixo_credits_get').result
      .value.amount,
    '1234',
  );
  assert.ok(result.minted >= 10);
  assert.ok(
    protocolRequests >= 10,
    'native workerd fetch did not reach source HTTP server',
  );
  redirectDid = true;
  const deniedDid = await (
    await worker.dispatchFetch('http://localhost/')
  ).json();
  assert.equal(
    deniedDid.results.find((entry) => entry.name === 'ixo_account_get').result
      .status,
    'unavailable',
  );
  redirectDid = false;
  redirectData = true;
  const deniedData = await (
    await worker.dispatchFetch('http://localhost/')
  ).json();
  assert.equal(
    deniedData.results.find((entry) => entry.name === 'ixo_account_get').result
      .status,
    'unavailable',
  );
  assert.equal(
    redirectTargets,
    0,
    'a service redirect reached its destination',
  );
  console.log(
    'Installed source factory invoked all ten adapters through native workerd HTTP without nodejs_compat; DID/data redirects never reached destinations; exports, types and private imports passed.',
  );
} finally {
  await worker?.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
