// Before/after timing of the R2 page tier on a DEPLOYED oracle. Run once
// against a build without `TIER_BUCKET` (LABEL=before) and once with it
// (LABEL=after); the script prints one table per run and a JSON line for
// diffing.
//
//   ACCOUNT=devnet-account LABEL=after [TURNS=5] [ORACLE_URL=…] \
//     pnpm exec tsx test/load/tier-devnet.mts
//
// What it measures, in order:
//   hot   — N small-prompt turns on a fresh session; GET /messages of the
//           account's longest session; a recall turn on that session.
//   evict — (tier only) POST /debug/storage/tier-flush {force:true}, then
//           POST /debug/object/abort so the object boots cold.
//   cold  — the same hot ops again, now against evicted chunks; the tier
//           counters (misses, GETs, retries) show what was fetched.
//   flush — POST /debug/storage/flush (export of the whole file).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChatClient } from '../lib/chat-client';
import {
  mintAuthInvocation,
  mintDelegation,
  VFS_OWNER_COPY_CAPABILITY,
  type HarnessAccount,
} from '../lib/harness';

const SP = fileURLToPath(new URL('../.devnet-accounts', import.meta.url));
const ORACLE_URL =
  process.env.ORACLE_URL ?? 'https://mike-devnet-oracle.ixo-api.workers.dev';
const ORACLE_DID =
  process.env.ORACLE_DID ??
  'did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3';
const ACCOUNT = process.env.ACCOUNT ?? 'devnet-account';
const LABEL = process.env.LABEL ?? 'run';
const TURNS = Number(process.env.TURNS ?? 5);

interface TierStatus {
  enabled: boolean;
  hotRows: number;
  hotBytes: number;
  coldSegments: number;
  coldBytes: number;
  r2Gets: number;
  r2Puts: number;
  coldMisses: number;
  missResolutions: number;
  retries: number;
  evictedChunks: number;
}
interface StorageStatus {
  fileBytes: number;
  instanceId?: string;
  tier?: TierStatus;
  chunkCache?: {
    rowsRead: number;
    rowsWritten: number;
    hits: number;
    misses: number;
  };
}
interface Row {
  op: string;
  ms: number;
  misses?: number;
  gets?: number;
  retries?: number;
  note?: string;
}

const a = JSON.parse(readFileSync(`${SP}/${ACCOUNT}.json`, 'utf8')) as Record<
  string,
  string
>;
const acct: HarnessAccount = {
  name: ACCOUNT,
  address: a.address!,
  did: a.did!,
  edSigningMnemonic: a.edSigningMnemonic!,
  matrixUserId: a.matrixUserId!,
  matrixPassword: a.matrixPassword!,
  matrixMnemonic: '',
};
const delegation = await mintDelegation(acct, ORACLE_DID, [
  { can: '*', with: 'ixo:oracle' },
  { can: '*', with: 'ixo:memory' },
  { can: '*', with: 'ixo:sandbox' },
  VFS_OWNER_COPY_CAPABILITY,
]);
/**
 * A client with a FRESH auth invocation. The shell caches a verdict per
 * token for at most three minutes and its replay store then refuses the
 * same token, so a long run must not reuse one invocation.
 */
async function fresh(): Promise<ChatClient> {
  const invocation = await mintAuthInvocation(acct, ORACLE_DID, 300);
  return new ChatClient(ORACLE_URL, { invocation, delegation });
}
let client = await fresh();
const rows: Row[] = [];

