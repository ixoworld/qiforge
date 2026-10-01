# Checkpoint Storage Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound per-user checkpoint SQLite file size, make Matrix backups consistent and compact, auto-migrate existing bloated DBs, and never attempt an upload the homeserver will reject.

**Architecture:** Four layers — (1) `@ixo/sqlite-saver` creates DBs in incremental auto-vacuum mode and returns pruned pages to the filesystem; (2) the sync service uploads a `VACUUM INTO` snapshot instead of the live file; (3) bloated legacy DBs get a one-time in-place VACUUM from the upload cron while the user is inactive; (4) uploads are guarded by the homeserver's `m.upload.size` cap with an oversized-checksum memo.

**Tech Stack:** TypeScript, better-sqlite3, NestJS cron, matrix-bot-sdk (via `@ixo/matrix`), vitest.

**Spec:** `specs/checkpoint-storage-hardening.md`

## Global Constraints

- **NEVER run git write commands** (no add/commit/push/etc.). At the end of each task, report done and stop — the user reviews and commits. Read-only git is fine.
- **No type assertions** (`as any`, `as X`, `as unknown as X`). better-sqlite3's `pragma()` returns `any` — assign it to an explicitly typed `const`/`let` instead of asserting.
- **No task/spec metadata in source comments** — comments describe runtime behavior only, never "Task N" / "§N.N" / spec references.
- **Do not touch `apps/app`** — legacy. Active scope is `packages/sqlite-saver`, `packages/oracle-runtime`, `docs/`.
- **Run every unit test you write** and report results. **Never run `*.int.test.ts`** files — integration tests are user-run only.
- **Keep assertions tight** — no broadening a failing assertion to make it pass; two test-side retry attempts max, then stop and ask.
- Pre-completion for each task: self-check sweep for redundancy/dead code, then `pnpm lint` must pass.

---

### Task 1: Saver — incremental auto-vacuum + reclaim after prune

**Files:**

- Create: `packages/sqlite-saver/src/tests/fixtures.ts`
- Create: `packages/sqlite-saver/src/tests/vacuum.test.ts`
- Modify: `packages/sqlite-saver/src/index.ts` (`setup()` ~line 344, `pruneThread()` ~line 515)
- Modify: `packages/sqlite-saver/src/tests/pruning.test.ts` (import shared fixtures)

**Interfaces:**

- Consumes: existing `SqliteSaver.fromConnString(path, { maxCheckpointsPerThread })`, `put()`, `pruneThread()`.
- Produces: no signature changes. Behavior contract for later tasks: new DB files report `PRAGMA auto_vacuum = 2`; after a prune fires, `PRAGMA freelist_count = 0`; legacy `auto_vacuum=0` files are **never** VACUUMed by the saver.

- [ ] **Step 1: Extract shared test fixtures**

`pruning.test.ts` lines 9–32 define `checkpointWithMessages` and `message`; the new vacuum tests need them too (2+ uses → shared fixture). Create `packages/sqlite-saver/src/tests/fixtures.ts`:

```ts
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  type Checkpoint,
  emptyCheckpoint,
  uuid6,
} from '@langchain/langgraph-checkpoint';

export function checkpointWithMessages(
  clock: number,
  messages: Array<HumanMessage | AIMessage>,
): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id: uuid6(clock),
    channel_values: { messages },
  };
}

export function message(
  kind: 'human' | 'ai',
  id: string,
  content: string,
  timestamp: string,
): HumanMessage | AIMessage {
  const fields = {
    id,
    content,
    additional_kwargs: { timestamp },
  };
  return kind === 'human' ? new HumanMessage(fields) : new AIMessage(fields);
}
```

In `pruning.test.ts`, delete the two local definitions (lines 9–32) and replace with:

```ts
import { checkpointWithMessages, message } from './fixtures';
```

Run: `pnpm --filter @ixo/sqlite-saver exec vitest run src/tests/pruning.test.ts`
Expected: all 4 existing tests still PASS.

- [ ] **Step 2: Write the failing vacuum tests**

Create `packages/sqlite-saver/src/tests/vacuum.test.ts`:

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteSaver } from '../index';
import { checkpointWithMessages, message } from './fixtures';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-saver-vacuum-'));
  return path.join(dir, 'test.db');
}

