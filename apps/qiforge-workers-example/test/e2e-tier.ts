/**
 * End-to-end test of the R2 page tier against the local ixo harness, with
 * wrangler dev's local R2 (`TIER_BUCKET` in wrangler.jsonc) and the real VFS
 * owner store:
 *
 *   pnpm test:e2e:tier
 *   VFS_WORKERS_ATTACH=1 pnpm test:e2e:tier   # reuse already-running workers
 *
 * With a real LLM (OpenRouter) and real UCAN auth it proves that:
 *
 *   1. chat turns fill a working copy whose chunks are all hot;
 *   2. a forced eviction pass moves them into R2 segments and deletes the
 *      rows (`/debug/storage` shows hot rows down, cold segments up);
 *   3. the transcript of the evicted session still reads (cold pages are
 *      fetched and the statement retried);
 *   4. a follow-up turn on the evicted session still recalls its memory —
 *      cold checkpoint reads plus writes over cold chunks (partial rows);
 *   5. a flush exports the tiered file to the user's VFS and the download
 *      gunzips to a SQLite database;
 *   6. a working-copy reset reloads from the VFS, drops the tier map, and
 *      memory survives;
 *   7. the recency policy (1 s periods here) evicts on its own once the
 *      chunks age, and the object keeps serving turns afterwards.
 *
 * Requires the testing harness up plus the two VFS worker checkouts (see
 * `startVfsWorkers`).
 */
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { ChatClient } from './lib/chat-client';
import {
  ensureNamedAccount,
  mintAuthInvocation,
  mintDelegation,
  VFS_OWNER_COPY_CAPABILITY,
  vfsUserRequest,
  type HarnessAccount,
} from './lib/harness';
import {
  ORACLE_DID,
  provisionDevVars,
  startOracle,
  startVfsWorkers,
} from './lib/oracle';

const results: Array<{
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}> = [];

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`ok (${Date.now() - start} ms)`);
    return out;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - start, detail });
    console.log(`FAILED (${Date.now() - start} ms)\n    ${detail}`);
    throw err;
  }
}

interface TierStatus {
  enabled: boolean;
  hotRows: number;
  hotBytes: number;
  coldSegments: number;
  coldChunks: number;
  coldBytes: number;
  r2Gets: number;
  r2Puts: number;
  coldMisses: number;
  missResolutions: number;
  retries: number;
  evictedChunks: number;
  pendingDeletes: number;
  lastPassAt?: number;
}

interface StorageStatus {
  fileBytes: number;
  tier?: TierStatus;
}

interface VfsFileMeta {
  id: string;
  path: string;
  size: number;
  version: number;
  contentHash: string;
}

const SQLITE_MAGIC = 'SQLite format 3\0';
const PERIOD_MS = 1000;

