/**
 * Durable runs, end to end against the local harness (docs/plans/durable-runs.md).
 *
 *   pnpm test:e2e:durable                                  # boots wrangler dev itself
 *   ORACLE_URL=http://127.0.0.1:8787 pnpm test:e2e:durable # attach to a running one
 *   STEP_FILTER='^reset' pnpm test:e2e:durable             # a subset of the steps
 *
 * Against a DEPLOYED oracle (the devnet drill — the worker must run with
 * `DRILL_TOOLS=true` and `ORACLE_DEBUG_ROUTES=true`; the account JSON is the
 * one `test/devnet-features.ts` uses; the recovery knobs must match the
 * deployment, here the defaults):
 *
 *   ACCOUNT_JSON=test/.devnet-accounts/devnet-account.json \
 *   ORACLE_URL=https://mike-devnet-oracle.ixo-api.workers.dev \
 *   ORACLE_DID=did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3 \
 *   RECOVERY_ATTEMPTS=4 RECOVERY_DELAYS_MS=5000,15000,30000,60000 pnpm test:e2e:durable
 *
 * The oracle is booted with the drill plugin (`src/drill-plugin.ts`) and
 * short recovery delays. Every step drives a real LLM turn and then does
 * something unkind to it: drops the connection, re-joins with a cursor,
 * resets the user object mid-reply or mid-tool (`POST /debug/object/abort`
 * — `ctx.abort()`, a real reset), supersedes it, queues behind it, or resets
 * it until the recovery cap. Locally a recorder counts how many times the
 * drill tools actually ran; against a deployment (which cannot reach the
 * recorder) the count comes from the runtime's own tool marks, whose
 * agreement with the recorder the local run proves.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChatClient, type SSEEvent } from './lib/chat-client';
import { startDrillRecorder } from './lib/drill-recorder';
import {
  APPSERVICE_BOT,
  MATRIX_BASE_URL,
  MATRIX_SERVER_NAME,
  STATIC_ACCOUNTS,
  appserviceRequest,
  matrixLogin,
  matrixRequest,
  mintAuthInvocation,
  mintDelegation,
  waitFor,
  type HarnessAccount,
} from './lib/harness';
import {
  BOT_USER_ID,
  ORACLE_DID,
  provisionDevVars,
  startOracle,
  waitForMatrixGateway,
} from './lib/oracle';

function didToAliasPart(did: string): string {
  return did.replace(/:/g, '-');
}

/**
 * The user↔oracle room a production signup creates (the rooms appservice
 * owns `#did-ixo-*` aliases): alice creates it, the appservice bot joins and
 * publishes the alias, the oracle bot auto-joins and gets PL 50. The room
 * mirror and the task delivery need it.
 */
async function ensureOracleRoom(
  oracleUrl: string,
  alice: HarnessAccount,
): Promise<string> {
  const session = await matrixLogin(alice.matrixUserId, alice.matrixPassword);
  const aliasLocal = `${didToAliasPart(alice.did)}_${didToAliasPart(ORACLE_DID)}`;
  const alias = `#${aliasLocal}:${MATRIX_SERVER_NAME}`;
  let roomId: string;
  const existing = await fetch(
    `${MATRIX_BASE_URL}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
  );
  if (existing.ok) {
    roomId = ((await existing.json()) as { room_id: string }).room_id;
    await matrixRequest(
      session,
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { user_id: BOT_USER_ID },
    ).catch(() => undefined);
  } else {
    const created = await matrixRequest<{ room_id: string }>(
      session,
      'POST',
      '/_matrix/client/v3/createRoom',
      {
        preset: 'private_chat',
        name: 'alice ↔ QiForge Workers (durable)',
        invite: [BOT_USER_ID, APPSERVICE_BOT],
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      },
    );
    roomId = created.room_id;
    await appserviceRequest(
      'POST',
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      {},
    );
    await appserviceRequest(
      'PUT',
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { room_id: roomId },
    );
    await matrixRequest(
      session,
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.canonical_alias`,
      { alias },
    );
  }
  await waitForMatrixGateway(oracleUrl);
  await waitFor(
    async () => {
      const members = await matrixRequest<{ joined: Record<string, unknown> }>(
        session,
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      );
      return BOT_USER_ID in members.joined;
    },
    60_000,
    'bot join',
  );
  const pl = await matrixRequest<{ users?: Record<string, number> }>(
    session,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
  );
  if ((pl.users?.[BOT_USER_ID] ?? 0) < 50) {
    await matrixRequest(
      session,
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
      { ...pl, users: { ...(pl.users ?? {}), [BOT_USER_ID]: 50 } },
    );
  }
  return roomId;
}

