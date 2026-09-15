/**
 * Context budgets, end to end (docs/plans/context-budgets.md).
 *
 *   pnpm test:e2e:context                       # local harness (boots wrangler dev)
 *   STEP_FILTER='^cap' pnpm test:e2e:context    # a subset
 *
 * Against a DEPLOYED oracle (the devnet drill; the worker needs
 * `DRILL_TOOLS=true` and `ORACLE_DEBUG_ROUTES=true`):
 *
 *   ACCOUNT_JSON=test/.devnet-accounts/devnet-account.json \
 *   ORACLE_URL=https://mike-devnet-oracle.ixo-api.workers.dev \
 *   ORACLE_DID=did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3 pnpm test:e2e:context
 *
 * `CONTEXT_MODELS=a,b,c` names the models to drill; otherwise the deployment's
 * default model plus, from `GET /models`, two more whose windows differ.
 * `PRESSURE_MODEL=m` names the model for the pressure step (a model whose
 * window is pinned small by `MODEL_CONTEXT_OVERRIDES`; locally the default
 * model is pinned to 32k, the devnet oracle pins `google/gemini-3.1-flash-lite`;
 * the model must be in the runtime's catalog, `MODEL_CATALOG` in llm.ts).
 *
 * What it proves, per model: the window is resolved per model and every
 * threshold derives from it (`GET /debug/context`); a tool result above the
 * cap is truncated to head + tail, saved whole, and the model reads the
 * omitted middle back with `read_result`; a multi-megabyte result lands in
 * R2. On the pinned model it proves that old results are pruned under
 * pressure and that the history is summarized at the window fraction with
 * no message-count trigger — observed through the per-session counters of
 * `GET /debug/context?session=`, never the logs (wrangler dev does not
 * forward the worker's `console.log` lines to the harness, and a deployed
 * oracle has none to read).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChatClient, type SSEEvent } from './lib/chat-client';
import {
  STATIC_ACCOUNTS,
  mintAuthInvocation,
  mintDelegation,
  type HarnessAccount,
} from './lib/harness';
import { ORACLE_DID, provisionDevVars, startOracle } from './lib/oracle';

const ONLY = process.env.STEP_FILTER
  ? new RegExp(process.env.STEP_FILTER)
  : null;
const DEVNET_ACCOUNT_JSON = process.env.ACCOUNT_JSON;
/** Local runs pin a small window so summarization and pruning are reachable in minutes. */
const LOCAL_WINDOW = 32_000;
/** The pressure step needs a window this small to be reachable in a few turns. */
const PRESSURE_WINDOW_MAX = 64_000;
/** The default ceiling on the result cap (`CONTEXT_RESULT_CAP_MAX_CHARS`). */
const RESULT_CAP_MAX_CHARS = 200_000;
/** The model the devnet oracle pins (wrangler.devnet.jsonc `MODEL_CONTEXT_OVERRIDES`). */
const DEVNET_PRESSURE_MODEL = 'google/gemini-3.1-flash-lite';

interface DevnetAccount {
  did: string;
  address: string;
  edSigningMnemonic: string;
  matrixUserId: string;
  matrixPassword: string;
}

interface SessionContextStatus {
  id: string;
  threadMessages: number;
  contextMessages: number;
  contextSummaries: number;
  contextToolMessages: number;
  contextTokens: number;
  prunes: number;
  hardPrunes: number;
  prunedResults: number;
  overflowRetries: number;
  refusals: number;
  lastEventAt?: string;
}

interface ContextStatus {
  model: string;
  window: { tokens: number; origin: string; catalogId?: string };
  budget: {
    summarizeAtTokens: number;
    pruneAtTokens: number;
    resultCapChars: number;
    requestCapTokens: number;
    outputReserveTokens: number;
    keepMessages: number;
    summarizeTriggerMessages?: number;
  };
  results: {
    rows: number;
    sqliteBytes: number;
    r2Rows: number;
    r2Bytes: number;
    tier: string;
  };
  session?: SessionContextStatus | null;
}

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

