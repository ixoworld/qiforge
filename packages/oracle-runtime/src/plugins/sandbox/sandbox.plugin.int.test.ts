/**
 * Sandbox plugin integration tests against the real devnet AI Sandbox.
 *
 * Why each test exists (every one earns its keep):
 *   - A1 sandbox_run: proves the full auth chain (resolveServiceDid →
 *     mintInvocation → Authorization header → sandbox accepts → executes →
 *     returns the result envelope) is intact end-to-end. A regression in
 *     ANY link breaks this.
 *   - A2 write-then-read: proves byte-perfect writes via sandbox_write_file
 *     are visible to a later sandbox_run in the SAME session — i.e. the
 *     /workspace/ filesystem semantics the manifest promises.
 *   - A3 oracle_* hidden: proves the security filter that keeps operator-
 *     grade controls (oracle_stop, oracle_restart, …) out of an agent's
 *     surface area is on by default. A regression here exposes privileged
 *     ops to user-facing oracles.
 *   - A4 oracle_* opt-in: proves the escape hatch — admin/dev-tooling
 *     oracles that pass `includeOracleManagementTools: true` actually get
 *     the tools. Without this, A3 could pass for the wrong reason
 *     (upstream removed oracle_* entirely).
 *   - B1 routing: proves the manifest steers the agent to sandbox_run for
 *     a plain "run this in the sandbox" prompt. Catches manifest drift.
 *
 * State isolation: write paths are tagged with a per-run UUID so
 * concurrent test runs don't read each other's files.
 *
 * No skip flags, no mocks. Missing env throws at file-load time.
 */
import { parseDelegation } from '@ixo/ucan';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { UcanService } from '../../modules/ucan/ucan.service.js';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  createIntegrationRuntime,
  type IntegrationOracle,
  type IntegrationRuntime,
  mintUserDelegation,
  sandboxCap,
  type SSEEvent,
  type SSEToolCallEventData,
  waitForMatrixLoaded,
} from '../../testing/integration/index.js';
import { SandboxPlugin } from './sandbox.plugin.js';

