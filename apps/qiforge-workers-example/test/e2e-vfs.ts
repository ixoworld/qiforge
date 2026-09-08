/**
 * End-to-end test of the DEFAULT (VFS) owner-store path against the local ixo
 * harness — the storage design's make-or-break flow:
 *
 *   pnpm test:e2e:vfs
 *   VFS_WORKERS_ATTACH=1 pnpm test:e2e:vfs   # reuse already-running workers
 *
 * Boots the REAL ixo-virtual-filesystem + ixo-ucan-store-worker (host-side
 * wrangler dev via the harness runner `scripts/vfs-workers.sh`), then proves
 * with a real LLM (OpenRouter) and real UCAN auth against Blocksync:
 *
 *   1. the user deposits an `ixo:filesystem` delegation (audience = the
 *      oracle) into the UCAN store — the production onboarding step;
 *   2. a chat turn runs and `/debug/storage/flush` exports the working copy;
 *   3. the file EXISTS in the user's own VFS at
 *      `/.oracles/<oracleDid>/state.db.gz` — verified AS THE USER with their
 *      own key — and its gunzipped bytes are a SQLite database;
 *   4. a working-copy reset reloads FROM VFS and the memory survives;
 *   5. a follow-up flush UPDATES the same VFS file (version bump);
 *   6. nothing was written to Matrix for this user (no user↔oracle room);
 *   7. a user with NO deposited delegation still gets a working oracle
 *      (legacy/no-VFS boot path does not hard-fail).
 *
 * Requires: the testing harness up, plus local checkouts of the two workers
 * with `pnpm install` run (see `startVfsWorkers`). The Matrix-path e2e stays
 * in `test/e2e.ts`.
 */
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { ChatClient } from './lib/chat-client';
import {
  MATRIX_BASE_URL,
  depositVfsDelegation,
  ensureNamedAccount,
  mintAuthInvocation,
  mintDelegation,
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
    // Printed immediately (not only in the summary) so the reason survives
    // even if the process is torn down during cleanup.
    console.log(`FAILED (${Date.now() - start} ms)\n    ${detail}`);
    throw err;
  }
}

interface VfsFileMeta {
  id: string;
  path: string;
  size: number;
  version: number;
  contentHash: string;
  hidden: boolean;
}

/** The user's own view of their `/.oracles` subtree (self-signed fs/list). */
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

function didToAliasPart(did: string): string {
  return did.replace(/:/g, '-');
}

const SQLITE_MAGIC = 'SQLite format 3\0';