const tag = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const toolFrames = (events: SSEEvent[], name: string) =>
  events.filter((e) => e.event === 'tool_call' && e.data.toolName === name);

async function main(): Promise<void> {
  const devnet = DEVNET_ACCOUNT_JSON
    ? (JSON.parse(readFileSync(DEVNET_ACCOUNT_JSON, 'utf8')) as DevnetAccount)
    : null;
  if (devnet && !process.env.ORACLE_URL)
    throw new Error('ORACLE_URL is required with ACCOUNT_JSON');
  if (devnet && !ORACLE_DID)
    throw new Error('ORACLE_DID is required with ACCOUNT_JSON');
  let localDefaultModel: string | undefined;
  if (!devnet) {
    const provisioned = await provisionDevVars({
      extra: { DRILL_TOOLS: 'true' },
    });
    // Pin the default model's window so the fraction-derived thresholds are
    // reachable in a few turns (32k → summarize at 16k tokens, cap 15,360 chars).
    localDefaultModel =
      provisioned.devVars.DEFAULT_MODEL || 'openai/gpt-5.6-luna';
    await provisionDevVars({
      extra: {
        DRILL_TOOLS: 'true',
        MODEL_CONTEXT_OVERRIDES: `${localDefaultModel}=${LOCAL_WINDOW}`,
      },
    });
  }
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);
  try {
    const alice: HarnessAccount = devnet
      ? {
          name: 'devnet-context',
          address: devnet.address,
          did: devnet.did,
          edSigningMnemonic: devnet.edSigningMnemonic,
          matrixUserId: devnet.matrixUserId,
          matrixPassword: devnet.matrixPassword,
          matrixMnemonic: '',
        }
      : (STATIC_ACCOUNTS[1] as HarnessAccount);
    const invocation = await mintAuthInvocation(alice, ORACLE_DID);
    const delegation = devnet
      ? null
      : await mintDelegation(alice, ORACLE_DID, [
          { can: 'memory/*', with: 'ixo:memory' },
        ]);
    const client = new ChatClient(
      oracle.url,
      delegation ? { invocation, delegation } : { invocation },
    );

    const contextStatus = async (
      model?: string,
      session?: string,
    ): Promise<ContextStatus> => {
      const query = new URLSearchParams();
      if (model) query.set('model', model);
      if (session) query.set('session', session);
      const qs = query.toString();
      const res = await fetch(
        `${oracle.url}/debug/context${qs ? `?${qs}` : ''}`,
        {
          headers: client.headers(),
        },
      );
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as ContextStatus;
    };
    const listedModels = async (): Promise<{
      ids: string[];
      default: string | null;
    }> => {
      const res = await fetch(`${oracle.url}/models`, {
        headers: client.headers(),
      });
      const body = (await res.json()) as {
        models: Array<{ id: string }>;
        default: string | null;
      };
      return { ids: body.models.map((m) => m.id), default: body.default };
    };

    // ---------------------------------------------------------------- models
    let models: string[] = [];
    await step(
      'models: pick the models to drill (the default plus windows that differ)',
      async () => {
        const listed = await listedModels();
        const configured = process.env.CONTEXT_MODELS?.split(',')
          .map((m) => m.trim())
          .filter(Boolean);
        if (configured?.length) {
          models = configured;
        } else {
          const fallback =
            listed.default ??
            localDefaultModel ??
            (await contextStatus()).model;
          models = [fallback];
          if (devnet) {
            // Up to two more models whose windows differ from the default's.
            const seen = new Set([
              (await contextStatus(fallback)).window.tokens,
            ]);
            for (const id of listed.ids
              .filter((m) => m !== fallback)
              .slice(0, 12)) {
              if (models.length >= 3) break;
              const w = (await contextStatus(id)).window.tokens;
              if (!seen.has(w)) {
                seen.add(w);
                models.push(id);
              }
            }
          }
        }
        console.log(`\n   models: ${models.join(', ')}`);
        assert.ok(models.length >= 1);
      },
    );

    // ---------------------------------------------------------------- budgets
    const budgets = new Map<string, ContextStatus>();
    await step(
      'budget: /debug/context resolves the window per model and derives every threshold from it',
      async () => {
        for (const model of models) {
          const status = await contextStatus(model);
          budgets.set(model, status);
          const w = status.window.tokens;
          console.log(
            `\n   ${model}: window=${w} (${status.window.origin}${status.window.catalogId ? ` ${status.window.catalogId}` : ''}) cap=${status.budget.resultCapChars}c summarizeAt=${status.budget.summarizeAtTokens} pruneAt=${status.budget.pruneAtTokens} requestCap=${status.budget.requestCapTokens}`,
          );
          assert.ok(w >= 16_000, `window ${w}`);
          assert.ok(
            ['override', 'catalog', 'learned', 'default'].includes(
              status.window.origin,
            ),
          );
          if (devnet)
            assert.ok(
              status.window.origin === 'catalog' ||
                status.window.origin === 'override',
              `devnet must resolve ${model} from the catalog (or a pin): got ${status.window.origin}`,
            );
          const reserve = Math.min(8_000, Math.floor(w / 4));
          assert.equal(status.budget.outputReserveTokens, reserve);
          assert.equal(
            status.budget.requestCapTokens,
            Math.floor(w * 0.95) - reserve,
          );
          assert.equal(
            status.budget.summarizeAtTokens,
            Math.min(Math.floor(w * 0.5), status.budget.requestCapTokens),
          );
          assert.equal(
            status.budget.pruneAtTokens,
            Math.min(Math.floor(w * 0.35), status.budget.summarizeAtTokens),
          );
          assert.equal(
            status.budget.resultCapChars,
            Math.min(Math.floor(w * 0.12) * 4, RESULT_CAP_MAX_CHARS),
          );
          assert.equal(
            status.budget.summarizeTriggerMessages,
            undefined,
            'no message trigger by default',
          );
        }
        if (models.length > 1) {
          const windows = new Set(
            [...budgets.values()].map((b) => b.window.tokens),
          );
          assert.ok(
            windows.size > 1,
            'the drilled models should not all share one window',
          );
        }
        if (devnet)
          assert.ok(
            [...budgets.values()].some((b) => b.window.origin === 'catalog'),
            'no drilled model resolved its window from the OpenRouter catalog',
          );
      },
    );

    // ---------------------------------------------------------------- cap + read back, per model
    for (const model of models) {
      await step(
        `cap [${model}]: a result above the cap is truncated, saved whole, and the model reads the middle back`,
        async () => {
          const budget = budgets.get(model) ?? (await contextStatus(model));
          const cap = budget.budget.resultCapChars;
          // 1.5 × the cap: the visible head (40 %) ends at 0.4 × cap and the
          // visible tail (60 %) starts at 0.9 × cap, so the middle marker at
          // 0.75 × cap is inside the cut whatever the cap is.
          const chars = Math.min(Math.ceil(cap * 1.5), 3_000_000);
          const marker = `MK-${tag()}`;
          const sid = await client.createSession();
          const before = (await contextStatus(model)).results.rows;
          const r = await client.stream(
            sid,
            `Call the tool drill_big_result with chars ${chars} and marker "${marker}". Its result will be truncated in the middle and saved; the line "MIDDLE-MARKER: <value>" is at about the middle of the full result (around byte ${Math.floor(chars / 2)}). Use read_result with the saved id and an offset near that point until you see the MIDDLE-MARKER line, then reply with exactly the value after "MIDDLE-MARKER: " and nothing else.`,
            { body: { model } },
          );
          assert.equal(r.status, 200, r.text);
          const big = toolFrames(r.events, 'drill_big_result').filter(
            (e) => e.data.status === 'done',
          );
          assert.ok(
            big.length >= 1,
            `drill_big_result never finished: ${r.text.slice(0, 200)}`,
          );
          const shown = String(big[0]!.data.output ?? '');
          assert.ok(
            shown.includes('[Result truncated'),
            `result not capped: ${shown.slice(0, 120)}`,
          );
          assert.ok(
            /saved as [a-f0-9]{64}/.test(shown),
            'no saved-result handle in the footer',
          );
          assert.ok(
            shown.length <= cap + 400,
            `visible result ${shown.length} chars exceeds the cap ${cap}`,
          );
          assert.ok(
            !shown.includes(`MIDDLE-MARKER: ${marker}`),
            'the middle should have been cut out',
          );
          const reads = toolFrames(r.events, 'read_result').filter(
            (e) => e.data.status === 'done',
          );
          assert.ok(reads.length >= 1, 'the model never called read_result');
          assert.ok(
            r.text.includes(marker),
            `the reply does not carry the marker: ${r.text.slice(0, 200)}`,
          );
          const after = await contextStatus(model);
          assert.ok(
            after.results.rows >= before + 1,
            'the result was not saved',
          );
          assert.ok(
            after.results.sqliteBytes >= chars,
            'the saved result is not in the SQLite tier',
          );
          console.log(
            `\n   ${model}: visible ${shown.length}/${chars} chars, ${reads.length} read_result call(s), reply "${r.text.trim().slice(0, 40)}"`,
          );
        },
      );
    }

    // ---------------------------------------------------------------- R2 tier
    await step(
      'r2: a multi-megabyte result is saved in the bucket, not the hot store',
      async () => {
        const model = models[0]!;
        const status = await contextStatus(model);
        if (status.results.tier !== 'sqlite+r2') {
          console.log('\n   (no bucket bound on this deployment — skipped)');
          return;
        }
        const chars = 1_300_000;
        const marker = `R2-${tag()}`;
        const sid = await client.createSession();
        const r = await client.stream(
          sid,
          `Call the tool drill_big_result with chars ${chars} and marker "${marker}", then reply with exactly the value after "END-MARKER: " that you can see in the visible tail of the result.`,
          { body: { model } },
        );
        assert.equal(r.status, 200, r.text);
        const big = toolFrames(r.events, 'drill_big_result').filter(
          (e) => e.data.status === 'done',
        );
        assert.ok(big.length >= 1, 'drill_big_result never finished');
        assert.ok(
          String(big[0]!.data.output).includes('[Result truncated'),
          'not capped',
        );
        const after = await contextStatus(model);
        assert.ok(
          after.results.r2Rows >= 1,
          `no R2 row: ${JSON.stringify(after.results)}`,
        );
        assert.ok(
          after.results.r2Bytes >= chars,
          'the R2 row is smaller than the result',
        );
        assert.ok(
          r.text.includes(marker),
          `reply without the end marker: ${r.text.slice(0, 120)}`,
        );
      },
    );

    // ---------------------------------------------------------------- pressure + summarization (pinned window)
    await step(
      'pressure: on the pinned window old results are pruned before the history is condensed at the window fraction, with no message trigger',
      async () => {
        const model =
          process.env.PRESSURE_MODEL ??
          (devnet ? DEVNET_PRESSURE_MODEL : models[0]!);
        const budget = await contextStatus(model);
        const window = budget.window.tokens;
        assert.ok(
          window <= PRESSURE_WINDOW_MAX,
          `${model} has a ${window}-token window; the pressure step needs one ≤ ${PRESSURE_WINDOW_MAX} — pin it with MODEL_CONTEXT_OVERRIDES=${model}=${LOCAL_WINDOW} or name a pinned model with PRESSURE_MODEL`,
        );
        assert.equal(
          budget.window.origin,
          'override',
          'the pressure model should be pinned',
        );
        assert.equal(
          budget.budget.summarizeTriggerMessages,
          undefined,
          'no message trigger',
        );
        const sid = await client.createSession();
        const before = await contextStatus(model, sid);
        assert.ok(
          before.session,
          'the new session is unknown to /debug/context',
        );
        assert.equal(before.session.contextSummaries, 0);
        assert.equal(before.session.prunes, 0);

        // Each turn adds a result of ~85% of the cap (under it, so nothing is
        // truncated) ≈ 0.1 × window tokens: the summarize threshold (0.5 ×
        // window) is crossed within about five turns; the request passes the
        // prune threshold (0.35 × window, system prompt and schemas included)
        // earlier, and only results outside the kept tail are demoted.
        const resultChars = Math.floor(budget.budget.resultCapChars * 0.85);
        const maxTurns = 9;
        let turns = 0;
        let session: SessionContextStatus | null = null;
        let firstPruneTurn: number | null = null;
        for (let i = 1; i <= maxTurns; i += 1) {
          turns = i;
          const r = await client.stream(
            sid,
            `Call drill_big_result with chars ${resultChars} and marker "S${i}", then reply with exactly: OK ${i}`,
            { body: { model } },
          );
          assert.equal(r.status, 200, r.text);
          assert.ok(
            !/Error generating summary/i.test(r.text),
            'a failed summary leaked into the reply',
          );
          session = (await contextStatus(model, sid)).session ?? null;
          assert.ok(session, 'the session vanished from /debug/context');
          if (firstPruneTurn === null && session.prunes > 0) firstPruneTurn = i;
          console.log(
            `\n   turn ${i}: context ${session.contextMessages} msgs ≈ ${session.contextTokens} tokens (transcript ${session.threadMessages}), prunes ${session.prunes} (${session.prunedResults} results), summaries ${session.contextSummaries}`,
          );
          if (session.contextSummaries > 0) break;
        }
        assert.ok(session, 'no session status');
        assert.ok(
          session.contextSummaries >= 1,
          `no summarization over ${turns} turns (context ≈ ${session.contextTokens} tokens, summarizeAt ${budget.budget.summarizeAtTokens})`,
        );
        assert.ok(
          session.contextTokens < budget.budget.summarizeAtTokens,
          `the condensed context (≈ ${session.contextTokens} tokens) should sit under the summarize threshold ${budget.budget.summarizeAtTokens}`,
        );
        assert.ok(
          session.contextMessages <= budget.budget.keepMessages + 2,
          `the working context should be a summary plus the kept tail, not ${session.contextMessages} messages`,
        );
        // The transcript is never condensed: every turn's rows are still there.
        assert.ok(
          session.threadMessages >= turns * 4,
          `the transcript lost rows: ${session.threadMessages} for ${turns} turns`,
        );
        assert.ok(
          firstPruneTurn !== null && firstPruneTurn <= turns,
          'old results were never pruned under pressure before the summary',
        );
        assert.equal(session.refusals, 0, 'a request was refused');
        assert.equal(
          session.overflowRetries,
          0,
          'the provider rejected a request the guard let through',
        );
        console.log(
          `\n   summarized after ${turns} turns; first prune at turn ${firstPruneTurn}; ${session.prunedResults} result(s) demoted in total`,
        );
        // The session still works after the summary and the drill tool is still callable.
        const after = await client.stream(
          sid,
          'Reply with exactly: STILL HERE',
          { body: { model } },
        );
        assert.equal(after.status, 200, after.text);
        assert.match(after.text, /STILL HERE/);
        // Deleting the session drops its counters and saved results.
        const del = await fetch(`${oracle.url}/sessions/${sid}`, {
          method: 'DELETE',
          headers: client.headers(),
        });
        assert.ok(del.ok, `delete: ${del.status}`);
        assert.equal(
          (await contextStatus(model, sid)).session,
          null,
          'the deleted session still reports counters',
        );
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
