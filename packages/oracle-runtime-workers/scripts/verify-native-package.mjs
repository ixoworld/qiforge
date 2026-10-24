import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import ts from 'typescript';
import { builtinModules } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'ixo-native-package-'));
const packages = new Map();
for (const directory of await readdir(resolve(root, '..'))) {
  try {
    const path = resolve(root, '..', directory);
    const manifest = JSON.parse(
      await readFile(join(path, 'package.json'), 'utf8'),
    );
    packages.set(manifest.name, { path, manifest });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
const packed = new Set();
function pack(name) {
  if (packed.has(name)) return;
  const entry = packages.get(name);
  assert.ok(entry, `Missing workspace dependency ${name}`);
  packed.add(name);
  for (const [dependency, version] of Object.entries(
    entry.manifest.dependencies ?? {},
  )) {
    if (version.startsWith('workspace:')) pack(dependency);
  }
  run('pnpm', ['pack', '--pack-destination', scratch], entry.path);
}

let worker;
try {
  pack('@ixo/oracle-runtime-workers');
  const tarballs = (await readdir(scratch)).filter((name) =>
    name.endsWith('.tgz'),
  );
  process.stdout.write(
    `Packed ${packed.size} local packages. Installing the clean consumer.\n`,
  );
  await writeFile(
    join(scratch, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      overrides: { 'matrix-js-sdk': '42.2.0' },
    }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      ...tarballs.map((name) => join(scratch, name)),
      '@cloudflare/workers-types@5.20260825.1',
      '@types/node@22',
    ],
    scratch,
  );
  const installed = join(scratch, 'node_modules/@ixo/oracle-runtime-workers');
  process.stdout.write(
    'Consumer Matrix SDK is pinned to repository version 42.2.0 across dependencies and peers.\n',
  );
  const manifest = JSON.parse(
    await readFile(join(installed, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.exports['./ixo-tools'], './src/ixo-tools/index.ts');
  await writeFile(
    join(scratch, 'consumer.ts'),
    `
import { IxoToolsPlugin as RootPlugin, createOracleWorker } from '@ixo/oracle-runtime-workers';
import { IxoToolsPlugin as NativePlugin } from '@ixo/oracle-runtime-workers/ixo-tools';
import { SkillsPlugin } from '@ixo/oracle-runtime-workers/skills';
const skills = new SkillsPlugin();
const root = new RootPlugin();
const native = new NativePlugin();
const oracle = createOracleWorker({config: {name: 'Consumer'}, plugins: [root]});
void [oracle, native, skills];
`,
  );
  const program = ts.createProgram([join(scratch, 'consumer.ts')], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    allowJs: true,
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['@cloudflare/workers-types/experimental', 'node'],
    typeRoots: [
      join(scratch, 'node_modules/@types'),
      join(scratch, 'node_modules'),
    ],
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
  await writeFile(
    join(scratch, 'worker.js'),
    `
import { IxoToolsPlugin } from '@ixo/oracle-runtime-workers/ixo-tools';
import { SkillsPlugin } from '@ixo/oracle-runtime-workers/skills';
import { catalog } from '@ixo/agent-tools';
export default {
  async fetch(request) {
    if (new URL(request.url).pathname.startsWith('/skills')) {
      let secretReads = 0;
      const plugin = new SkillsPlugin({ucanBuilder: async () => undefined});
      const ctx = {
        config: {SKILLS_CAPSULES_BASE_URL: new URL(request.url).pathname === '/skills-redirect' ? 'https://registry-redirect.example' : 'https://registry.example', NETWORK: 'testnet'},
        skillAudience: async () => 'shared',
        secrets: {getAll: async () => {secretReads++; return {};}},
      };
      const tools = plugin.getTools(ctx);
      const inspector = tools.find(t => t.name === 'inspect_skill');
      const result = await inspector.handler({cid: 'QmYwAPJzv5CZsnAzt8auVTLWHtUAwKPWyVYFQnwxKZ3Uez', path: 'SKILL.md'}, ctx);
      return Response.json({names: tools.map(t => t.name), result, secretReads});
    }
    const plugin = new IxoToolsPlugin();
    let calls = 0;
    const surface = {
      discover: async () => ({status: 'available', tools: catalog.map(t => t.name)}),
      invoke: async () => {calls++; return {status: 'unavailable', reason: 'source_unavailable'};},
    };
    const ctx = {
      ixoTools: surface,
      user: {did: 'did:ixo:alice', timezone: 'UTC'},
      session: {id: 'session-a', roomId: '!room:ixo.test'},
    };
    const tools = await plugin.getRequestTools(ctx);
    const credits = tools.find(t => t.name === 'ixo_credits_get');
    const error = tools.find(t => t.name === 'ixo_error_explain');
    const result = await credits.handler({}, ctx);
    return Response.json({
      runtime: navigator.userAgent,
      name: plugin.name,
      count: tools.length,
      allRead: tools.every(t => t.effect === 'read'),
      valid: credits.schema.safeParse({}).success,
      rejectsOwner: !credits.schema.safeParse({userDid: 'did:ixo:bob'}).success,
      rejectsMixedError: !error.schema.safeParse({errorText: 'error', errorId: 'id'}).success,
      result, calls,
    });
  },
};
`,
  );
  const bundle = await build({
    entryPoints: [join(scratch, 'worker.js')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers', ...builtinModules, 'node:*'],
  });
  assert.ok(
    Object.keys(bundle.metafile.inputs).some((path) =>
      path.includes(
        'node_modules/@ixo/oracle-runtime-workers/src/plugins/ixo-tools/',
      ),
    ),
  );
  assert.equal(bundle.outputFiles.length, 1);
  const outboundOrigins = [];
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-08-20',
      compatibilityFlags: ['nodejs_compat'],
      outboundService: async (request) => {
        const url = new globalThis.URL(request.url);
        outboundOrigins.push(url.origin);
        if (url.origin === 'https://registry-redirect.example')
          return new globalThis.Response(null, {
            status: 307,
            headers: { Location: 'https://other.example/canary' },
          });
        assert.equal(url.origin, 'https://registry.example');
        assert.equal(url.searchParams.get('path'), 'SKILL.md');
        assert.equal(request.headers.has('Authorization'), false);
        return globalThis.Response.json({
          cid: 'QmYwAPJzv5CZsnAzt8auVTLWHtUAwKPWyVYFQnwxKZ3Uez',
          visibility: 'public',
          skillName: 'example',
          archiveSha256: 'a'.repeat(64),
          archiveSize: 1000,
          declaration: { status: 'legacy' },
          document: { path: 'SKILL.md', text: '# Example' },
        });
      },
    }),
  );
  const response = await worker.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    runtime: 'Cloudflare-Workers',
    name: 'ixo-tools',
    count: 10,
    allRead: true,
    valid: true,
    rejectsOwner: true,
    rejectsMixedError: true,
    result: { status: 'unavailable', reason: 'source_unavailable' },
    calls: 1,
  });
  const skillResponse = await worker.dispatchFetch('http://localhost/skills');
  const skillResult = await skillResponse.json();
  assert.deepEqual(skillResult.names, [
    'list_skills',
    'search_skills',
    'inspect_skill',
  ]);
  assert.equal(skillResult.secretReads, 0);
  assert.equal(skillResult.result.status, 'reference_only');
  assert.equal(skillResult.result.execution, 'unchecked');
  assert.equal(skillResult.result.document.text, '# Example');
  assert.equal(skillResult.result.mountIntegrity, 'unverified');
  const redirectResponse = await worker.dispatchFetch(
    'http://localhost/skills-redirect',
  );
  const redirected = await redirectResponse.json();
  assert.deepEqual(redirected.result, {
    status: 'blocked',
    reasons: ['inspection_unavailable'],
  });
  assert.equal(redirected.secretReads, 0);
  assert.deepEqual(outboundOrigins, [
    'https://registry.example',
    'https://registry-redirect.example',
  ]);
  const denied = await build({
    stdin: {
      contents:
        "import '@ixo/oracle-runtime-workers/src/ixo-tools/turn-host.ts';",
      resolveDir: scratch,
    },
    bundle: true,
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  }).then(
    () => false,
    () => true,
  );
  assert.equal(
    denied,
    true,
    'Internal host constructor became a public deep import',
  );
  process.stdout.write(
    `Installed native plugin and shell-free skill inspection passed types, schemas and workerd execution. Packed ${packed.size} workspace dependencies.\n`,
  );
} finally {
  await worker?.dispose();
  await rm(scratch, { recursive: true, force: true });
}