describe('SqliteSaver page reclamation', () => {
  it('creates new database files in incremental auto-vacuum mode', async () => {
    const saver = SqliteSaver.fromConnString(tmpDbPath());
    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpointWithMessages(0, []),
      { source: 'input', step: 0, parents: {} },
    );
    const mode: number = saver.db.pragma('auto_vacuum', { simple: true });
    expect(mode).toBe(2);
  });

  it('returns pruned pages to the filesystem', async () => {
    const dbPath = tmpDbPath();
    const keep = 3;
    const saver = SqliteSaver.fromConnString(dbPath, {
      maxCheckpointsPerThread: keep,
    });
    const bigContent = 'x'.repeat(64 * 1024);
    const putStep = async (i: number) =>
      saver.put(
        { configurable: { thread_id: 'thread-1' } },
        checkpointWithMessages(i, [
          message(
            'human',
            `msg-${i}`,
            `${bigContent}${i}`,
            `2024-04-19T17:19:${String(i).padStart(2, '0')}.000Z`,
          ),
        ]),
        { source: 'loop', step: i, parents: {} },
      );

    // Fill to just below the prune trigger (count must exceed keep + PRUNE_SLACK(5)).
    for (let i = 0; i < 8; i++) {
      await putStep(i);
    }
    const sizeBeforePrune = fs.statSync(dbPath).size;

    // 9th put: count hits 9 > 8, prune fires and must hand pages back.
    await putStep(8);

    const freelist: number = saver.db.pragma('freelist_count', {
      simple: true,
    });
    expect(freelist).toBe(0);
    expect(fs.statSync(dbPath).size).toBeLessThan(sizeBeforePrune);
  });

  it('never VACUUMs a legacy auto_vacuum=NONE file on open', async () => {
    const dbPath = tmpDbPath();
    // Build a legacy-mode file with a large freelist, like a pre-1.1.x DB
    // after pruning: data written, then deleted, pages never reclaimed.
    const legacy = new Database(dbPath);
    legacy.exec('CREATE TABLE junk (payload BLOB)');
    const insert = legacy.prepare('INSERT INTO junk (payload) VALUES (?)');
    for (let i = 0; i < 50; i++) {
      insert.run(Buffer.alloc(64 * 1024, 1));
    }
    legacy.exec('DELETE FROM junk');
    legacy.close();
    const bloatedSize = fs.statSync(dbPath).size;

    const saver = SqliteSaver.fromConnString(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpointWithMessages(0, []),
      { source: 'input', step: 0, parents: {} },
    );

    // The request path must not pay for a migration VACUUM: the file keeps
    // its high-water size (new rows reuse freelist pages).
    expect(fs.statSync(dbPath).size).toBe(bloatedSize);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ixo/sqlite-saver exec vitest run src/tests/vacuum.test.ts`
Expected: test 1 FAILS (`mode` is 0, not 2); test 2 FAILS (`freelist` > 0); test 3 PASSES (current code never vacuums — it guards the new code against regressing into a request-path VACUUM).

- [ ] **Step 4: Implement in `packages/sqlite-saver/src/index.ts`**

In `setup()`, directly after `this.db.pragma('busy_timeout = 5000');` (line ~350) and **before** the first `CREATE TABLE`:

```ts
// Incremental auto-vacuum lets pruning hand freed pages back to the
// filesystem instead of leaving the file at its high-water mark (the
// file is what gets gzipped and synced to Matrix, so dead pages are
// uploaded forever otherwise). On a brand-new database the pragma binds
// immediately because it runs before the first table is created; on an
// existing NONE-mode file it only takes effect after a full VACUUM,
// which must happen outside the request path.
const autoVacuumMode: number = this.db.pragma('auto_vacuum', {
  simple: true,
});
if (autoVacuumMode !== 2) {
  this.db.pragma('auto_vacuum = INCREMENTAL');
}
```

In `pruneThread()`, after `transaction();` (line ~538):

```ts
// Hand freed pages back to the filesystem. No-op on databases whose
// file-level mode is still NONE — those are compacted by the sync
// service's cron instead.
this.db.pragma('incremental_vacuum');
```

- [ ] **Step 5: Run the full saver suite**

Run: `pnpm --filter @ixo/sqlite-saver exec vitest run`
Expected: all tests PASS, including the three new ones and the untouched `checkpointer.test.ts` / `agent-with-checkpoiner.test.ts`.

- [ ] **Step 6: Build the saver so the runtime tasks consume the new behavior**

Run: `pnpm --filter @ixo/sqlite-saver build`
Expected: clean build. Then self-check sweep + `pnpm lint`. Report done — do not commit.

---

### Task 2: Compaction + snapshot helpers (pure, no Matrix/env deps)

**Files:**

- Create: `packages/oracle-runtime/src/matrix/checkpointer/sqlite-compaction.ts`
- Create: `packages/oracle-runtime/src/matrix/checkpointer/sqlite-compaction.test.ts`

**Interfaces:**

- Consumes: `better-sqlite3` only. Must NOT import the sync service or anything that reads env config at module load — that is what keeps it unit-testable.
- Produces (Task 4 imports these exact signatures):
  - `compactSqliteFileIfBloated(dbPath: string, thresholds?: CompactionThresholds): CompactionResult`
  - `snapshotSqliteFile(dbPath: string, snapshotPath: string): void`
  - `interface CompactionResult { compacted: boolean; freelistBytes: number; fileBytesBefore: number; fileBytesAfter: number }`

- [ ] **Step 1: Write the failing tests**

Create `packages/oracle-runtime/src/matrix/checkpointer/sqlite-compaction.test.ts`:

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compactSqliteFileIfBloated,
  snapshotSqliteFile,
} from './sqlite-compaction.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compaction-'));
  return path.join(dir, 'test.db');
}

/** ~12.8MB of freelist (200 x 64KB deleted rows) plus one surviving row. */
function makeBloatedDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE data (id INTEGER PRIMARY KEY, payload BLOB)');
  const insert = db.prepare('INSERT INTO data (payload) VALUES (?)');
  for (let i = 0; i < 200; i++) {
    insert.run(Buffer.alloc(64 * 1024, 1));
  }
  db.exec('DELETE FROM data');
  insert.run(Buffer.from('keeper'));
  db.close();
}

describe('compactSqliteFileIfBloated', () => {
  it('vacuums a bloated file, flips it to incremental mode, and keeps the data', () => {
    const dbPath = tmpDbPath();
    makeBloatedDb(dbPath);
    const bloatedSize = fs.statSync(dbPath).size;

    const result = compactSqliteFileIfBloated(dbPath);

    expect(result.compacted).toBe(true);
    expect(result.fileBytesBefore).toBeGreaterThan(result.fileBytesAfter);
    expect(fs.statSync(dbPath).size).toBeLessThan(bloatedSize);

    const db = new Database(dbPath, { readonly: true });
    const mode: number = db.pragma('auto_vacuum', { simple: true });
    // Statement.get() returns `unknown` in better-sqlite3 v12 typings —
    // assert on the raw value, never cast it.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM data').pluck().get();
    db.close();
    expect(mode).toBe(2);
    expect(rows).toBe(1);
  });

  it('leaves a compact file alone', () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE data (id INTEGER PRIMARY KEY, payload BLOB)');
    db.prepare('INSERT INTO data (payload) VALUES (?)').run(
      Buffer.from('keeper'),
    );
    db.close();
    const sizeBefore = fs.statSync(dbPath).size;

    const result = compactSqliteFileIfBloated(dbPath);

    expect(result.compacted).toBe(false);
    expect(fs.statSync(dbPath).size).toBe(sizeBefore);
  });
});

describe('snapshotSqliteFile', () => {
  it('produces a compact, valid copy and leaves the source untouched', () => {
    const dbPath = tmpDbPath();
    makeBloatedDb(dbPath);
    const sourceSize = fs.statSync(dbPath).size;
    const snapshotPath = dbPath + '.snapshot.tmp';

    snapshotSqliteFile(dbPath, snapshotPath);

    // Source untouched, snapshot free of the ~12MB freelist.
    expect(fs.statSync(dbPath).size).toBe(sourceSize);
    expect(fs.statSync(snapshotPath).size).toBeLessThan(sourceSize / 4);

    const snapshot = new Database(snapshotPath, { readonly: true });
    const rows = snapshot
      .prepare('SELECT COUNT(*) AS n FROM data')
      .pluck()
      .get();
    snapshot.close();
    expect(rows).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/sqlite-compaction.test.ts`
Expected: FAIL — module `./sqlite-compaction.js` does not exist.

- [ ] **Step 3: Implement `sqlite-compaction.ts`**

```ts
import Database from 'better-sqlite3';

export interface CompactionThresholds {
  /** Skip files whose freelist is smaller than this many bytes. */
  minFreelistBytes: number;
  /** Skip files whose freelist is a smaller share of total pages than this. */
  minFreelistRatio: number;
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  minFreelistBytes: 10 * 1024 * 1024,
  minFreelistRatio: 0.2,
};

export interface CompactionResult {
  compacted: boolean;
  freelistBytes: number;
  fileBytesBefore: number;
  fileBytesAfter: number;
}

/**
 * One-time migration for databases created before incremental auto-vacuum:
 * when a meaningful share of the file is dead freelist pages, rebuild it
 * with VACUUM (which also flips the file to incremental mode, so the saver's
 * per-prune `incremental_vacuum` keeps it compact from then on). Call only
 * while no request holds the file — VACUUM takes an exclusive lock to commit.
 */
export function compactSqliteFileIfBloated(
  dbPath: string,
  thresholds: CompactionThresholds = DEFAULT_COMPACTION_THRESHOLDS,
): CompactionResult {
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const pageSize: number = db.pragma('page_size', { simple: true });
    const pageCount: number = db.pragma('page_count', { simple: true });
    const freelistCount: number = db.pragma('freelist_count', {
      simple: true,
    });
    const freelistBytes = freelistCount * pageSize;
    const fileBytesBefore = pageCount * pageSize;

    if (
      pageCount === 0 ||
      freelistBytes < thresholds.minFreelistBytes ||
      freelistCount / pageCount < thresholds.minFreelistRatio
    ) {
      return {
        compacted: false,
        freelistBytes,
        fileBytesBefore,
        fileBytesAfter: fileBytesBefore,
      };
    }

    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    const pagesAfter: number = db.pragma('page_count', { simple: true });
    return {
      compacted: true,
      freelistBytes,
      fileBytesBefore,
      fileBytesAfter: pagesAfter * pageSize,
    };
  } finally {
    db.close();
  }
}

/**
 * Write a transactionally consistent, freelist-free copy of the database to
 * `snapshotPath` via VACUUM INTO. Read-only on the source, so concurrent
 * writers are safe — this is what makes the Matrix upload immune to catching
 * the live file mid-transaction. The target must not already exist.
 */
export function snapshotSqliteFile(dbPath: string, snapshotPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma('busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(snapshotPath);
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/sqlite-compaction.test.ts`
Expected: 3 tests PASS. Then self-check sweep + `pnpm lint`. Report done — do not commit.

---

### Task 3: Homeserver upload-limit discovery

**Files:**

- Create: `packages/oracle-runtime/src/matrix/checkpointer/media-config.ts`
- Create: `packages/oracle-runtime/src/matrix/checkpointer/media-config.test.ts`
- Modify: `packages/oracle-runtime/src/matrix/checkpointer/matrix-upload-utils.ts` (append one function)

**Interfaces:**

- Consumes: `getClient()` (module-local helper already in `matrix-upload-utils.ts`, lines 6–12) whose `client.mxClient` is a matrix-bot-sdk `MatrixClient` exposing `doRequest(method, endpoint)`.
- Produces (Task 4 imports these exact names):
  - From `media-config.ts`: `DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT: number` (100 MiB), `parseUploadSizeLimit(response: unknown): number | undefined`
  - From `matrix-upload-utils.ts`: `fetchMediaUploadSizeLimit(): Promise<number | undefined>`

- [ ] **Step 1: Write the failing parser tests**

Create `packages/oracle-runtime/src/matrix/checkpointer/media-config.test.ts` (`media-config.ts` deliberately has no Matrix imports so this test needs no env/mocks):

```ts
import { describe, expect, it } from 'vitest';
import { parseUploadSizeLimit } from './media-config.js';

describe('parseUploadSizeLimit', () => {
  it('reads m.upload.size from a media config response', () => {
    expect(parseUploadSizeLimit({ 'm.upload.size': 104857600 })).toBe(
      104857600,
    );
  });

  it.each([
    [null],
    [undefined],
    ['50M'],
    [{}],
    [{ 'm.upload.size': '104857600' }],
    [{ 'm.upload.size': -1 }],
    [{ 'm.upload.size': 0 }],
    [{ 'm.upload.size': Number.NaN }],
  ])('returns undefined for malformed response %s', (response) => {
    expect(parseUploadSizeLimit(response)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/media-config.test.ts`
Expected: FAIL — module `./media-config.js` does not exist.

- [ ] **Step 3: Implement `media-config.ts`**

```ts
/**
 * Fallback when the homeserver's media config endpoint is unavailable.
 * Matches the Synapse deployment cap (`max_upload_size: 100M`).
 */
export const DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT = 100 * 1024 * 1024;

/**
 * Extract `m.upload.size` from a `GET /_matrix/client/v1/media/config`
 * (or legacy `/_matrix/media/v3/config`) response body.
 */
export function parseUploadSizeLimit(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  if (!('m.upload.size' in response)) {
    return undefined;
  }
  const size: unknown = response['m.upload.size'];
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
    return size;
  }
  return undefined;
}
```

(TS 4.9+ narrows `response` through the `in` check — no type assertion needed. If the property access still errors under the repo's TS config, use this exact alternative instead of an `as` cast: `const size = new Map(Object.entries(response)).get('m.upload.size');`)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/media-config.test.ts`
Expected: all PASS.

- [ ] **Step 5: Add the fetcher to `matrix-upload-utils.ts`**

Append at the end of the file (uses the module's existing `getClient` and `logger`):

```ts
/**
 * Ask the homeserver for its media upload cap. Tries the spec-current
 * endpoint first, then the pre-Matrix-1.11 one. Returns undefined when
 * neither answers usably — callers decide the fallback.
 */
export async function fetchMediaUploadSizeLimit(): Promise<number | undefined> {
  const client = getClient();
  const endpoints = [
    '/_matrix/client/v1/media/config',
    '/_matrix/media/v3/config',
  ];
  for (const endpoint of endpoints) {
    try {
      const response: unknown = await client.mxClient.doRequest(
        'GET',
        endpoint,
      );
      const limit = parseUploadSizeLimit(response);
      if (limit !== undefined) {
        return limit;
      }
    } catch (error) {
      logger.debug(
        `Media config lookup failed at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return undefined;
}
```

Add the import at the top of `matrix-upload-utils.ts`:

```ts
import { parseUploadSizeLimit } from './media-config.js';
```

- [ ] **Step 6: Type-check the package**

Run: `pnpm --filter @ixo/oracle-runtime build`
Expected: clean build (there is no unit test for the fetcher — it needs a live Matrix client; `parseUploadSizeLimit` carries the logic and is tested). Then self-check sweep + `pnpm lint`. Report done — do not commit.

---

### Task 4: Rewire the upload path (snapshot + migration + guard + robustness)

**Files:**

- Modify: `packages/oracle-runtime/src/matrix/checkpointer/user-matrix-sqlite-sync-service.service.ts`
  - imports (~line 22), class fields (~line 129), `uploadCheckpointToMatrixStorage` (lines 929–1008), `uploadCheckpointToMatrixStorageTask` catch block (lines 1025–1042), `deleteUserStorageFromMatrix` (~line 1136), `clearLocalCheckpoint` suffix list (line 517)

**Interfaces:**

- Consumes: `compactSqliteFileIfBloated`, `snapshotSqliteFile` (Task 2); `fetchMediaUploadSizeLimit`, `DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT` (Task 3); existing `computeFileChecksum`, `removeIfExists`, `bytesToHumanReadable`, `uploadMediaToRoom`.
- Produces: no public API change. Upload behavior contract: backups are always consistent compact snapshots; oversized backups are skipped with one error log and re-attempted only when the file changes.

There is no new unit test in this task: the method is inseparable from `MatrixManager` + env config (module-load `getOrThrow`), and the new logic lives in the helpers tested in Tasks 2–3. The existing integration surface covers the upload round-trip; do not run it.

- [ ] **Step 1: Imports and fields**

Add to the import block:

```ts
import {
  compactSqliteFileIfBloated,
  snapshotSqliteFile,
} from './sqlite-compaction.js';
import { DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT } from './media-config.js';
```

Extend the existing `./matrix-upload-utils.js` import with `fetchMediaUploadSizeLimit`.

Add two members next to `lastUploadedChecksum` (line ~129):

```ts
  /**
   * Live-file checksums whose compressed snapshot exceeded the homeserver
   * upload cap. Skips re-snapshotting an unchanged doomed file every cron
   * tick; cleared on the next successful upload or file change.
   */
  private readonly oversizedChecksum = new Map<string, string>();

  private uploadSizeLimit: number | undefined;
```

Add the resolver method near `getInstance`:

```ts
  private async getUploadSizeLimit(): Promise<number> {
    if (this.uploadSizeLimit === undefined) {
      const fetched = await fetchMediaUploadSizeLimit();
      const resolved = fetched ?? DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT;
      this.uploadSizeLimit = resolved;
      if (fetched === undefined) {
        Logger.warn(
          `Could not read the homeserver media config — assuming an upload limit of ${bytesToHumanReadable(resolved)}`,
        );
      }
    }
    return this.uploadSizeLimit ?? DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT;
  }
```

- [ ] **Step 2: Replace the body of `uploadCheckpointToMatrixStorage` from the checksum computation (line 929) through the compression block (line 970)**

The section from `// Compute checksum via streaming...` down to the compression-ratio `Logger.log` becomes:

```ts
// One-time migration for databases created before incremental
// auto-vacuum: reclaim dead freelist pages while no request holds the
// file. Newly created databases never trip the thresholds.
if (!this.isUserActive(userDid)) {
  try {
    const compaction = compactSqliteFileIfBloated(checkpointPath);
    if (compaction.compacted) {
      Logger.log(
        `Compacted checkpoint for user ${userDid}: ${bytesToHumanReadable(compaction.fileBytesBefore)} -> ${bytesToHumanReadable(compaction.fileBytesAfter)} (${bytesToHumanReadable(compaction.freelistBytes)} of dead pages reclaimed)`,
      );
    }
  } catch (error) {
    Logger.warn(
      `Failed to compact checkpoint for user ${userDid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Compute checksum via streaming to avoid loading the entire DB into
// memory. The checksum is a change detector only — the uploaded bytes
// come from a consistent snapshot below, so a torn read here costs at
// worst one redundant upload.
const currentChecksum = await computeFileChecksum(checkpointPath);
const lastChecksum = this.lastUploadedChecksum.get(storageKey);

if (currentChecksum === lastChecksum) {
  Logger.debug(
    `Skipping upload for user ${userDid} — checkpoint unchanged (checksum: ${currentChecksum.substring(0, 12)}...)`,
  );
  return;
}

if (currentChecksum === this.oversizedChecksum.get(storageKey)) {
  Logger.debug(
    `Skipping upload for user ${userDid} — checkpoint unchanged since it last exceeded the homeserver upload limit`,
  );
  return;
}

// Snapshot via VACUUM INTO: transactionally consistent even if a request
// starts writing mid-upload, and free of dead freelist pages. Then gzip
// the snapshot streaming to disk so only the (much smaller) compressed
// payload is ever buffered in heap.
const snapshotPath = checkpointPath + '.snapshot.tmp';
const gzTmpPath = checkpointPath + '.gz.tmp';
let compressedCheckpoint: Buffer;
let snapshotSize = 0;
try {
  await removeIfExists(snapshotPath);
  snapshotSqliteFile(checkpointPath, snapshotPath);
  ({ size: snapshotSize } = await fs.stat(snapshotPath));
  await pipeline(
    fsSync.createReadStream(snapshotPath),
    createGzip(),
    fsSync.createWriteStream(gzTmpPath),
  );
  compressedCheckpoint = await fs.readFile(gzTmpPath);
} finally {
  await removeIfExists(snapshotPath);
  await removeIfExists(gzTmpPath);
}

const { size: originalSize } = await fs.stat(checkpointPath);
const compressedSize = compressedCheckpoint.length;
Logger.log(
  `Checkpoint for user ${userDid}: ${bytesToHumanReadable(originalSize)} on disk, ${bytesToHumanReadable(snapshotSize)} live -> ${bytesToHumanReadable(compressedSize)} compressed`,
);

const uploadSizeLimit = await this.getUploadSizeLimit();
if (compressedSize > uploadSizeLimit) {
  this.oversizedChecksum.set(storageKey, currentChecksum);
  Logger.error(
    `Checkpoint for user ${userDid} exceeds the homeserver upload limit (${bytesToHumanReadable(compressedSize)} > ${bytesToHumanReadable(uploadSizeLimit)}) — backup skipped, local file keeps serving. Investigate why this user's live state is so large.`,
  );
  return;
}
```

Everything from `const mxManager = MatrixManager.getInstance();` (line 972) onward stays as-is, with one addition — after the `saveFileEventToDB` call (line ~1003):

```ts
this.oversizedChecksum.delete(storageKey);
```

- [ ] **Step 3: Fix the cron's crash-prone error logger**

In `uploadCheckpointToMatrixStorageTask` (lines 1031–1040), the `await fs.stat(...)` inside the catch throws if the file is gone, escaping the catch and aborting uploads for every remaining user that tick. Replace the `'File Size before gzip: ' + ...` argument with:

```ts
            'File Size before gzip: ' +
              (await fs
                .stat(
                  UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid),
                )
                .then((stats) => bytesToHumanReadable(stats.size))
                .catch(() => 'unknown')),
```

- [ ] **Step 4: Two cleanup fixes**

In `deleteUserStorageFromMatrix`, next to `this.filePathCache.delete(userDid);` (line ~1136), add:

```ts
// Without this, the next request for this user skips the Matrix
// re-sync check and lands in corruption recovery on the missing file.
this.syncedUsers.delete(userDid);
```

In `clearLocalCheckpoint`, extend the temp-file suffix list (line 517) to include the snapshot temp:

```ts
    for (const suffix of [
      '',
      '.tmp',
      '.gz.tmp',
      '.snapshot.tmp',
      '-wal',
      '-shm',
      '-journal',
    ]) {
```

- [ ] **Step 5: Build and run the runtime unit suite**

Run: `pnpm --filter @ixo/oracle-runtime build && pnpm --filter @ixo/oracle-runtime exec vitest run`
Expected: clean build; all unit tests PASS (integration `*.int.test.ts` files are excluded from the default vitest mode — verify none executed). Then self-check sweep + `pnpm lint`. Report done — do not commit.

---

### Task 5: Internal docs

**Files:**

- Modify: `docs/architecture/matrix-and-checkpointer.md`

**Interfaces:**

- Consumes: the shipped behavior from Tasks 1–4.
- Produces: documentation only.

- [ ] **Step 1: Read the page and update the backup/sync section**

Read `docs/architecture/matrix-and-checkpointer.md` in full first. Update (matching the page's existing voice and depth — code-first, shallow):

- The upload cron now uploads a `VACUUM INTO` snapshot (consistent, freelist-free), not the live file.
- The saver creates DBs with `auto_vacuum=INCREMENTAL` and runs `incremental_vacuum` after pruning; legacy bloated files are compacted once by the cron while the user is inactive.
- Uploads larger than the homeserver's `m.upload.size` cap (discovered via the media config endpoint, 100 MiB fallback) are skipped with an error log and retried only when the file changes.

If the page has a mermaid diagram of the sync flow, add the snapshot step to it; keep diagrams `graph`/`sequenceDiagram` only (repo rule).

- [ ] **Step 2: Final repo-wide checks**

Run: `pnpm lint && pnpm format`
Expected: both clean. Report done — do not commit.

---

## Execution notes

- **Stop-and-report between tasks** (user rule): after each task, report what was done and wait for review before starting the next. The user commits.
- Task order matters: 1 → 2 → 3 → 4 → 5 (4 imports from 1–3; 1 must be built before 4's build).
- The prod remediation for the currently-bloated Companion DB is a manual ops step (spec §Prod remediation) — it is not part of this plan's code changes.
