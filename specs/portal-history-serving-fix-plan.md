# Portal History Serving Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the full transcript reliably reach the portal: harden the saver's message write path so no turn can be dropped, pin the transcript-under-summarization contract with tests, and run the diagnosis that selects the remaining fix branch.

**Architecture:** Two unconditional code tasks in `@ixo/sqlite-saver` (id-less messages no longer abort a checkpoint write; `listThreadMessages` proven complete after summarization-shaped puts), plus a gated diagnosis task whose finding selects branch A/B/C from the spec. Branches A (Matrix-timeline backfill) and C (portal SDK) get their own plan once the finding is in — they cannot be specified honestly before it.

**Tech Stack:** TypeScript, better-sqlite3, `@langchain/core` messages, vitest.

**Spec:** `specs/portal-history-serving-fix.md`

## Global Constraints

- Work ONLY inside this worktree: `/Users/yousef/ixo-oracles-boilerplate/.claude/worktrees/feature-checkpoint-vfs-backup`.
- **NEVER run git write commands.** Report done and stop; the controller commits.
- **No type assertions** (`as any`, `as X`). **No task/spec metadata in source comments.**
- The summarization middleware is NOT touched.
- Saver tests (no hoisted vitest here): from `packages/sqlite-saver`, run `../vitest-config/node_modules/.bin/vitest run <file>`. Saver build: `pnpm --filter @ixo/sqlite-saver build`.
- Tight assertions; 2 test-side attempts max on a failing test, then STOP and report.

---

### Task 1: Id-less messages must not abort a checkpoint write

**Files:**

- Modify: `packages/sqlite-saver/src/index.ts` (`put()`, directly after `const { checkpoint, messages } = removeMessagesFromCheckpoint(_checkpoint);`)
- Modify: `packages/sqlite-saver/src/tests/pruning.test.ts` (add one test)

**Interfaces:**

- Consumes: `removeMessagesFromCheckpoint` (existing), `randomUUID` from `node:crypto` (add the import if absent).
- Produces: behavior only — every message handed to `put()` ends up in the `messages` table with a stable id; the previously red `agent-with-checkpoiner.test.ts` (3 tests failing on `NOT NULL constraint failed: messages.message_id`) turns green.

- [ ] **Step 1: Write the failing test** (append to `pruning.test.ts`, which already imports `checkpointWithMessages` and `SqliteSaver`)

```ts
import { HumanMessage } from '@langchain/core/messages';
// (add to the existing imports at the top of the file)

it('assigns a stable id to id-less messages instead of aborting the write', async () => {
  const saver = SqliteSaver.fromConnString(':memory:');
  const message = new HumanMessage('no id on purpose');
  expect(message.id).toBeUndefined();

  await saver.put(
    { configurable: { thread_id: 'thread-1' } },
    checkpointWithMessages(0, [message]),
    { source: 'input', step: 0, parents: {} },
  );
  const assigned = message.id;
  expect(typeof assigned).toBe('string');

  // The same object re-put under the next checkpoint keeps its id — one row, not two.
  await saver.put(
    { configurable: { thread_id: 'thread-1' } },
    checkpointWithMessages(1, [message]),
    { source: 'loop', step: 1, parents: {} },
  );
  const rows = saver.db
    .prepare(`SELECT message_id FROM messages WHERE thread_id = ?`)
    .all('thread-1');
  expect(rows).toEqual([{ message_id: assigned }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/sqlite-saver`): `../vitest-config/node_modules/.bin/vitest run src/tests/pruning.test.ts`
Expected: the new test FAILS with `NOT NULL constraint failed: messages.message_id`.

- [ ] **Step 3: Implement**

In `put()`, immediately after `const { checkpoint, messages } = removeMessagesFromCheckpoint(_checkpoint);`:

```ts
// LangGraph's message reducer assigns ids to what it appends, but callers
// that hand `put()` raw messages (direct saver use, replays, tests) may
// not. The messages table keys rows by id, so an id-less message would
// abort the whole checkpoint write. Assign one here, on the shared object,
// so every later put of the same message updates the same row.
for (const message of messages ?? []) {
  if (!message.id && !message.lc_kwargs?.id) {
    message.id = randomUUID();
  }
}
```

(`messages` is the array `removeMessagesFromCheckpoint` returns; if its element type does not expose `lc_kwargs`, match the existing `message.id ?? message.lc_kwargs?.id` expression used further down in the same method.)

- [ ] **Step 4: Run the new test, then the whole saver suite**