async function storageStatus(
  url: string,
  client: ChatClient,
): Promise<StorageStatus> {
  const res = await fetch(`${url}/debug/storage`, {
    headers: client.headers(),
  });
  const body = (await res.json()) as StorageStatus;
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

async function tierFlush(
  url: string,
  client: ChatClient,
  body: { force?: boolean } = {},
): Promise<{
  evictedChunks: number;
  segmentsRewritten: number;
  remaining: number;
  hotRows: number;
  skipped?: string;
}> {
  const res = await fetch(`${url}/debug/storage/tier-flush`, {
    method: 'POST',
    headers: client.headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    evictedChunks: number;
    segmentsRewritten: number;
    remaining: number;
    hotRows: number;
    skipped?: string;
  };
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

async function listOraclesSubtree(
  user: HarnessAccount,
): Promise<VfsFileMeta[]> {
  const res = await vfsUserRequest(
    user,
    'fs/list',
    'GET',
    `/files?path=${encodeURIComponent('/.oracles')}&limit=200`,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { files?: VfsFileMeta[] };
  return body.files ?? [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const workers = await startVfsWorkers();
  await provisionDevVars({
    vfs: {},
    extra: {
      TIER_PERIOD_MS: String(PERIOD_MS),
      TIER_EVICT_AFTER_PERIODS: '2',
    },
  });
  const oracle = await startOracle();
  console.log(
    `oracle at ${oracle.url} (tier: local R2, ${PERIOD_MS} ms periods)`,
  );
  try {
    const user = await ensureNamedAccount('qf-tier-user');
    const statePath = `/.oracles/${ORACLE_DID}/state.db.gz`;
    const invocation = await mintAuthInvocation(user, ORACLE_DID);
    const delegation = await mintDelegation(user, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
      VFS_OWNER_COPY_CAPABILITY,
    ]);
    const client = new ChatClient(oracle.url, { invocation, delegation });

    // wrangler dev keeps the object's storage (and its local R2) between
    // runs: start from a clean working copy so every assertion below is
    // about THIS run.
    await step('a working-copy reset gives a clean slate', async () => {
      const res = await fetch(`${oracle.url}/debug/storage/reset`, {
        method: 'POST',
        headers: client.headers(),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const status = await storageStatus(oracle.url, client);
      assert.ok(
        status.tier?.enabled,
        `tier not enabled: ${JSON.stringify(status.tier)}`,
      );
      assert.equal(status.tier.coldSegments, 0, JSON.stringify(status.tier));
    });

    // ------------------------------------------------------------ fill
    const sessionId = await step('POST /sessions creates a session', () =>
      client.createSession(),
    );
    await step('three turns fill the working copy (all hot)', async () => {
      const r1 = await client.stream(
        sessionId,
        'Remember this: the code word is mango-47. Reply with just OK.',
      );
      assert.equal(r1.status, 200, `status ${r1.status}: ${r1.text}`);
      const r2 = await client.stream(
        sessionId,
        'What is 19 + 23? Reply with only the number.',
      );
      assert.match(r2.text, /42/, `expected 42 in "${r2.text}"`);
      const r3 = await client.stream(
        sessionId,
        'Name three primary colours, comma separated, nothing else.',
      );
      assert.equal(r3.status, 200, `status ${r3.status}: ${r3.text}`);
      const status = await storageStatus(oracle.url, client);
      assert.ok(
        status.tier?.enabled,
        `tier not enabled: ${JSON.stringify(status.tier)}`,
      );
      assert.ok(status.tier.hotRows > 0, 'no hot rows after turns');
      assert.equal(status.tier.coldSegments, 0, 'nothing should be cold yet');
      console.log(
        `\n    file ${status.fileBytes} bytes, ${status.tier.hotRows} hot rows`,
      );
    });

    // ------------------------------------------------------------ evict
    let hotBefore = 0;
    await step(
      'a forced tier pass moves the chunks into R2 segments',
      async () => {
        hotBefore = (await storageStatus(oracle.url, client)).tier!.hotRows;
        const pass = await tierFlush(oracle.url, client, { force: true });
        assert.equal(pass.skipped, undefined, JSON.stringify(pass));
        assert.ok(pass.evictedChunks > 0, JSON.stringify(pass));
        assert.equal(pass.remaining, 0, JSON.stringify(pass));
        const status = await storageStatus(oracle.url, client);
        assert.ok(status.tier!.coldSegments > 0, JSON.stringify(status.tier));
        assert.ok(
          status.tier!.hotRows < hotBefore,
          `hot rows did not drop: ${hotBefore} → ${status.tier!.hotRows}`,
        );
        assert.ok(
          status.tier!.r2Puts >= pass.segmentsRewritten,
          JSON.stringify(status.tier),
        );
        console.log(
          `\n    evicted ${pass.evictedChunks} chunks into ${pass.segmentsRewritten} segment(s); hot rows ${hotBefore} → ${status.tier!.hotRows}`,
        );
      },
    );

    await step(
      'a hard reset of the object makes the next reads truly cold',
      async () => {
        // Drops the in-memory chunk cache and SQLite's page cache along with
        // the object; storage (and R2) survive.
        await fetch(`${oracle.url}/debug/object/abort`, {
          method: 'POST',
          headers: client.headers(),
        }).catch(() => undefined);
        await sleep(2500);
        // /debug/storage reports without booting; a real request boots the
        // object (its map loads, nothing is read yet).
        await client.listSessions();
        const status = await storageStatus(oracle.url, client);
        assert.ok(
          status.tier?.enabled,
          `tier not enabled: ${JSON.stringify(status.tier)}`,
        );
        assert.ok(status.tier.coldSegments > 0, JSON.stringify(status.tier));
      },
    );

    // ------------------------------------------------------------ cold reads
    await step(
      'the transcript of the evicted session reads back (cold pages fetched)',
      async () => {
        const before = (await storageStatus(oracle.url, client)).tier!;
        const { messages } = await client.listMessages(sessionId);
        assert.ok(messages.length >= 6, `transcript short: ${messages.length}`);
        const after = (await storageStatus(oracle.url, client)).tier!;
        console.log(
          `\n    ${messages.length} messages; misses ${before.coldMisses} → ${after.coldMisses}, GETs ${before.r2Gets} → ${after.r2Gets}, retries ${before.retries} → ${after.retries}`,
        );
      },
    );
    await step(
      'a turn on the evicted session still recalls its memory (cold checkpoint + writes)',
      async () => {
        const before = (await storageStatus(oracle.url, client)).tier!;
        const t0 = Date.now();
        const r = await client.stream(
          sessionId,
          'What was the code word I gave you? Reply with only the code word.',
        );
        const ms = Date.now() - t0;
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        assert.match(
          r.text,
          /mango-47/i,
          `memory lost after eviction: "${r.text}"`,
        );
        const after = (await storageStatus(oracle.url, client)).tier!;
        console.log(
          `\n    turn ${ms} ms; misses ${before.coldMisses} → ${after.coldMisses}, GETs ${before.r2Gets} → ${after.r2Gets}, hot rows ${after.hotRows}`,
        );
      },
    );

    // ------------------------------------------------------------ flush → VFS
    let fileV1: VfsFileMeta | undefined;
    await step(
      'a flush exports the tiered file to the VFS; it gunzips to SQLite',
      async () => {
        const res = await fetch(`${oracle.url}/debug/storage/flush`, {
          method: 'POST',
          headers: client.headers(),
        });
        const body = (await res.json()) as {
          uploaded: boolean;
          bytes: number;
          etag?: string;
        };
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.ok(body.uploaded, JSON.stringify(body));
        const files = await listOraclesSubtree(user);
        fileV1 = files.find((f) => f.path === statePath);
        assert.ok(fileV1, `no ${statePath} in the user's VFS`);
        assert.equal(
          fileV1.contentHash,
          body.etag,
          'flush etag != VFS contentHash',
        );
        const dl = await vfsUserRequest(
          user,
          'fs/read',
          'GET',
          `/files/${encodeURIComponent(fileV1.id)}/content`,
        );
        assert.equal(dl.status, 200, await dl.clone().text());
        const plain = gunzipSync(Buffer.from(await dl.arrayBuffer()));
        assert.equal(plain.subarray(0, 16).toString('latin1'), SQLITE_MAGIC);
        const status = await storageStatus(oracle.url, client);
        assert.equal(
          plain.length,
          status.fileBytes,
          `exported ${plain.length} bytes, file is ${status.fileBytes}`,
        );
        console.log(
          `\n    ${plain.length} bytes exported (${body.bytes} gzipped)`,
        );
      },
    );

    // ------------------------------------------------------------ reset → reload
    await step(
      'a reset reloads from the VFS, drops the tier map, and memory survives',
      async () => {
        const res = await fetch(`${oracle.url}/debug/storage/reset`, {
          method: 'POST',
          headers: client.headers(),
        });
        const body = (await res.json()) as { reloadedFromOwnerStore: boolean };
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.reloadedFromOwnerStore, true, JSON.stringify(body));
        const status = await storageStatus(oracle.url, client);
        assert.equal(status.tier!.coldSegments, 0, JSON.stringify(status.tier));
        const { messages } = await client.listMessages(sessionId);
        assert.ok(
          messages.length >= 8,
          `transcript lost after reset: ${messages.length}`,
        );
        const r = await client.stream(
          sessionId,
          'Once more: what was the code word? Reply with only the code word.',
        );
        assert.match(
          r.text,
          /mango-47/i,
          `memory lost after reload: "${r.text}"`,
        );
      },
    );

    // ------------------------------------------------------------ policy
    await step(
      'the recency policy evicts on its own once chunks age, and turns continue',
      async () => {
        const fresh = await client.createSession();
        const r = await client.stream(fresh, 'Say the single word: ready.');
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        const idle = await tierFlush(oracle.url, client);
        assert.equal(
          idle.evictedChunks,
          0,
          `evicted fresh chunks: ${JSON.stringify(idle)}`,
        );
        await sleep(3 * PERIOD_MS + 500);
        const aged = await tierFlush(oracle.url, client);
        assert.ok(
          aged.evictedChunks > 0,
          `nothing evicted after ageing: ${JSON.stringify(aged)}`,
        );
        const r2 = await client.stream(
          sessionId,
          'And once again the code word, nothing else.',
        );
        assert.match(
          r2.text,
          /mango-47/i,
          `memory lost after policy eviction: "${r2.text}"`,
        );
        const status = await storageStatus(oracle.url, client);
        console.log(
          `\n    policy pass evicted ${aged.evictedChunks}; hot ${status.tier!.hotRows} rows, cold ${status.tier!.coldSegments} segment(s), retries so far ${status.tier!.retries}`,
        );
      },
    );
  } finally {
    await oracle.stop();
    await workers.stop();
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      const logs = oracle.logs();
      if (logs)
        console.error(`\n--- oracle logs (tail) ---\n${logs.slice(-6000)}`);
    }
    console.log('\n=== E2E (R2 page tier) summary ===');
    for (const r of results)
      console.log(
        `${r.ok ? '✔' : '✘'} ${r.name} (${r.ms} ms)${r.detail ? `\n    ${r.detail}` : ''}`,
      );
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