const REQUIRED_ENV = [
  'SANDBOX_MCP_URL',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'TEST_USER_DID',
  'TEST_USER_MNEMONIC',
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  'MATRIX_VALUE_PIN',
  'SECP_MNEMONIC',
  'OPEN_ROUTER_API_KEY',
] as const;

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `sandbox.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

const SANDBOX_CAPS = [{ resource: sandboxCap.with, action: sandboxCap.can }];

/** Decode whatever shape the upstream sandbox returns into searchable text. */
function envelopeToString(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

describe('sandbox plugin — integration', () => {
  let oracle: IntegrationOracle;
  let runtime: IntegrationRuntime;
  let chatClient: ChatClient;
  let sharedSessionId: string;
  let userDelegation: string;
  const runTag = `sandbox-int-${Date.now()}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [new SandboxPlugin()],
    });
    await waitForMatrixLoaded(oracle);

    userDelegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });
    const delegation = userDelegation;

    // Seed UcanService so Tier A (which bypasses HTTP) can mint downstream
    // ixo:sandbox invocations from the same delegation Tier B would use.
    const parsed = await parseDelegation(delegation);
    const ucanService = oracle.app.getNestApp().get(UcanService);
    await ucanService.cacheDelegation(
      process.env.TEST_USER_DID!,
      delegation,
      typeof parsed.expiration === 'number' ? parsed.expiration : undefined,
    );

    runtime = await createIntegrationRuntime({
      plugins: [new SandboxPlugin()],
      user: { did: process.env.TEST_USER_DID! },
      delegation,
      capabilities: SANDBOX_CAPS,
      session: {
        id: `int-${runTag}`,
        client: 'portal',
        requestId: `int-req-${runTag}`,
        roomId: `!sandbox-${runTag}:test-host`,
      },
      ucan: oracle.app.ambient.ucan,
    });

    chatClient = new ChatClient(oracle.baseUrl, { delegation });
    sharedSessionId = await chatClient.createSession();
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
    await oracle?.close();
  });

  // ─── Tier A ───────────────────────────────────────────────────────────

  test('A1 — sandbox_run executes shell and returns success', async () => {
    const expected = `HELLO_${runTag}`;
    const result = await runtime.invokeTool('sandbox_run', {
      code: `echo ${expected}`,
    });
    const text = envelopeToString(result);
    // Manifest promise: "success === true AND exitCode === 0 before trusting
    // output". We assert the echoed token appears anywhere in the envelope —
    // proves stdout was captured and routed back through the MCP transport.
    expect(text).toContain(expected);
    expect(text.toLowerCase()).not.toContain('"success":false');
  }, 120_000);

  test('A2 — sandbox_write_file + sandbox_run round-trip', async () => {
    const path = `/workspace/data/output/roundtrip-${runTag}.txt`;
    const payload = `roundtrip body ${runTag}`;

    const write = await runtime.invokeTool('sandbox_write_file', {
      path,
      content: payload,
    });
    const writeText = envelopeToString(write);
    expect(writeText.toLowerCase()).not.toContain('"success":false');

    const read = await runtime.invokeTool('sandbox_run', {
      code: `cat ${path}`,
    });
    expect(envelopeToString(read)).toContain(payload);
  }, 180_000);

  test('A3 — oracle_* management tools are hidden by default', async () => {
    // The default plugin instance bundled in beforeAll has
    // `includeOracleManagementTools: false`. Asking the runtime to invoke
    // an oracle_* tool must surface the harness's "Tool ... not found"
    // error — proves the prefix filter is enforced before the agent sees
    // the upstream tool list.
    await expect(runtime.invokeTool('oracle_list', {})).rejects.toThrow(
      /Tool "oracle_list" not found/,
    );
  });

  test('A4 — includeOracleManagementTools: true re-enables oracle_* tools', async () => {
    // Spin up a SECOND runtime with the flag flipped on. The two runtimes
    // share an ambient (same UCAN, same upstream URL) so any difference
    // in tool visibility is exclusively attributable to the flag — not to
    // upstream availability or auth state.
    const adminRuntime = await createIntegrationRuntime({
      plugins: [new SandboxPlugin({ includeOracleManagementTools: true })],
      user: { did: process.env.TEST_USER_DID! },
      delegation: userDelegation,
      capabilities: SANDBOX_CAPS,
      ucan: oracle.app.ambient.ucan,
    });
    try {
      // We don't care whether the upstream call succeeds with `{}` — we
      // only care that the harness's "Tool not found" guard is no longer
      // tripped. Any other outcome (success, upstream validation error,
      // permission error) proves the tool is bound to the runtime.
      let error: unknown;
      try {
        await adminRuntime.invokeTool('oracle_list', {});
      } catch (err) {
        error = err;
      }
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toMatch(/Tool "oracle_list" not found/);
    } finally {
      await adminRuntime.close();
    }
  }, 120_000);

  test('A5 — load_skill downloads a public skill into /workspace/skills/', async () => {
    // Resolve a stable cid from the live public registry. Without a UCAN
    // header the registry returns public capsules only — exactly what we
    // want for a deterministic Tier A invocation.
    const skillsBaseUrl =
      process.env.SKILLS_CAPSULES_BASE_URL ?? 'https://capsules.skills.ixo.earth';
    const listRes = await fetch(`${skillsBaseUrl}/capsules?limit=1`);
    expect(
      listRes.ok,
      `skills registry list failed: ${listRes.status} ${listRes.statusText}`,
    ).toBe(true);
    const { capsules } = (await listRes.json()) as {
      capsules: Array<{ cid: string; name: string }>;
    };
    expect(
      capsules.length,
      'public skills registry returned no capsules — cannot exercise load_skill',
    ).toBeGreaterThan(0);
    const stableCid = capsules[0]!.cid;

    const result = await runtime.invokeTool('load_skill', { cid: stableCid });
    const text = envelopeToString(result);
    expect(text.toLowerCase()).not.toContain('"iserror":true');
    expect(text).toMatch(/"success"\s*:\s*true/);
    // The upstream returns the absolute paths of every file it extracted —
    // proves the skill bundle landed under /workspace/skills/.
    expect(text).toMatch(/\/workspace\/skills\//);
  }, 180_000);

  test('A6 — sandbox_write_file → artifact_get_presigned_url → URL serves the exact bytes back', async () => {
    // Write a tagged artifact, mint a presigned URL pair, then GET the
    // download URL and assert the body equals what we wrote. End-to-end
    // proof that the local-filesystem → R2 → presigned-URL path actually
    // returns the file — a URL that's shaped right but 404s on fetch
    // would otherwise slip past.
    const path = `/workspace/data/output/artifact-${runTag}.txt`;
    const payload = `artifact body ${runTag}`;

    const write = await runtime.invokeTool('sandbox_write_file', {
      path,
      content: payload,
    });
    expect(envelopeToString(write).toLowerCase()).not.toContain(
      '"success":false',
    );

    // Brief settle — `sandbox_write_file` returns once the local write
    // completes but R2 mirror is async. 2s is empirically enough on devnet.
    await new Promise((r) => setTimeout(r, 2_000));

    const urlResult = await runtime.invokeTool('artifact_get_presigned_url', {
      path,
    });
    const urlText = envelopeToString(urlResult);
    expect(urlText.toLowerCase()).not.toContain('"iserror":true');

    const previewMatch = urlText.match(/"previewUrl"\s*:\s*"([^"]+)"/);
    const downloadMatch = urlText.match(/"downloadUrl"\s*:\s*"([^"]+)"/);
    expect(
      previewMatch?.[1],
      `previewUrl missing from response: ${urlText.slice(0, 300)}`,
    ).toMatch(/^https?:\/\//);
    expect(
      downloadMatch?.[1],
      `downloadUrl missing from response: ${urlText.slice(0, 300)}`,
    ).toMatch(/^https?:\/\//);

    // The hard guarantee — fetching the URL returns the bytes we wrote.
    // Presigned URLs are unauthenticated by design (signature is in the
    // querystring), so a plain `fetch` is all we need.
    const downloadUrl = downloadMatch![1]!;
    const fetched = await fetch(downloadUrl);
    expect(
      fetched.status,
      `presigned download URL returned non-200: ${fetched.status} ${fetched.statusText}`,
    ).toBe(200);
    const body = await fetched.text();
    expect(
      body,
      `presigned URL body did not match the written payload\n  wrote: "${payload}"\n  got:   "${body.slice(0, 200)}"`,
    ).toBe(payload);
  }, 240_000);

  // ─── Tier B ───────────────────────────────────────────────────────────

  test('B1 — "run this in the sandbox" routes the agent to sandbox_run', async () => {
    const sentinel = `SANDBOX_B1_${runTag}`;
    const stream = chatClient.stream(
      sharedSessionId,
      `Run this exact shell command in the sandbox and tell me the output: echo ${sentinel}`,
    );

    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    const sandboxCalls = events.filter(
      (e): e is { event: 'tool_call'; data: SSEToolCallEventData } =>
        e.event === 'tool_call' && e.data.toolName === 'sandbox_run',
    );
    expect(
      sandboxCalls.length,
      `expected at least one sandbox_run call; saw events: ${events.map((e) => e.event).join(', ')}`,
    ).toBeGreaterThan(0);

    // The agent must forward the sentinel into the `code` arg — proves it
    // didn't paraphrase or invent the command. Any sandbox_run call whose
    // code contains the sentinel satisfies this.
    const codeArgs = sandboxCalls
      .map((c) => String((c.data.args as { code?: string }).code ?? ''))
      .join('\n');
    expect(codeArgs).toContain(sentinel);
  }, 180_000);
});
