import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mintAuthInvocation, type HarnessAccount } from '../lib/harness';
const SP = fileURLToPath(new URL('../.devnet-accounts', import.meta.url));
const src = readFileSync(`${SP}/stress-users.mts`, 'utf8');
const ORACLE_DID = /const ORACLE_DID = ['"`]([^'"`]+)/.exec(src)![1]!;
const ORACLE_URL =
  /const ORACLE_URL = (?:process\.env\.ORACLE_URL \?\? )?['"`]([^'"`]+)/.exec(
    src,
  )![1]!;
const a = JSON.parse(readFileSync(`${SP}/devnet-user-2.json`, 'utf8'));
const acct: HarnessAccount = {
  name: 'u1',
  address: a.address,
  did: a.did,
  edSigningMnemonic: a.edSigningMnemonic,
  matrixUserId: a.matrixUserId,
  matrixPassword: a.matrixPassword,
  matrixMnemonic: '',
};
const inv = await mintAuthInvocation(acct, ORACLE_DID, 300);
const res = await fetch(`${ORACLE_URL}/debug/matrix/outbox`, {
  headers: { Authorization: `Bearer ${inv}`, 'X-Auth-Type': 'ucan' },
});
const text = await res.text();
if (!res.ok) {
  console.log('status', res.status, text.slice(0, 300));
  process.exit(1);
}
const rows = (JSON.parse(text) as { rows: Array<Record<string, unknown>> })
  .rows;
console.log(
  'rows',
  rows.length,
  'attempts histogram',
  rows.reduce<Record<string, number>>((h, r) => {
    const k = String(r.attempts);
    h[k] = (h[k] ?? 0) + 1;
    return h;
  }, {}),
);
for (const r of rows.slice(0, 6)) console.log(JSON.stringify(r));
const withThread = rows.filter((r) => r.threadId).length;
console.log(
  'withThread',
  withThread,
  'html',
  rows.filter((r) => Number(r.htmlChars) > 0).length,
  'kinds',
  [...new Set(rows.map((r) => r.kind))],
  'priorities',
  [...new Set(rows.map((r) => r.priority))],
);