const ONLY = process.env.STEP_FILTER
  ? new RegExp(process.env.STEP_FILTER)
  : null;
const RECOVERY_ATTEMPTS = Number(process.env.RECOVERY_ATTEMPTS ?? 2);
const RECOVERY_DELAYS_MS = (process.env.RECOVERY_DELAYS_MS ?? '2000,3000')
  .split(',')
  .map((n) => Number(n.trim()));
/** Long enough for the longest recovery delay plus an object boot and a model start. */
const RECOVERY_WAIT_MS = Math.max(...RECOVERY_DELAYS_MS) + 60_000;
/** Set: drill a deployed oracle as this account instead of booting the harness. */
const DEVNET_ACCOUNT_JSON = process.env.ACCOUNT_JSON;

interface DevnetAccount {
  did: string;
  address: string;
  edSigningMnemonic: string;
  matrixUserId: string;
  matrixPassword: string;
  roomId: string;
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
    console.log(`▷ ${name} … skipped`);
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

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();

const ESSAY =
  'Write a 600-word essay about the history of lighthouses. Do not use any tools. Start immediately with the first sentence of the essay.';

interface LiveDebug {
  runId: string;
  status: string;
  generation: number;
  lastSeq: number;
  packedSeq: number;
  subscribers: number;
}

interface RunDebug {
  runId: string;
  sessionId: string;
  status: string;
  attempts: number;
  lastSeq: number;
  segments: number;
  partialText?: string;
  messageId?: string;
  error: string | null;
  taskRunId: string | null;
  marks: Array<{
    toolCallId: string;
    toolName: string;
    effect: string;
    outcome: string | null;
    attempts: number;
    startedAt: string;
    doneAt: string | null;
  }>;
}

async function main(): Promise<void> {
  const devnet = DEVNET_ACCOUNT_JSON
    ? (JSON.parse(readFileSync(DEVNET_ACCOUNT_JSON, 'utf8')) as DevnetAccount)
    : null;
  if (devnet && !process.env.ORACLE_URL)
    throw new Error('ORACLE_URL is required with ACCOUNT_JSON');
  if (devnet && !ORACLE_DID)
    throw new Error('ORACLE_DID is required with ACCOUNT_JSON');
  const recorder = devnet ? null : await startDrillRecorder();
  if (recorder)
    await provisionDevVars({
      extra: {
        DRILL_TOOLS: 'true',
        DRILL_RECORDER_URL: recorder.url,
        RUN_RECOVERY_ATTEMPTS: String(RECOVERY_ATTEMPTS),
        RUN_RECOVERY_DELAYS_MS: RECOVERY_DELAYS_MS.join(','),
        RUN_SEGMENT_FLUSH_MS: '1000',
      },
    });
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);
  try {
    const alice: HarnessAccount = devnet
      ? {
          name: 'devnet-durable',
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
    if (devnet)
      console.log(
        `devnet drill — ${oracle.url} as ${alice.did} (room ${devnet.roomId}); recovery ${RECOVERY_ATTEMPTS} × ${RECOVERY_DELAYS_MS.join('/')} ms`,
      );
    else
      await step(
        'setup: alice has an E2EE user↔oracle room the bot joined',
        () => ensureOracleRoom(oracle.url, alice),
      );

    const debugPost = async (path: string) => {
      const res = await fetch(`${oracle.url}${path}`, {
        method: 'POST',
        headers: client.headers(),
      });
      return { status: res.status, text: await res.text() };
    };
    const runsStatus = async (): Promise<{
      live: LiveDebug[];
      runs: RunDebug[];
    }> => {
      const res = await fetch(`${oracle.url}/debug/runs`, {
        headers: client.headers(),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as { live: LiveDebug[]; runs: RunDebug[] };
    };
    /** Wait until the frames up to `seq` are packed into segments (survive a reset). */
    const waitForPacked = async (runId: string, seq: number) =>
      waitFor(
        async () =>
          ((await runsStatus()).live.find((l) => l.runId === runId)
            ?.packedSeq ?? 0) >= seq,
        10_000,
        `frames up to ${seq} to be packed`,
        100,
      );
    /**
     * What a client following the durable-run protocol displays: the text it
     * had, cut back to `partialLength` when a resumed attempt is announced,
     * then the later message frames appended.
     */
    const clientText = (seenText: string, later: SSEEvent[]): string => {
      let text = seenText;
      for (const e of later) {
        if (e.event === 'run' && e.data.resumed === true)
          text = text.slice(0, Number(e.data.partialLength ?? text.length));
        if (e.event === 'message') text += String(e.data.content ?? '');
      }
      return text;
    };
    const runDebug = async (runId: string): Promise<RunDebug | undefined> =>
      (await runsStatus()).runs.find((r) => r.runId === runId);
    /**
     * How many times a drill tool actually ran: the recorder's count (local),
     * or the executions the runtime marked for the run (a deployment cannot
     * reach the recorder; `attempts` on a mark is bumped per execution).
     */
    const markedStarts = (
      run: RunDebug | undefined,
      toolName: string,
    ): number =>
      run?.marks
        .filter((m) => m.toolName === toolName)
        .reduce((n, m) => n + m.attempts, 0) ?? 0;
    const toolStarts = async (
      token: string,
      runId: string | null,
      toolName: string,
    ): Promise<number> => {
      if (recorder) return recorder.starts(token);
      return runId ? markedStarts(await runDebug(runId), toolName) : 0;
    };
    const waitForRunStatus = async (
      runId: string,
      statuses: string[],
      timeoutMs: number,
    ): Promise<RunDebug> => {
      let last: RunDebug | undefined;
      await waitFor(
        async () => {
          last = await runDebug(runId);
          return Boolean(last && statuses.includes(last.status));
        },
        timeoutMs,
        `run ${runId} to reach ${statuses.join('|')} (last: ${last?.status})`,
        500,
      );
      return last!;
    };
    const lastAiText = async (sessionId: string): Promise<string> => {
      const { messages } = await client.listMessages(sessionId);
      const ai = [...messages].reverse().find((m) => m.type === 'ai');
      return typeof ai?.content === 'string' ? ai.content : '';
    };
    const resetObject = async () => {
      const reset = await debugPost('/debug/object/abort');
      assert.equal(reset.status, 200, reset.text.slice(0, 200));
    };
    /**
     * Start a streamed turn and hand back the run id once the first frames
     * arrived; frames keep being collected in the background until `stop`.
     */
    const streamUntil = async (
      sessionId: string,
      message: string,
      until: (e: SSEEvent, events: SSEEvent[]) => boolean,
      body: Record<string, unknown> = {},
    ) => {
      const ac = new AbortController();
      const events: SSEEvent[] = [];
      let resolveRun!: (runId: string | null) => void;
      const runIdPromise = new Promise<string | null>((r) => {
        resolveRun = r;
      });
      let resolveHit!: () => void;
      const hit = new Promise<void>((r) => {
        resolveHit = r;
      });
      let hitOnce = false;
      const finished = client
        .stream(sessionId, message, {
          signal: ac.signal,
          body,
          onEvent: (e) => {
            events.push(e);
            if (e.event === 'run' && typeof e.data.runId === 'string')
              resolveRun(e.data.runId);
            if (!hitOnce && until(e, events)) {
              hitOnce = true;
              resolveHit();
            }
          },
        })
        .catch((err: unknown) => ({
          events,
          text: '',
          durationMs: 0,
          requestId: null,
          runId: null,
          status: 0,
          error: err,
        }));
      const runId = await Promise.race([
        runIdPromise,
        finished.then((r) => r.runId),
      ]);
      return {
        runId,
        events,
        hit,
        stop: () => ac.abort(),
        finished,
        lastSeq: () => events.reduce((m, e) => Math.max(m, e.id ?? 0), 0),
        text: () =>
          events
            .filter((e) => e.event === 'message')
            .map((e) => String(e.data.content ?? ''))
            .join(''),
      };
    };
    const nthMessage = (n: number) => (_e: SSEEvent, events: SSEEvent[]) =>
      events.filter((e) => e.event === 'message').length >= n;

    // ------------------------------------------------------------ frames
    await step(
      'frames: a streamed turn announces its run, numbers every frame, and closes with done',
      async () => {
        const sid = await client.createSession();
        const r = await client.stream(
          sid,
          'What is 17 + 25? Reply with only the number.',
        );
        assert.equal(r.status, 200, r.text);
        assert.ok(r.runId, 'x-run-id header');
        assert.equal(r.events[0]?.event, 'run', JSON.stringify(r.events[0]));
        assert.equal(r.events[0]?.data.runId, r.runId);
        const ids = r.events.map((e) => e.id ?? 0);
        assert.ok(
          ids.every((id, i) => id > 0 && (i === 0 || id > ids[i - 1]!)),
          `frame ids not strictly increasing: ${ids.join(',')}`,
        );
        const done = r.events.at(-1);
        assert.equal(done?.event, 'done');
        assert.equal(done?.data.runId, r.runId);
        assert.match(r.text, /42/);
        assert.equal(await client.sessionRun(sid), null);
        const debug = await runDebug(r.runId);
        assert.equal(debug?.status, 'finished', JSON.stringify(debug));
        assert.equal(debug?.segments, 0, 'segments reclaimed at cutover');
        assert.equal(debug?.marks.length, 0);
        assert.ok(debug?.messageId, 'final message id recorded');
      },
    );

    // ------------------------------------------------------------ disconnect
    await step(
      'disconnect: the run continues after the client leaves; the reply lands in the transcript; the run can be replayed',
      async () => {
        const sid = await client.createSession();
        const s = await streamUntil(sid, ESSAY, nthMessage(3));
        await s.hit;
        assert.ok(s.runId, 'run id');
        const active = await client.sessionRun(sid);
        assert.equal(active?.runId, s.runId, JSON.stringify(active));
        s.stop();
        await pause(500);
        const stillRunning = await runDebug(s.runId);
        assert.equal(
          stillRunning?.status,
          'running',
          `the run stopped with the client: ${JSON.stringify(stillRunning)}`,
        );
        const finished = await waitForRunStatus(s.runId, ['finished'], 180_000);
        assert.ok(finished.messageId);
        const reply = await lastAiText(sid);
        assert.ok(
          reply.length > 800,
          `reply in the transcript is short (${reply.length} chars)`,
        );
        assert.equal(await client.sessionRun(sid), null);
        const replay = await client.join(s.runId);
        assert.equal(replay.status, 200, replay.text);
        const done = replay.events.at(-1);
        assert.equal(done?.event, 'done');
        assert.equal(done?.data.status, 'finished');
        assert.equal(done?.data.replayed, true);
        assert.equal(done?.data.messageId, finished.messageId);
      },
    );

    // ------------------------------------------------------------ re-join
    await step(
      're-join: a client reconnects with its cursor and receives exactly the rest of the reply',
      async () => {
        const sid = await client.createSession();
        const s = await streamUntil(sid, ESSAY, nthMessage(5));
        await s.hit;
        const cursor = s.lastSeq();
        const seenText = s.text();
        s.stop();
        assert.ok(cursor >= 5, `cursor ${cursor}`);
        const rest = await client.join(s.runId!, cursor);
        assert.equal(rest.status, 200, rest.text);
        const ids = rest.events.map((e) => e.id ?? 0);
        assert.ok(
          ids.every((id) => id > cursor),
          `replayed frames at or before the cursor ${cursor}: ${ids.slice(0, 10).join(',')}`,
        );
        assert.equal(ids[0], cursor + 1, `first replayed id ${ids[0]}`);
        assert.equal(rest.events.at(-1)?.event, 'done');
        const finished = await waitForRunStatus(s.runId!, ['finished'], 30_000);
        const reply = await lastAiText(sid);
        assert.equal(
          seenText + rest.text,
          reply,
          'seen text + re-joined text must equal the transcript reply',
        );
        assert.equal(finished.segments, 0);
      },
    );

    // ------------------------------------------------------------ reset mid-reply
    await step(
      'reset mid-reply: the object is reset while the model streams; the run is recovered, continued and finished',
      async () => {
        const sid = await client.createSession();
        const s = await streamUntil(sid, ESSAY, nthMessage(3));
        await s.hit;
        const seenSeq = s.lastSeq();
        const seenText = s.text();
        await resetObject();
        const recovering = await waitForRunStatus(
          s.runId!,
          ['recovering', 'running', 'finished'],
          20_000,
        );
        assert.ok(
          recovering.attempts >= 1,
          `no recovery attempt scheduled: ${JSON.stringify(recovering)}`,
        );
        // A client re-joining during the recovery gets the rest when it runs.
        const rejoin = client.join(s.runId!, seenSeq);
        const finished = await waitForRunStatus(
          s.runId!,
          ['finished'],
          180_000,
        );
        assert.equal(finished.attempts, 1, JSON.stringify(finished));
        const joined = await rejoin;
        assert.equal(joined.status, 200);
        assert.ok(
          joined.events.some(
            (e) => e.event === 'run' && e.data.resumed === true,
          ),
          'the re-joined stream announced the resumed attempt',
        );
        assert.equal(joined.events.at(-1)?.event, 'done');
        assert.ok(
          joined.text.length > 200,
          'the resumed attempt streamed text',
        );
        assert.ok(
          finished.lastSeq > seenSeq,
          'the run kept numbering after the reset',
        );
        const ids = joined.events.map((e) => e.id ?? 0);
        assert.ok(
          ids.every((id) => id > seenSeq),
          `re-joined frames at or before the cursor ${seenSeq}: ${ids.slice(0, 5).join(',')}`,
        );
        const resumedFrame = joined.events.find(
          (e) => e.event === 'run' && e.data.resumed === true,
        );
        assert.equal(typeof resumedFrame?.data.partialLength, 'number');
        const reply = await lastAiText(sid);
        assert.ok(
          reply.length > 500,
          `transcript reply short: ${reply.length}`,
        );
        assert.ok(
          seenText.length > 0,
          'the user had received text before the reset',
        );
        // The client cut back to what the runtime kept and appended the
        // rest: no duplicated or missing fragment around the reset.
        assert.equal(
          clientText(seenText, joined.events),
          reply,
          'client text after the re-join differs from the transcript',
        );
        assert.equal(await client.sessionRun(sid), null);
      },
    );

    // ------------------------------------------------------------ reset mid-write
    await step(
      'reset mid-write tool: the write is not executed twice; the model is told its outcome is unknown',
      async () => {
        const sid = await client.createSession();
        const token = `W-${tag()}`;
        const s = await streamUntil(
          sid,
          `Call the tool drill_slow_write with token "${token}" and ms 10000, then tell me the receipt it returned.`,
          (e) =>
            e.event === 'tool_call' &&
            e.data.toolName === 'drill_slow_write' &&
            e.data.status === 'isRunning',
        );
        await s.hit;
        await waitFor(
          async () =>
            (await toolStarts(token, s.runId, 'drill_slow_write')) >= 1,
          15_000,
          'the write tool to start',
          200,
        );
        await pause(1000);
        await resetObject();
        const finished = await waitForRunStatus(
          s.runId!,
          ['finished', 'failed', 'interrupted'],
          180_000,
        );
        assert.equal(finished.status, 'finished', JSON.stringify(finished));
        const writes = await toolStarts(token, s.runId, 'drill_slow_write');
        assert.equal(writes, 1, `the write ran ${writes} times`);
        const mark = finished.marks.find(
          (m) => m.toolName === 'drill_slow_write',
        );
        assert.ok(mark, `no mark: ${JSON.stringify(finished.marks)}`);
        assert.equal(mark.effect, 'write');
        assert.equal(mark.attempts, 1);
        assert.equal(mark.outcome, 'interrupted');
        // The transcript folds tool results into the assistant message's
        // `toolCalls[].output`.
        const { messages } = await client.listMessages(sid);
        const toolOutputs = messages
          .flatMap((m) => (m.toolCalls ?? []) as Array<{ output?: unknown }>)
          .map((t) => String(t.output ?? ''));
        assert.ok(
          toolOutputs.some((c) => /NOT run again/.test(c)),
          `no unknown-outcome tool result in the transcript: ${JSON.stringify(toolOutputs).slice(0, 400)}`,
        );
      },
    );

    // ------------------------------------------------------------ reset mid-read
    await step(
      'reset mid-read tool: the read is executed again and the turn finishes with its receipt',
      async () => {
        const sid = await client.createSession();
        const token = `R-${tag()}`;
        const s = await streamUntil(
          sid,
          `Call the tool drill_slow_read with token "${token}" and ms 10000, then tell me the receipt it returned.`,
          (e) =>
            e.event === 'tool_call' &&
            e.data.toolName === 'drill_slow_read' &&
            e.data.status === 'isRunning',
        );
        await s.hit;
        await waitFor(
          async () =>
            (await toolStarts(token, s.runId, 'drill_slow_read')) >= 1,
          15_000,
          'the read tool to start',
          200,
        );
        await pause(1000);
        await resetObject();
        const finished = await waitForRunStatus(
          s.runId!,
          ['finished', 'failed', 'interrupted'],
          180_000,
        );
        assert.equal(finished.status, 'finished', JSON.stringify(finished));
        const reads = await toolStarts(token, s.runId, 'drill_slow_read');
        assert.equal(reads, 2, `the read ran ${reads} times`);
        const mark = finished.marks.find(
          (m) => m.toolName === 'drill_slow_read',
        );
        assert.ok(mark, `no mark: ${JSON.stringify(finished.marks)}`);
        assert.equal(mark.effect, 'read');
        assert.equal(mark.attempts, 2);
        assert.equal(mark.outcome, 'ok');
        const reply = await lastAiText(sid);
        assert.match(
          reply,
          /drill_slow_read/,
          `reply lacks the receipt: ${reply}`,
        );
      },
    );

    // ------------------------------------------------------------ supersede
    await step(
      'supersede (default rule): a new message aborts the running turn and keeps its partial text',
      async () => {
        const sid = await client.createSession();
        const a = await streamUntil(sid, ESSAY, nthMessage(3));
        await a.hit;
        const marker = `OK-${tag()}`;
        const b = await client.stream(
          sid,
          `Reply with exactly ${marker} and nothing else.`,
        );
        assert.equal(b.status, 200, b.text);
        assert.match(b.text, new RegExp(marker));
        const aResult = await a.finished;
        assert.equal(
          aResult.events.at(-1)?.event,
          'done',
          'A closed with done',
        );
        assert.equal(aResult.events.at(-1)?.data.aborted, true);
        const aRun = await waitForRunStatus(a.runId!, ['aborted'], 15_000);
        assert.ok(
          (aRun.partialText ?? '').length > 0,
          `A kept no partial text: ${JSON.stringify(aRun)}`,
        );
        const bRun = await runDebug(b.runId!);
        assert.equal(bRun?.status, 'finished');
      },
    );

    // ------------------------------------------------------------ enqueue
    await step(
      'enqueue: a new message waits behind the running turn and both replies land in order',
      async () => {
        const sid = await client.createSession();
        const a = await streamUntil(sid, ESSAY, nthMessage(3));
        await a.hit;
        const marker = `QUEUED-${tag()}`;
        const bStart = Date.now();
        const b = await client.stream(
          sid,
          `Reply with exactly ${marker} and nothing else.`,
          { body: { multitask: 'enqueue' } },
        );
        assert.equal(b.status, 200, b.text);
        assert.match(b.text, new RegExp(marker));
        assert.ok(
          b.events.some(
            (e) => e.event === 'router.update' && e.data.queued === true,
          ),
          'B announced it was queued',
        );
        const aResult = await a.finished;
        assert.equal(aResult.events.at(-1)?.event, 'done');
        assert.notEqual(
          aResult.events.at(-1)?.data.aborted,
          true,
          'A not aborted',
        );
        const aRun = await runDebug(a.runId!);
        assert.equal(aRun?.status, 'finished', JSON.stringify(aRun));
        const bRun = await runDebug(b.runId!);
        assert.equal(bRun?.status, 'finished', JSON.stringify(bRun));
        const { messages } = await client.listMessages(sid);
        const ai = messages.filter((m) => m.type === 'ai');
        assert.ok(ai.length >= 2, `expected two replies, got ${ai.length}`);
        assert.ok(
          String(ai[ai.length - 1]?.content).includes(marker),
          'B is the last reply',
        );
        assert.ok(
          String(ai[ai.length - 2]?.content).length > 500,
          'A (the essay) precedes it',
        );
        assert.ok(Date.now() - bStart > 2000, 'B did wait for A');
      },
    );

    // ------------------------------------------------------------ recovery cap
    await step(
      `recovery cap: a run reset ${RECOVERY_ATTEMPTS + 1} times without progress is closed as interrupted with its partial text`,
      async () => {
        const sid = await client.createSession();
        const s = await streamUntil(sid, ESSAY, nthMessage(2));
        await s.hit;
        // The partial text survives only once packed (every RUN_SEGMENT_FLUSH_MS).
        await waitForPacked(s.runId!, s.lastSeq());
        const packedText = s.text();
        for (let i = 0; i <= RECOVERY_ATTEMPTS; i += 1) {
          if (i > 0) {
            // Wait for the next attempt to be executing, then kill it
            // before it can commit a checkpoint (the model call takes far
            // longer than this).
            await waitFor(
              async () => (await runDebug(s.runId!))?.status === 'running',
              RECOVERY_WAIT_MS,
              `attempt ${i} to start`,
              200,
            );
            await pause(1500);
          }
          await resetObject();
        }
        const closed = await waitForRunStatus(
          s.runId!,
          ['interrupted', 'finished'],
          RECOVERY_WAIT_MS,
        );
        assert.equal(closed.status, 'interrupted', JSON.stringify(closed));
        assert.ok(
          (closed.partialText ?? '').length > 0,
          'partial text kept on the interrupted run',
        );
        assert.ok(
          closed.partialText!.startsWith(packedText.slice(0, 20)),
          'the kept text is what the user had received',
        );
        const replay = await client.join(s.runId!);
        const done = replay.events.at(-1);
        assert.equal(done?.event, 'done');
        assert.equal(done?.data.status, 'interrupted');
        assert.ok(
          typeof done?.data.partialText === 'string' &&
            done.data.partialText.length > 0,
          'the replay carries the partial text',
        );
        assert.equal(await client.sessionRun(sid), null);
      },
    );

    // ------------------------------------------------------------ task run
    await step(
      'task run: a scheduled task interrupted by a reset is recovered and delivered once',
      async () => {
        const sid = await client.createSession();
        const token = `T-${tag()}`;
        const stepStartedAt = Date.now();
        const at = new Date(Date.now() + 25_000).toISOString();
        const ask = await client.stream(
          sid,
          `Use preview_task then create_task (no need to ask me, I confirm now) to schedule a ONE-TIME task at ${at} titled "Drill ${token}" whose intent is: "Call the tool drill_slow_write with token ${token} and ms 12000, then report the receipt it returned." No dedicated room, approval never.`,
        );
        assert.equal(ask.status, 200, ask.text);
        const created = ask.events.some(
          (e) =>
            e.event === 'tool_call' &&
            e.data.toolName === 'create_task' &&
            e.data.status === 'done',
        );
        if (!created) {
          const again = await client.stream(
            sid,
            'Yes, confirmed — call create_task now with the same title, intent and schedule.',
          );
          assert.ok(
            again.events.some(
              (e) =>
                e.event === 'tool_call' &&
                e.data.toolName === 'create_task' &&
                e.data.status === 'done',
            ),
            `create_task never ran: ${again.text}`,
          );
        }
        // Wait for the run to start (the alarm fires at `at`), then reset
        // the object while the write tool sleeps.
        // (against a deployment: a task run of this step marked the write tool)
        const taskRunOfThisStep = (all: { runs: RunDebug[] }) =>
          all.runs.find(
            (r) =>
              r.taskRunId &&
              r.marks.some(
                (m) =>
                  m.toolName === 'drill_slow_write' &&
                  Date.parse(m.startedAt) >= stepStartedAt,
              ),
          );
        await waitFor(
          async () =>
            recorder
              ? recorder.starts(token) >= 1
              : taskRunOfThisStep(await runsStatus()) !== undefined,
          90_000,
          'the task run to reach the write tool',
          500,
        );
        await pause(1000);
        await resetObject();
        let taskRun: RunDebug | undefined;
        await waitFor(
          async () => {
            taskRun = taskRunOfThisStep(await runsStatus());
            return taskRun?.status === 'finished';
          },
          180_000,
          `the task's turn run to finish (last: ${taskRun?.status})`,
          1000,
        );
        const taskWrites = recorder
          ? recorder.starts(token)
          : markedStarts(taskRun, 'drill_slow_write');
        assert.equal(taskWrites, 1, `the write ran ${taskWrites} times`);
        await waitFor(
          async () => {
            const res = await fetch(`${oracle.url}/debug/tasks`, {
              headers: client.headers(),
            });
            const body = (await res.json()) as {
              tasks: Array<{
                title: string;
                lastResult: { ok: boolean } | null;
              }>;
              openRuns: unknown[];
            };
            const task = body.tasks.find((t) => t.title.includes(token));
            return Boolean(task?.lastResult?.ok) && body.openRuns.length === 0;
          },
          120_000,
          'the task to record a delivered result',
          1000,
        );
      },
    );
  } finally {
    await oracle.stop();
    await recorder?.close();
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
