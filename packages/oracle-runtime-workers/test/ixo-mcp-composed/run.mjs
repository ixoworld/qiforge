import process from 'node:process';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, '../..');
assert.ok(process.argv[2], 'Pass the local ixo-auth-worker source directory.');
const authRoot = resolve(process.argv[2]);
assert.equal(
  JSON.parse(await readFile(join(authRoot, 'package.json'), 'utf8')).name,
  'ixo-auth-worker',
);
const evidencePath = process.argv[3]
  ? resolve(process.argv[3])
  : join(here, 'result.local.json');
const requireRuntime = createRequire(join(runtimeRoot, 'package.json'));
const { build } = await import(
  pathToFileURL(requireRuntime.resolve('esbuild'))
);
const { Miniflare, convertV4MiniflareOptions } = await import(
  pathToFileURL(requireRuntime.resolve('miniflare'))
);
const { Client } = await import(
  pathToFileURL(
    requireRuntime.resolve('@modelcontextprotocol/sdk/client/index.js'),
  )
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(
    requireRuntime.resolve(
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
    ),
  )
);
const { LATEST_PROTOCOL_VERSION } = await import(
  pathToFileURL(requireRuntime.resolve('@modelcontextprotocol/sdk/types.js'))
);
const fixtureSecret = 'local-only-proof-control-not-a-service-credential';
const authOrigin = 'https://auth.example';
const resource = 'https://oracle.example/v1/mcp';
const evidence = {
  at: new Date().toISOString(),
  node: process.version,
  runtime: 'actual workerd through Miniflare',
  sdk: JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'))
    .dependencies['@modelcontextprotocol/sdk'],
  protocol: LATEST_PROTOCOL_VERSION,
  auth: 'real Auth Hub app /oauth/introspect with real signed JWT and current D1 state',
  native: 'real signed delegation and WorkersUcanService mint',
  source:
    'controlled subscriptions worker, cryptographic UCAN chain validation',
  bundleSha256: {},
  checks: [],
  outbound: { introspection: 0, source: 0, other: 0 },
  sourceObservations: [],
};
const bundles = {};
for (const name of ['auth', 'runtime', 'source']) {
  const result = await build({
    entryPoints: [join(here, `${name}-entry.mjs`)],
    bundle: true,
    alias: { '@stage7-auth': authRoot },
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*', ...builtinModules, 'node:*'],
    logLevel: 'warning',
  });
  assert.equal(result.outputFiles.length, 1);
  bundles[name] = result.outputFiles[0].text;
  evidence.bundleSha256[name] = createHash('sha256')
    .update(bundles[name])
    .digest('hex');
}
const makeWorker = (options) =>
  new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-08-20',
      compatibilityFlags: ['nodejs_compat'],
      ...options,
    }),
  );