async function main(): Promise<void> {
  const workers = await startVfsWorkers();
  console.log(
    `vfs workers: ${workers.vfsUrl} (fs) + ${workers.ucanStoreUrl} (ucan store)`,
  );
  await provisionDevVars({ vfs: {} });
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url} (owner store: VFS default)`);
  try {
    // A dedicated user so this suite's storage assertions never entangle with
    // the Matrix-path e2e (alice) or the stress users.
    const user = await ensureNamedAccount('qf-vfs-user');
    const statePath = `/.oracles/${ORACLE_DID}/state.db.gz`;

    // ---------------------------------------------------------- onboarding
    await step(
      'user deposits the ixo:filesystem delegation into the UCAN store',
      async () => {
        const { cid } = await depositVfsDelegation(user, ORACLE_DID);
        assert.ok(cid.length > 0, 'delegation cid');
      },
    );

    // ---------------------------------------------------------- chat turn
    const invocation = await mintAuthInvocation(user, ORACLE_DID);
    const delegation = await mintDelegation(user, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
    ]);
    const client = new ChatClient(oracle.url, { invocation, delegation });

    const sessionId = await step('POST /sessions creates a session', () =>
      client.createSession(),
    );
    await step('streaming turn answers a question', async () => {
      const r = await client.stream(
        sessionId,
        'What is 19 + 23? Reply with only the number.',
      );
      assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
      assert.ok(
        r.events.at(-1)?.event === 'done',
        `last event ${r.events.at(-1)?.event}`,
      );
      assert.match(r.text, /42/, `expected 42 in "${r.text}"`);
    });

    // ---------------------------------------------------------- flush → VFS
    let flushedEtag = '';
    await step('POST /debug/storage/flush exports to the VFS', async () => {
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
      assert.ok(body.bytes > 0, JSON.stringify(body));
      flushedEtag = body.etag ?? '';
    });

    let fileV1: VfsFileMeta | undefined;
    await step(
      'state.db.gz EXISTS in the user VFS (verified as the user)',
      async () => {
        const files = await listOraclesSubtree(user);
        fileV1 = files.find((f) => f.path === statePath);
        assert.ok(
          fileV1,
          `no ${statePath} in the user's VFS; /.oracles holds: ${files
            .map((f) => f.path)
            .join(', ')}`,
        );
        assert.ok(fileV1.hidden, 'dot-folder file is flagged hidden');
        // The VFS contentHash is sha256(uploaded bytes) — exactly the etag
        // the oracle's flush reported. Proves the flush wrote THIS file.
        assert.equal(
          fileV1.contentHash,
          flushedEtag,
          `flush etag ${flushedEtag} != VFS contentHash ${fileV1.contentHash}`,
        );
      },
    );

    await step('downloaded bytes gunzip to a SQLite database', async () => {
      const res = await vfsUserRequest(
        user,
        'fs/read',
        'GET',
        `/files/${encodeURIComponent(fileV1!.id)}/content`,
      );
      assert.equal(res.status, 200, await res.clone().text());
      const gz = Buffer.from(await res.arrayBuffer());
      const plain = gunzipSync(gz);
      const header = plain.subarray(0, 16).toString('latin1');
      assert.equal(
        header,
        SQLITE_MAGIC,
        `expected SQLite header, got ${JSON.stringify(header)}`,
      );
      assert.ok(plain.length >= 4096, `sqlite file too small: ${plain.length}`);
    });

    // ---------------------------------------------------------- reset → reload
    await step(
      'after a working-copy reset the state is reloaded FROM VFS',
      async () => {
        const res = await fetch(`${oracle.url}/debug/storage/reset`, {
          method: 'POST',
          headers: client.headers(),
        });
        const body = (await res.json()) as { reloadedFromOwnerStore: boolean };
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.reloadedFromOwnerStore, true, JSON.stringify(body));
        const { messages } = await client.listMessages(sessionId);
        assert.ok(
          messages.length >= 2,
          `transcript lost after reset: ${messages.length}`,
        );
      },
    );
    await step('memory survives the reload from VFS', async () => {
      const r = await client.stream(
        sessionId,
        'What was the sum I asked you to compute earlier? Reply with only the number.',
      );
      assert.match(r.text, /42/, `memory lost after reset: "${r.text}"`);
    });

    // ---------------------------------------------------------- update path
    await step('a follow-up flush UPDATES the same VFS file', async () => {
      const res = await fetch(`${oracle.url}/debug/storage/flush`, {
        method: 'POST',
        headers: client.headers(),
      });
      const body = (await res.json()) as { uploaded: boolean; etag?: string };
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.ok(body.uploaded, JSON.stringify(body));
      const files = await listOraclesSubtree(user);
      const now = files.find((f) => f.path === statePath);
      assert.ok(now, 'state file vanished');
      assert.equal(now.id, fileV1!.id, 'flush must UPDATE, not re-create');
      assert.ok(
        now.version > fileV1!.version,
        `version did not bump: ${fileV1!.version} → ${now.version}`,
      );
      assert.equal(now.contentHash, body.etag, 'updated contentHash == etag');
    });

    // ---------------------------------------------------------- not in Matrix
    await step(
      'nothing landed in Matrix (no user↔oracle room exists)',
      async () => {
        const alias = `#${didToAliasPart(user.did)}_${didToAliasPart(ORACLE_DID)}:ixo.test`;
        const res = await fetch(
          `${MATRIX_BASE_URL}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
        );
        assert.equal(
          res.status,
          404,
          `user↔oracle room ${alias} exists — Matrix should be untouched on the VFS path`,
        );
      },
    );

    // ------------------------------------------------- no-delegation boot path
    await step(
      'a user with NO deposited delegation still gets a working oracle',
      async () => {
        const stranger = await ensureNamedAccount('qf-vfs-nodeleg');
        const inv = await mintAuthInvocation(stranger, ORACLE_DID);
        const del = await mintDelegation(stranger, ORACLE_DID, [
          { can: 'memory/*', with: 'ixo:memory' },
        ]);
        const strangerClient = new ChatClient(oracle.url, {
          invocation: inv,
          delegation: del,
        });
        const sid = await strangerClient.createSession();
        const r = await strangerClient.stream(
          sid,
          'Say the single word: ready',
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        assert.match(r.text, /ready/i, `expected "ready" in "${r.text}"`);
        // And their file must NOT appear in the VFS (nothing to write with).
        const files = await listOraclesSubtree(stranger);
        assert.equal(
          files.length,
          0,
          `unexpected VFS files for a no-delegation user: ${files
            .map((f) => f.path)
            .join(', ')}`,
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
    console.log('\n=== E2E (VFS owner store) summary ===');
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
