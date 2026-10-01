/**
 * Concurrency stress test: N distinct users (separate DIDs → separate Durable
 * Objects) chat with the oracle at the same time, several rounds, including a
 * tool-calling round. Reports latency percentiles, error rate, and verifies
 * every answer is correct AND every user's transcript is intact afterwards.
 *
 *   pnpm test:stress                 # 10 users, 3 rounds
 *   USERS=20 ROUNDS=5 pnpm test:stress
 *   ORACLE_URL=http://127.0.0.1:8787 pnpm test:stress   # attach
 */
import assert from 'node:assert/strict';
import { ChatClient } from './lib/chat-client';
import { ensureAccounts, mintAuthInvocation } from './lib/harness';
import { ORACLE_DID, provisionDevVars, startOracle } from './lib/oracle';

const USERS = Number(process.env.USERS ?? 10);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

interface Sample {
  user: string;
  round: number;
  ms: number;
  ttfbMs: number;
  ok: boolean;
  error?: string;
  toolCalls: number;
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    ] ?? 0
  );
}

async function main(): Promise<void> {
  await provisionDevVars();
  const accounts = await ensureAccounts(USERS);
  const oracle = await startOracle();
  console.log(
    `oracle at ${oracle.url}; ${accounts.length} users × ${ROUNDS} rounds`,
  );
  const samples: Sample[] = [];
  try {
    const clients = await Promise.all(
      accounts.map(async (a) => ({
        account: a,
        client: new ChatClient(oracle.url, {
          invocation: await mintAuthInvocation(a, ORACLE_DID, 900),
        }),
      })),
    );

    // Warm-up: create sessions concurrently (10 DOs boot at once).
    const t0 = Date.now();
    const sessions = await Promise.all(
      clients.map(({ client }) => client.createSession()),
    );
    console.log(
      `created ${sessions.length} sessions concurrently in ${Date.now() - t0} ms`,
    );

    for (let round = 1; round <= ROUNDS; round++) {
      const roundStart = Date.now();
      await Promise.all(
        clients.map(async ({ account, client }, i) => {
          const sessionId = sessions[i] as string;
          const a = 10 + i;
          const b = 100 * round + i;
          const prompt =
            round === 2
              ? `Use your weather tool for the city "${['Berlin', 'Cape Town', 'Nairobi', 'Lagos', 'Lima', 'Oslo', 'Tokyo', 'Lusaka', 'Accra', 'Quito'][i % 10]}" and tell me the current temperature in °C.`
              : `What is ${a} + ${b}? Reply with only the number.`;
          const start = Date.now();
          let ttfb = 0;
          try {
            const r = await client.stream(sessionId, prompt, {
              onEvent: (e) => {
                if (!ttfb && e.event === 'message') ttfb = Date.now() - start;
              },
            });
            const toolCalls = r.events.filter(
              (e) => e.event === 'tool_call' && e.data.status === 'done',
            ).length;
            let ok =
              r.status === 200 &&
              r.events.at(-1)?.event === 'done' &&
              !r.events.some((e) => e.event === 'error');
            let error: string | undefined;
            if (ok && round !== 2 && !r.text.includes(String(a + b))) {
              ok = false;
              error = `wrong answer: "${r.text.slice(0, 80)}"`;
            }
            if (ok && round === 2 && toolCalls === 0) {
              ok = false;
              error = `no tool call: "${r.text.slice(0, 80)}"`;
            }
            if (!ok && !error)
              error = `status ${r.status}; events ${r.events.map((e) => e.event).join(',')}; ${r.text.slice(0, 120)}`;
            samples.push({
              user: account.name,
              round,
              ms: r.durationMs,
              ttfbMs: ttfb,
              ok,
              error,
              toolCalls,
            });
          } catch (err) {
            samples.push({
              user: account.name,
              round,
              ms: Date.now() - start,
              ttfbMs: ttfb,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              toolCalls: 0,
            });
          }
        }),
      );
      const rs = samples.filter((s) => s.round === round);
      const okCount = rs.filter((s) => s.ok).length;
      console.log(
        `round ${round}: ${okCount}/${rs.length} ok in ${Date.now() - roundStart} ms — p50 ${pct(
          rs.map((s) => s.ms),
          50,
        )} ms, p95 ${pct(
          rs.map((s) => s.ms),
          95,
        )} ms, ttfb p50 ${pct(rs.map((s) => s.ttfbMs).filter(Boolean), 50)} ms`,
      );
      for (const s of rs.filter((x) => !x.ok))
        console.log(`   ✘ ${s.user}: ${s.error}`);
    }

    // Every transcript must be intact and belong to the right user.
    const transcripts = await Promise.all(
      clients.map(({ client }, i) =>
        client.listMessages(sessions[i] as string),
      ),
    );
    transcripts.forEach((t, i) => {
      assert.ok(
        t.messages.length >= ROUNDS * 2,
        `${accounts[i]?.name}: transcript has ${t.messages.length} messages`,
      );
      assert.match(
        t.messages[0]?.content ?? '',
        new RegExp(`${10 + i} \\+ ${100 + i}`),
        `${accounts[i]?.name}: transcript mixed up`,
      );
    });
    console.log(
      `all ${transcripts.length} transcripts intact and isolated per user`,
    );
  } finally {
    await oracle.stop();
    const all = samples.map((s) => s.ms);
    const okAll = samples.filter((s) => s.ok).length;
    console.log('\n=== stress summary ===');
    console.log(
      `turns: ${samples.length}, ok: ${okAll}, errors: ${samples.length - okAll}`,
    );
    console.log(
      `latency p50 ${pct(all, 50)} ms · p95 ${pct(all, 95)} ms · max ${Math.max(0, ...all)} ms`,
    );
    if (okAll !== samples.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