let auth;
let runtime;
let source;
let revokeDuringSource = false;
let ingressTokens = new Set();
let sourceBearerViolations = 0;
const clients = [];
async function fixture(worker, origin, path, body) {
  const response = await worker.dispatchFetch(`${origin}/__fixture/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-local-proof': fixtureSecret,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function token(client = 'client-1') {
  const value = await fixture(auth, authOrigin, 'token', { client });
  ingressTokens.add(value.token);
  return value;
}
async function rawCall(token, method = 'tools/list', params) {
  return runtime.dispatchFetch(resource, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
}
async function sdk(token) {
  const transport = new StreamableHTTPClientTransport(
    new globalThis.URL(resource),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const request = new globalThis.Request(input, init);
        return runtime.dispatchFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body:
            request.method === 'POST' ? await request.arrayBuffer() : undefined,
        });
      },
    },
  );
  const client = new Client({
    name: 'stage7-composed-proof',
    version: '1.0.0',
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}
function passed(name) {
  evidence.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
try {
  auth = makeWorker({
    script: bundles.auth,
    d1Databases: { DB: 'stage7-proof-db' },
    bindings: {
      LOCAL_STAGE7_PROOF: 'yes',
      LOCAL_FIXTURE_SECRET: fixtureSecret,
      ENVIRONMENT: 'production',
      AUTH_HUB_HOSTNAME: 'auth.example',
      OAUTH_SIGNING_JWK:
        '{"crv":"Ed25519","d":"SkyQM70NqW2Zjupx90hYWGHpzeTkJsxSEcK7IOFcnI8","x":"KUreDZHRrhgaP4iXSOkPzM6MNbf1jNoM6VHP8burlu0","kty":"OKP","kid":"test-1","alg":"EdDSA"}',
    },
    outboundService: () => {
      throw new Error('Unexpected Auth Hub outbound I/O');
    },
  });
  const db = await auth.getD1Database('DB');
  const migrations = (await readdir(join(authRoot, 'migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of migrations) {
    const sql = (
      await readFile(join(authRoot, 'migrations', name), 'utf8')
    ).replace(/--.*$/gm, '');
    for (const statement of sql
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  evidence.migrations = migrations;
  await fixture(auth, authOrigin, 'seed', {});
  source = makeWorker({
    script: bundles.source,
    outboundService: () => {
      throw new Error('Unexpected source outbound I/O');
    },
  });
  runtime = makeWorker({
    script: bundles.runtime,
    bindings: {
      LOCAL_STAGE7_PROOF: 'yes',
      LOCAL_FIXTURE_SECRET: fixtureSecret,
      IXO_MCP_RESOURCE_CLIENT_SECRET: 'local-resource-secret',
    },
    outboundService: async (request) => {
      const url = new globalThis.URL(request.url);
      if (url.origin === authOrigin) {
        assert.equal(url.pathname, '/oauth/introspect');
        assert.equal(
          request.headers.get('authorization'),
          `Basic ${Buffer.from('resource-1:local-resource-secret').toString('base64')}`,
        );
        evidence.outbound.introspection++;
        return auth.dispatchFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: await request.arrayBuffer(),
        });
      }
      if (url.origin === 'https://subscriptions.ixo.test') {
        const authorization = request.headers.get('authorization') ?? '';
        if (
          ingressTokens.has(authorization.slice('Bearer '.length)) ||
          authorization.includes('local-resource-secret')
        )
          sourceBearerViolations++;
        assert.equal(
          sourceBearerViolations,
          0,
          'Ingress bearer and resource secret must never reach source',
        );
        if (url.pathname !== '/.well-known/did.json') {
          evidence.outbound.source++;
          if (revokeDuringSource) {
            revokeDuringSource = false;
            await fixture(auth, authOrigin, 'state', { action: 'revoke' });
          }
        }
        return source.dispatchFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body:
            request.method === 'POST' ? await request.arrayBuffer() : undefined,
        });
      }
      evidence.outbound.other++;
      throw new Error(`Unexpected runtime outbound origin ${url.origin}`);
    },
  });
  const first = await token();
  const client = await sdk(first.token);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    'ixo_account_get',
    'ixo_concept_get',
    'ixo_credits_get',
  ]);
  passed(
    'pinned SDK initialize, initialized notification and native tools/list against real Auth Hub authority',
  );
  const credits = await client.callTool({
    name: 'ixo_credits_get',
    arguments: {},
  });
  assert.equal(credits.isError, false);
  assert.equal(credits.structuredContent.status, 'available');
  assert.equal(credits.structuredContent.value.amount, '1234');
  assert.equal(credits.structuredContent.value.denomination, 'upay');
  passed(
    'SDK credits call uses actual shared host, source adapter and signed narrowed UCAN',
  );
  const shared = await token('client-shared');
  const sharedClient = await sdk(shared.token);
  assert.deepEqual(
    (await sharedClient.listTools()).tools.map((t) => t.name),
    ['ixo_concept_get'],
  );
  passed(
    'default shared client lists only the public concept tool and discloses no personal account or credits tool',
  );
  const beforeDeny = evidence.outbound.source;
  assert.equal(
    (await rawCall(first.token.slice(0, -6) + 'BADBAD')).status,
    401,
  );
  const unregistered = await token('client-unregistered');
  assert.equal((await rawCall(unregistered.token)).status, 401);
  assert.equal(evidence.outbound.source, beforeDeny);
  passed(
    'invalid signature and badge-only unregistered client refuse before source I/O',
  );
  const second = await token('client-2');
  const secondClient = await sdk(second.token);
  assert.equal(
    (await secondClient.callTool({ name: 'ixo_account_get', arguments: {} }))
      .structuredContent.value.address,
    'alice',
  );
  const scopeState = await fixture(
    runtime,
    'https://oracle.example',
    'state',
    {},
  );
  const scope1 = scopeState.scopes.find((entry) => entry.client === 'client-1');
  const scope2 = scopeState.scopes.find((entry) => entry.client === 'client-2');
  assert.notEqual(scope1.sessionId, scope2.sessionId);
  assert.equal(scope1.userDid, scope2.userDid);
  assert.ok(scope1.sessionId.startsWith('mcp:'));
  passed(
    'two allowed OAuth clients have different deterministic non-chat contexts for the same owner',
  );
  for (const [deny, restore] of [
    ['disableJoin', 'enableJoin'],
    ['block', 'unblock'],
    ['failUser', 'restoreUser'],
    ['disableResource', 'enableResource'],
  ]) {
    await fixture(auth, authOrigin, 'state', { action: deny });
    assert.equal((await rawCall(first.token)).status, 401, deny);
    await fixture(auth, authOrigin, 'state', { action: restore });
    assert.equal((await rawCall(first.token)).status, 200, restore);
  }
  assert.equal(evidence.outbound.source, beforeDeny + 1);
  passed(
    'current D1 client block, resource/client join, user eligibility and resource disable deny and recover',
  );
  await fixture(auth, authOrigin, 'state', { action: 'revoke' });
  assert.equal((await rawCall(first.token)).status, 401);
  const fresh = await token();
  assert.notEqual(first.generation, fresh.generation);
  assert.equal(first.gid, fresh.gid);
  assert.equal((await rawCall(first.token)).status, 401);
  assert.equal((await rawCall(fresh.token)).status, 200);
  passed(
    'revocation and same-grant re-consent generation never revive the old signed token',
  );
  const nativeOffStart = evidence.outbound.source;
  await fixture(runtime, 'https://oracle.example', 'state', {
    action: 'nativeOff',
  });
  const none = await (await rawCall(fresh.token)).json();
  assert.deepEqual(none.result.tools, []);
  const denied = await (
    await rawCall(fresh.token, 'tools/call', {
      name: 'ixo_credits_get',
      arguments: {},
    })
  ).json();
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.status, 'unauthorized');
  assert.equal(evidence.outbound.source, nativeOffStart);
  await fixture(runtime, 'https://oracle.example', 'state', {
    action: 'nativeOn',
  });
  passed('active OAuth cannot replace withdrawn current native delegation');
  await fixture(runtime, 'https://oracle.example', 'state', {
    action: 'shortExpiry',
  });
  const short = await (
    await rawCall(fresh.token, 'tools/call', {
      name: 'ixo_credits_get',
      arguments: {},
    })
  ).json();
  assert.equal(short.result.structuredContent.status, 'available');
  let observations = await (
    await source.dispatchFetch('https://subscriptions.ixo.test/__observations')
  ).json();
  assert.ok(
    observations.at(-1).expiration - observations.at(-1).observedAt <= 15,
  );
  passed(
    'downstream minted UCAN expiry respects the shorter current native lifetime',
  );
  revokeDuringSource = true;
  const inFlight = await rawCall(fresh.token, 'tools/call', {
    name: 'ixo_credits_get',
    arguments: {},
  });
  assert.equal(inFlight.status, 401);
  const withheld = await inFlight.text();
  assert.equal(withheld.includes('1234'), false);
  assert.equal(withheld.includes('subscription_credits'), false);
  passed(
    'real D1 revocation during source response withholds the completed credits payload',
  );
  observations = await (
    await source.dispatchFetch('https://subscriptions.ixo.test/__observations')
  ).json();
  for (const entry of observations) {
    assert.equal(entry.audience, 'did:web:subscriptions.ixo.test');
    assert.equal(entry.issuer, 'did:ixo:companion');
    assert.deepEqual(entry.capabilities, [
      { can: 'subscriptions/read', with: 'ixo:subscriptions' },
    ]);
    assert.ok(entry.expiration - entry.observedAt <= 60);
    assert.equal(entry.tokenIsJwt, false);
    assert.deepEqual(entry.proofChain, ['did:ixo:alice', 'did:ixo:companion']);
  }
  assert.equal(evidence.outbound.other, 0);
  assert.equal(sourceBearerViolations, 0);
  evidence.sourceObservations = observations;
  passed(
    'controlled downstream cryptographically validates every proof chain, exact audience and 60-second ceiling; no ingress bearer or secret downstream',
  );
  evidence.result = 'PASS';
  evidence.limits = [
    'Local actual workerd composition, not hosted activation or deployment evidence',
    'Auth Hub signed-token fixture and D1 operator rows seeded by a local-only wrapper; interactive consent and code/refresh flows covered in Auth Hub repository tests, not this harness',
    'Runtime uses actual MCP protocol, createMcpIxoTools/createTurnIxoTools, source authority and WorkersUcanService; it does not traverse createOracleWorker or UserOracleDO owner persistence',
    'Native delegation signature and downstream proof chain are real; the current-native-delegation reader is fixture controlled rather than hydrated from owner storage',
    'Subscriptions balance is controlled synthetic external service data, not a live account balance',
    'Private disclosure is explicitly configured for the test clients and the current audience reader is fixture controlled; no real Matrix membership, live upstream UCAN revocation, external AI app privacy or hosted SDK acceptance is claimed',
  ];
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(
    `PASS composed proof ${evidence.checks.length} behavior groups; ${evidence.outbound.introspection} real introspections; ${evidence.outbound.source} controlled source requests\n`,
  );
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  await Promise.allSettled([
    runtime?.dispose(),
    source?.dispose(),
    auth?.dispose(),
  ]);
}
