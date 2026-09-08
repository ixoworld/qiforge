/**
 * Comparative load test — attach-mode, so the SAME phases run against any
 * oracle speaking the wire protocol (this Workers runtime, or the Node
 * runtime):
 *
 *   ORACLE_URL=http://127.0.0.1:8787 ORACLE_DID=did:ixo:... LABEL=workers \
 *     USERS=20 pnpm exec tsx test/stress-compare.ts
 *
 * Phases (each step runs all users CONCURRENTLY, barrier between steps):
 *   S  create sessions
 *   A1 unique arithmetic per user (real LLM turn, answer asserted)
 *   A2 thread-memory recall of A1 (same session)
 *   B1 store a unique fact via the memory-engine MCP tool (mock server
 *      records the actual tools/call — storage is asserted at the wire)
 *   B2 same-session recall via the memory search tool
 *   B3 NEW-session recall — empty transcript, so the value can only come
 *      back over the MCP wire
 *
 * The mock memory engine (test/lib/mock-mcp-main.ts) must be running and the
 * target oracle must have MEMORY_MCP_URL pointed at it. Per-turn totals +
 * TTFB are collected; the summary prints p50/p95/max per step and writes a
 * JSON report for cross-run comparison.
 */
import { writeFileSync } from 'node:fs';
import { ChatClient } from './lib/chat-client';
import {
  ensureAccounts,
  mintAuthInvocation,
  mintDelegation,
} from './lib/harness';

const ORACLE_URL = process.env.ORACLE_URL ?? 'http://127.0.0.1:8787';
const ORACLE_DID = process.env.ORACLE_DID ?? '';
const USERS = Number(process.env.USERS ?? 20);
const MOCK_URL = process.env.MOCK_URL ?? 'http://localhost:34675';
const LABEL = process.env.LABEL ?? 'workers';
const OUT =
  process.env.OUT ??
  `/private/tmp/claude-501/-Users-michael-dev-ixo/95c7d059-eb21-4ef9-87f0-ccd4b0de3687/scratchpad/stress-compare-${LABEL}.json`;

if (!ORACLE_DID) throw new Error('ORACLE_DID is required');

const TOPICS = [
  'sea',
  'planet',
  'mountain',
  'river',
  'bird',
  'tree',
  'metal',
  'gem',
  'cheese',
  'pasta',
  'spice',
  'cloud',
  'desert',
  'island',
  'bridge',
  'constellation',
  'volcano',
  'forest',
  'lake',
  'canyon',
  'glacier',
  'lighthouse',
  'orchid',
  'beetle',
  'comet',
] as const;

interface Turn {
  user: number;
  step: string;
  ms: number;
  ttfbMs: number | null;
  ok: boolean;
  detail?: string;
}

interface StepStat {
  step: string;
  ok: number;
  failed: number;
  wallMs: number;
  p50: number;
  p95: number;
  max: number;
  ttfbP50: number | null;
}

const turns: Turn[] = [];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;
}

interface UserCtx {
  i: number;
  client: ChatClient;
  sessionId?: string;
  freshSessionId?: string;
  sum: number;
  topic: string;
  value: string;
  /** TTFB of the most recent turn (set by `turn`, read by `step`). */
  lastTtfb?: number | undefined;
}