async function debug<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ORACLE_URL}${path}`, {
    method,
    headers: client.headers({ 'content-type': 'application/json' }),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T;
  if (res.status !== 200)
    throw new Error(
      `${method} ${path} → ${res.status}: ${JSON.stringify(json)}`,
    );
  return json;
}
const status = async (): Promise<StorageStatus> => {
  client = await fresh();
  return debug<StorageStatus>('/debug/storage');
};

async function timed<T>(
  op: string,
  fn: () => Promise<T>,
  note?: string,
): Promise<T> {
  client = await fresh();
  const before = (await status()).tier;
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  const after = (await status()).tier;
  const row: Row = { op, ms, ...(note && { note }) };
  if (before?.enabled && after?.enabled) {
    row.misses = after.coldMisses - before.coldMisses;
    row.gets = after.r2Gets - before.r2Gets;
    row.retries = after.retries - before.retries;
  }
  rows.push(row);
  console.log(
    `  ${op.padEnd(44)} ${String(ms).padStart(7)} ms${row.misses !== undefined ? `  misses=${row.misses} gets=${row.gets} retries=${row.retries}` : ''}${note ? `  (${note})` : ''}`,
  );
  return out;
}

/** The account's session with the most messages (transcript size = the "big op"). */
async function longestSession(): Promise<{
  sessionId: string;
  messages: number;
} | null> {
  const listed = (await client.listSessions()) as
    | { sessions?: Array<{ sessionId: string }> }
    | Array<{ sessionId: string }>;
  const sessions = Array.isArray(listed) ? listed : (listed.sessions ?? []);
  let best: { sessionId: string; messages: number } | null = null;
  for (const s of sessions.slice(0, 12)) {
    const { messages } = await client.listMessages(s.sessionId);
    if (!best || messages.length > best.messages)
      best = { sessionId: s.sessionId, messages: messages.length };
  }
  return best;
}

async function hotOps(
  phase: string,
  longest: { sessionId: string; messages: number } | null,
): Promise<void> {
  const fresh = await timed(`${phase}: POST /sessions`, () =>
    client.createSession(),
  );
  for (let i = 1; i <= TURNS; i++) {
    await timed(`${phase}: small turn ${i}/${TURNS}`, async () => {
      const r = await client.stream(
        fresh,
        `Reply with only the number ${i * 7}.`,
      );
      if (r.status !== 200) throw new Error(`turn ${i}: ${r.status} ${r.text}`);
      return r;
    });
  }
  if (longest) {
    await timed(
      `${phase}: GET /messages (${longest.messages} msgs)`,
      () => client.listMessages(longest.sessionId),
      'big read',
    );
    await timed(
      `${phase}: recall turn on the long session`,
      async () => {
        const r = await client.stream(
          longest.sessionId,
          'In one short sentence, what was this conversation about?',
        );
        if (r.status !== 200) throw new Error(`recall: ${r.status} ${r.text}`);
        return r;
      },
      'big turn',
    );
  }
}

console.log(`\n=== tier-devnet [${LABEL}] ${ORACLE_URL} as ${ACCOUNT} ===`);
if (process.env.FLUSH_ONLY) {
  // Dirty the file with one small turn, then measure the export alone: the
  // tier counters show how many segment GETs one flush of a cold file costs.
  const fresh = await client.createSession();
  const r = await client.stream(fresh, 'Reply with only the word: flush.');
  if (r.status !== 200) throw new Error(`turn: ${r.status} ${r.text}`);
  const before = await status();
  await timed('flush: POST /debug/storage/flush', () =>
    debug<{ uploaded: boolean; bytes: number; skipped?: string }>(
      '/debug/storage/flush',
      'POST',
    ),
  );
  const after = await status();
  console.log(
    `FLUSH ${JSON.stringify({ fileBytes: after.fileBytes, coldSegments: after.tier?.coldSegments ?? null, gets: (after.tier?.r2Gets ?? 0) - (before.tier?.r2Gets ?? 0), rows })}`,
  );
  process.exit(0);
}
if (process.env.STATUS_ONLY) {
  // Boot the object (list) and print the tier status, nothing else.
  await client.listSessions();
  const now = await status();
  console.log(
    `STATUS ${JSON.stringify({ fileBytes: now.fileBytes, tier: now.tier ?? null })}`,
  );
  process.exit(0);
}
// /debug/storage reports without booting the object: list first so the
// status below describes a booted working copy.
const longest = await longestSession();
const initial = await status();
console.log(
  `file ${(initial.fileBytes / 1024 / 1024).toFixed(1)} MB; tier ${initial.tier?.enabled ? `ON (hot ${initial.tier.hotRows} rows / ${(initial.tier.hotBytes / 1024 / 1024).toFixed(1)} MB, cold ${initial.tier.coldSegments} segments)` : 'off'}`,
);
if (longest)
  console.log(
    `longest session: ${longest.sessionId} (${longest.messages} messages)`,
  );

await hotOps('hot', longest);

if (initial.tier?.enabled) {
  const pass = await timed('evict: POST /debug/storage/tier-flush force', () =>
    debug<{
      evictedChunks: number;
      segmentsRewritten: number;
      hotRows: number;
      remaining: number;
    }>('/debug/storage/tier-flush', 'POST', { force: true }),
  );
  console.log(
    `  evicted ${pass.evictedChunks} chunks into ${pass.segmentsRewritten} segments; ${pass.hotRows} hot rows left; ${pass.remaining} pending`,
  );
  // Boot cold: the in-memory chunk cache and SQLite's page cache go with the object.
  await fetch(`${ORACLE_URL}/debug/object/abort`, {
    method: 'POST',
    headers: client.headers(),
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 3000));
  await hotOps('cold', longest);
} else {
  console.log('  (tier off: no evict/cold phase)');
}

await timed('flush: POST /debug/storage/flush', () =>
  debug<{ uploaded: boolean; bytes: number }>('/debug/storage/flush', 'POST'),
);
const final = await status();
console.log(
  `final: file ${(final.fileBytes / 1024 / 1024).toFixed(1)} MB; tier ${final.tier?.enabled ? `hot ${final.tier.hotRows} rows, cold ${final.tier.coldSegments} segments, total misses ${final.tier.coldMisses}, GETs ${final.tier.r2Gets}, PUTs ${final.tier.r2Puts}, retries ${final.tier.retries}` : 'off'}`,
);
console.log(
  `RESULT ${JSON.stringify({ label: LABEL, fileBytes: final.fileBytes, tier: final.tier ?? null, rows })}`,
);
