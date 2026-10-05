/**
 * The POD Creator plugin against the local ixo harness with the real model.
 *
 *   pnpm test:e2e:pod                          # boots wrangler dev itself
 *   STEP_FILTER='^design' pnpm test:e2e:pod    # a subset
 *
 * What it proves: the on-demand `pod-creator` capability loads through the
 * capability gate; `start_pod_design` opens a blueprint; the stage-gated
 * qualify specialist (`call_service_intent_scorer_agent`) runs as a
 * sub-agent and records its section; the blueprint — kept in the user's own
 * database through `ctx.kv`, not in plugin memory — is still there after the
 * user object is reset (`/debug/object/abort`) and after the working copy is
 * wiped and re-imported from the owner copy (`/debug/storage/reset`); and the
 * create path refuses to prepare a transaction before the launch gate passes.
 * Nothing is signed or broadcast: the example oracle has no chain gateway.
 */
import assert from 'node:assert/strict';
import { ChatClient, type SSEEvent } from './lib/chat-client';
import {
  STATIC_ACCOUNTS,
  matrixLogin,
  mintAuthInvocation,
  mintDelegation,
  type HarnessAccount,
} from './lib/harness';
import {
  ensureUserOracleRoom,
  grantPowerLevel,
  waitForMember,
} from './lib/matrix-room';
import {
  BOT_USER_ID,
  ORACLE_DID,
  provisionDevVars,
  startOracle,
  waitForMatrixGateway,
} from './lib/oracle';

/** Below the runtime's 900 s cap, like the other drills. */
const AUTH_TTL_SEC = 840;
/**
 * Re-mint once less than this is left: one step (a model turn that may run a
 * specialist sub-agent, plus a blueprint read) must finish on one token.
 */
const AUTH_REFRESH_MARGIN_SEC = 300;

const ONLY = process.env.STEP_FILTER
  ? new RegExp(process.env.STEP_FILTER)
  : null;

const results: Array<{
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}> = [];

async function step<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (ONLY && !ONLY.test(name)) {
    console.log(`▷ ${name} … skipped (STEP_FILTER)`);
    return undefined;
  }
  const start = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`ok (${Date.now() - start} ms)`);
    return out;
  } catch (err) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    });
    console.log(`FAILED (${Date.now() - start} ms)`);
    console.log(`   ${err instanceof Error ? err.stack : String(err)}`);
    return undefined;
  }
}

/** The finished `tool_call` frames of one tool. */
const doneCalls = (events: SSEEvent[], toolName: string): SSEEvent[] =>
  events.filter(
    (e) =>
      e.event === 'tool_call' &&
      e.data.toolName === toolName &&
      e.data.status === 'done',
  );

const outputOf = (e: SSEEvent | undefined): string =>
  typeof e?.data.output === 'string'
    ? e.data.output
    : JSON.stringify(e?.data.output ?? '');