/** Run `fn` for every user concurrently; record per-turn timing + outcome. */
async function step(
  name: string,
  users: UserCtx[],
  fn: (u: UserCtx) => Promise<void>,
): Promise<StepStat> {
  const wallStart = Date.now();
  await Promise.all(
    users.map(async (u) => {
      const start = Date.now();
      try {
        await fn(u);
        turns.push({
          user: u.i,
          step: name,
          ms: Date.now() - start,
          ttfbMs: u.lastTtfb ?? null,
          ok: true,
        });
      } catch (err) {
        turns.push({
          user: u.i,
          step: name,
          ms: Date.now() - start,
          ttfbMs: u.lastTtfb ?? null,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  const wallMs = Date.now() - wallStart;
  const mine = turns.filter((t) => t.step === name);
  const times = mine
    .filter((t) => t.ok)
    .map((t) => t.ms)
    .sort((a, b) => a - b);
  const ttfbs = mine
    .map((t) => t.ttfbMs)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const stat: StepStat = {
    step: name,
    ok: times.length,
    failed: mine.length - times.length,
    wallMs,
    p50: pct(times, 50),
    p95: pct(times, 95),
    max: times.at(-1) ?? 0,
    ttfbP50: ttfbs.length > 0 ? pct(ttfbs, 50) : null,
  };
  console.log(
    `${name}: ${stat.ok}/${mine.length} ok, wall ${wallMs} ms, p50 ${stat.p50} ms, p95 ${stat.p95} ms, max ${stat.max} ms${stat.ttfbP50 !== null ? `, ttfb p50 ${stat.ttfbP50} ms` : ''}`,
  );
  for (const t of mine.filter((t) => !t.ok))
    console.log(`   ✘ user ${t.user}: ${t.detail}`);
  return stat;
}

/** Stream a turn, capture TTFB on the user ctx, assert a pattern. */
async function turn(
  u: UserCtx,
  sessionId: string,
  message: string,
  expect: RegExp,
): Promise<void> {
  const start = Date.now();
  u.lastTtfb = undefined;
  const r = await u.client.stream(sessionId, message, {
    onEvent: (e) => {
      if (u.lastTtfb === undefined && e.event === 'message')
        u.lastTtfb = Date.now() - start;
    },
  });
  if (r.status !== 200)
    throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  if (r.events.at(-1)?.event !== 'done')
    throw new Error(`stream ended without done (${r.events.at(-1)?.event})`);
  if (!expect.test(r.text))
    throw new Error(`expected ${expect} in "${r.text.slice(0, 200)}"`);
}

interface MockState {
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  memories: string[];
}

async function mockState(): Promise<MockState> {
  const res = await fetch(`${MOCK_URL}/__test/state`);
  if (!res.ok) throw new Error(`mock state ${res.status}`);
  return (await res.json()) as MockState;
}

async function main(): Promise<void> {
  console.log(
    `target=${LABEL} url=${ORACLE_URL} oracle=${ORACLE_DID} users=${USERS}`,
  );
  const health = await fetch(`${ORACLE_URL}/health`);
  if (!health.ok) throw new Error(`oracle /health ${health.status}`);
  await fetch(`${MOCK_URL}/__test/reset`, { method: 'POST' });

  const accounts = await ensureAccounts(USERS);
  const users: UserCtx[] = await Promise.all(
    accounts.slice(0, USERS).map(async (account, i) => {
      const invocation = await mintAuthInvocation(account, ORACLE_DID);
      const delegation = await mintDelegation(account, ORACLE_DID, [
        { can: 'memory/*', with: 'ixo:memory' },
      ]);
      return {
        i,
        client: new ChatClient(ORACLE_URL, { invocation, delegation }),
        sum: 17 + 3 * i,
        topic: TOPICS[i % TOPICS.length]!,
        value: `zephyr${i}quartz`,
      };
    }),
  );

  const stats: StepStat[] = [];
  const totalStart = Date.now();

  stats.push(
    await step('S  create-session', users, async (u) => {
      u.sessionId = await u.client.createSession();
    }),
  );
  stats.push(
    await step('A1 arithmetic', users, (u) =>
      turn(
        u,
        u.sessionId!,
        `What is ${u.sum - 5} + 5? Reply with only the number.`,
        new RegExp(String(u.sum)),
      ),
    ),
  );
  stats.push(
    await step('A2 thread-recall', users, (u) =>
      turn(
        u,
        u.sessionId!,
        'What was the sum I just asked you to compute? Reply with only the number.',
        new RegExp(String(u.sum)),
      ),
    ),
  );
  stats.push(
    await step('B1 memory-store', users, (u) =>
      turn(
        u,
        u.sessionId!,
        `Store this fact in your long-term memory using your memory add tool: "My favourite ${u.topic} is ${u.value}." After the memory tool reports success, reply with exactly: SAVED`,
        /SAVED/i,
      ),
    ),
  );

  // Wire-level assertion: every user's fact reached the MCP server.
  const state = await mockState();
  const adds = state.toolCalls.filter((c) => c.tool === 'add_memory');
  const missing = users.filter(
    (u) => !adds.some((c) => String(c.args.content ?? '').includes(u.value)),
  );
  console.log(
    `mock: ${adds.length} add_memory calls, ${state.memories.length} stored; ${missing.length} users missing`,
  );
  for (const u of missing)
    console.log(`   ✘ user ${u.i}: "${u.value}" never stored via MCP`);

  stats.push(
    await step('B2 same-session-recall', users, (u) =>
      turn(
        u,
        u.sessionId!,
        `Using your memory search tool, what is my favourite ${u.topic}? Reply with just the value.`,
        new RegExp(u.value, 'i'),
      ),
    ),
  );
  stats.push(
    await step('B3 fresh-session-recall', users, async (u) => {
      u.freshSessionId = await u.client.createSession();
      await turn(
        u,
        u.freshSessionId,
        `Search your long-term memory with your memory search tool: what is my favourite ${u.topic}? Reply with just the value.`,
        new RegExp(u.value, 'i'),
      );
    }),
  );

  const totalMs = Date.now() - totalStart;
  const failures = turns.filter((t) => !t.ok).length;
  console.log(
    `\n=== ${LABEL}: ${turns.length} turns, ${failures} failed, total wall ${(totalMs / 1000).toFixed(1)} s ===`,
  );
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        label: LABEL,
        oracleUrl: ORACLE_URL,
        users: USERS,
        totalMs,
        failures,
        mcpAddsMissing: missing.length,
        stats,
        turns,
      },
      null,
      2,
    ),
  );
  console.log(`report: ${OUT}`);
  if (failures > 0 || missing.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