Run (from `packages/sqlite-saver`): `../vitest-config/node_modules/.bin/vitest run`
Expected: the new test PASSES and `agent-with-checkpoiner.test.ts` goes from 3 failing to 0 failing; every other test unchanged. Paste the totals. Then `pnpm --filter @ixo/sqlite-saver build` clean. Report done.

---

### Task 2: Pin the transcript-under-summarization contract

**Files:**

- Create: `packages/sqlite-saver/src/tests/transcript.test.ts`

**Interfaces:**

- Consumes: `checkpointWithMessages`, `message` from `./fixtures`; `SqliteSaver.listThreadMessages`.
- Produces: a regression test documenting that after summarization replaces graph state with a summary + tail, `listThreadMessages` still returns every message ever written (plus the summary row, which the runtime filters).

- [ ] **Step 1: Write the test**

```ts
import { AIMessage } from '@langchain/core/messages';
import { SqliteSaver } from '../index';
import { checkpointWithMessages, message } from './fixtures';

const SUMMARY_PREFIX = 'Here is a summary of the conversation to date:';

describe('transcript survives summarization', () => {
  it('listThreadMessages returns every message after state is condensed to summary + tail', async () => {
    const saver = SqliteSaver.fromConnString(':memory:', {
      maxCheckpointsPerThread: 2,
    });
    const thread = { configurable: { thread_id: 'thread-1' } };

    // Six turns of cumulative history, like the graph reducer produces.
    const history = Array.from({ length: 6 }, (_, i) =>
      message(
        i % 2 === 0 ? 'human' : 'ai',
        `msg-${i}`,
        `turn ${i}`,
        `2024-04-19T17:19:${String(i).padStart(2, '0')}.000Z`,
      ),
    );
    for (let i = 0; i < history.length; i++) {
      await saver.put(
        thread,
        checkpointWithMessages(i, history.slice(0, i + 1)),
        {
          source: 'loop',
          step: i,
          parents: {},
        },
      );
    }

    // Summarization: state becomes [summary, last two turns].
    const summary = new AIMessage({
      id: 'summary-1',
      content: `${SUMMARY_PREFIX} turns 0-3 condensed`,
      additional_kwargs: {
        lc_source: 'summarization',
        timestamp: '2024-04-19T17:19:06.000Z',
      },
    });
    await saver.put(
      thread,
      checkpointWithMessages(6, [summary, history[4], history[5]]),
      { source: 'loop', step: 6, parents: {} },
    );

    const transcript = await saver.listThreadMessages('thread-1');
    expect(transcript.map((m) => m.content)).toEqual([
      'turn 0',
      'turn 1',
      'turn 2',
      'turn 3',
      'turn 4',
      'turn 5',
      `${SUMMARY_PREFIX} turns 0-3 condensed`,
    ]);

    // Pruning ran (cap 2 + slack) and did not touch the transcript.
    const count = saver.db
      .prepare(`SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?`)
      .pluck()
      .get('thread-1');
    expect(count).toBeLessThanOrEqual(7);
  });
});
```

- [ ] **Step 2: Run it**

Run (from `packages/sqlite-saver`): `../vitest-config/node_modules/.bin/vitest run src/tests/transcript.test.ts`
Expected: PASS on the current code (this pins existing behavior). If it FAILS, do not adjust the assertion — report the actual output: that is the branch-B finding the spec anticipates. Report done.

---

### Task 3: Diagnosis (manual, gated — produces a finding, not code)

**Files:**

- Create: `specs/notes/history-diagnosis.md` (the finding)

**Interfaces:** none — human-run against prod.

- [ ] **Step 1:** Take one affected `sessionId` + `userDid` from a user report.
- [ ] **Step 2:** On the pod, run the read-only count from the spec's "Diagnosis" section (`node:sqlite`, `readOnly: true`) for that thread; record `n`, `a`, `b`.
- [ ] **Step 3:** Call `GET /messages/<sessionId>` with a valid invocation (or replay through the SDK) and record the count returned.
- [ ] **Step 4:** Record what the portal renders for the same session.
- [ ] **Step 5:** Write `specs/notes/history-diagnosis.md` with the three numbers and the selected branch per the spec's table (A: rows missing / B: endpoint drops rows / C: portal shows fewer than the endpoint returns). Branch B is already partially guarded by Task 2; A and C get their own plan from the finding.

---

## Execution notes

- Tasks 1 and 2 are independent and small; run them as one wave. Task 3 is the user's.
- Controller runs `pnpm lint` + `pnpm format:check` at wave end.