async function main(): Promise<void> {
  await provisionDevVars();
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);
  try {
    const alice: HarnessAccount | undefined = STATIC_ACCOUNTS[1];
    if (!alice) throw new Error('the harness has no second static account');
    const delegation = await mintDelegation(alice, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
    ]);
    // Auth invocations are capped at UCAN_AUTH_MAX_TTL_SECONDS (900 s by
    // default); the drill can outlast one, so it re-mints when near expiry.
    const mintClient = async (): Promise<ChatClient> =>
      new ChatClient(oracle.url, {
        invocation: await mintAuthInvocation(alice, ORACLE_DID, AUTH_TTL_SEC),
        delegation,
      });
    let client = await mintClient();
    let authMintedAt = Date.now();
    /** Swap in a freshly minted client when the current token is near expiry. */
    const refreshAuth = async (): Promise<void> => {
      if (
        Date.now() - authMintedAt <
        (AUTH_TTL_SEC - AUTH_REFRESH_MARGIN_SEC) * 1000
      )
        return;
      client = await mintClient();
      authMintedAt = Date.now();
    };
    const brief = `Community solar monitoring co-op ${Math.random()
      .toString(36)
      .slice(2, 7)
      .toUpperCase()}`;
    const sessionId = await client.createSession();

    /** One turn that must call `get_blueprint`; returns the tool's output. */
    const readBlueprint = async (): Promise<string> => {
      await refreshAuth();
      const r = await client.stream(
        sessionId,
        'Call get_blueprint (no roles) and tell me the current stage. Do not call any other tool.',
      );
      assert.equal(r.status, 200, r.text);
      const call = doneCalls(r.events, 'get_blueprint').at(-1);
      assert.ok(
        call,
        `get_blueprint was not called: ${JSON.stringify(r.events.filter((e) => e.event === 'tool_call'))}`,
      );
      return outputOf(call);
    };
    const assertDesignKept = (output: string): void => {
      assert.match(output, /"started":\s*true/, output);
      assert.ok(output.includes(brief), `brief lost: ${output}`);
      assert.match(output, /service_intent_scorer/, output);
      assert.match(output, /"stage":\s*"architect"/, output);
    };

    await step(
      'design: the capability loads and start_pod_design opens the blueprint',
      async () => {
        await refreshAuth();
        const r = await client.stream(
          sessionId,
          `I want to create a POD. Load the pod-creator capability, then call start_pod_design with the brief "${brief}". Stop after that.`,
        );
        assert.equal(r.status, 200, r.text);
        const loaded = doneCalls(r.events, 'load_capability');
        assert.ok(loaded.length > 0, 'load_capability was not called');
        const started = doneCalls(r.events, 'start_pod_design').at(-1);
        assert.ok(started, 'start_pod_design was not called');
        const output = outputOf(started);
        assert.match(output, /"stage":\s*"qualify"/, output);
        assert.match(output, /call_service_intent_scorer_agent/, output);
      },
    );

    await step(
      'design: the qualify specialist runs as a sub-agent and records its section',
      async () => {
        await refreshAuth();
        const r = await client.stream(
          sessionId,
          'Now call the call_service_intent_scorer_agent specialist to qualify this POD. It must record its section with submit_section. Do not call any other specialist.',
        );
        assert.equal(r.status, 200, r.text);
        assert.ok(
          doneCalls(r.events, 'call_service_intent_scorer_agent').length > 0,
          'the qualify specialist was not called',
        );
        assertDesignKept(await readBlueprint());
      },
    );

    await step(
      'reset: the blueprint survives the user object being reset',
      async () => {
        await refreshAuth();
        const res = await fetch(`${oracle.url}/debug/object/abort`, {
          method: 'POST',
          headers: client.headers(),
        });
        assert.equal(res.status, 200, await res.text());
        assertDesignKept(await readBlueprint());
      },
    );

    await step(
      'reset: the blueprint survives a working-copy wipe + owner-copy re-import',
      async () => {
        await refreshAuth();
        // The legacy owner store of the local harness is the user's room.
        const session = await matrixLogin(
          alice.matrixUserId,
          alice.matrixPassword,
        );
        const roomId = await ensureUserOracleRoom({
          session,
          userDid: alice.did,
          oracleDid: ORACLE_DID,
          botUserId: BOT_USER_ID,
          roomName: 'alice ↔ QiForge Workers (pod-creator)',
        });
        await waitForMatrixGateway(oracle.url);
        await waitForMember(session, roomId, BOT_USER_ID);
        await grantPowerLevel(session, roomId, BOT_USER_ID, 50);

        const flush = await fetch(`${oracle.url}/debug/storage/flush`, {
          method: 'POST',
          headers: client.headers(),
        });
        const flushed = (await flush.json()) as { uploaded: boolean };
        assert.equal(flush.status, 200, JSON.stringify(flushed));
        assert.ok(flushed.uploaded, JSON.stringify(flushed));

        const reset = await fetch(`${oracle.url}/debug/storage/reset`, {
          method: 'POST',
          headers: client.headers(),
        });
        const body = (await reset.json()) as {
          reloadedFromOwnerStore: boolean;
        };
        assert.equal(reset.status, 200, JSON.stringify(body));
        assert.equal(body.reloadedFromOwnerStore, true, JSON.stringify(body));
        assertDesignKept(await readBlueprint());
      },
    );

    await step(
      'create: prepare_pod_transaction refuses before the launch gate passes',
      async () => {
        await refreshAuth();
        const r = await client.stream(
          sessionId,
          'Call prepare_pod_transaction now and report exactly what it returned. Do not call any other tool.',
        );
        assert.equal(r.status, 200, r.text);
        const call = doneCalls(r.events, 'prepare_pod_transaction').at(-1);
        assert.ok(call, 'prepare_pod_transaction was not called');
        const output = outputOf(call);
        assert.match(output, /"prepared":\s*false/, output);
        assert.match(output, /Launch-readiness gate not passed/, output);
      },
    );
  } finally {
    await oracle.stop();
  }

  console.log('\nResults:');
  for (const r of results)
    console.log(
      `  ${r.ok ? '✔' : '✖'} ${r.name} (${r.ms} ms)${r.detail ? ` — ${r.detail}` : ''}`,
    );
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
