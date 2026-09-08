// Stress test: every devnet-user-*.json account in test/.devnet-accounts hammering the same
// Worker script at the same time. Not a feature matrix — the question is "does anything crash or
// degrade", so it counts errors/status codes, watches /health under load and checks the objects after.
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  mintAuthInvocation,
  mintDelegation,
  depositVfsDelegation,
  type HarnessAccount,
} from '../lib/harness';
import { ChatClient } from '../lib/chat-client';
const ORACLE_URL =
  process.env.ORACLE_URL ?? 'https://mike-devnet-oracle.ixo-api.workers.dev';
const ORACLE_DID = 'did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3';
const UCAN_STORE =
  process.env.UCAN_STORE ?? 'https://devnet.store.ucan.ixo.earth';
const SP = fileURLToPath(new URL('../.devnet-accounts', import.meta.url));
const EXCLUDE = new Set((process.env.EXCLUDE_USERS ?? '6').split(',')); // user-6 stays ungranted for the 403 step
const TURNS = Number(process.env.TURNS ?? '4');
const BURSTS = Number(process.env.BURSTS ?? '3');
const SESSIONS_PER_USER = Number(process.env.SESSIONS_PER_USER ?? '5');
const PHASES = new Set((process.env.PHASES ?? '1,2,2b,3,4').split(','));
const pct = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))
  ] ?? 0;
const ms = (xs: number[]) =>
  `n=${xs.length} p50=${pct(xs, 50)} p95=${pct(xs, 95)} max=${pct(xs, 100)} ms`;

// The matrix runner's main account (devnet-account.json) is deliberately NOT
// included: its history stays clean for the feature matrix.
const files = [
  ...readdirSync(SP)
    .filter((f) => /^devnet-user-\d+\.json$/.test(f))
    .filter((f) => !EXCLUDE.has(f.match(/\d+/)![0]))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((f) => `${SP}/${f}`),
];
interface U {
  name: string;
  acct: HarnessAccount;
  inv: string;
  chat: ChatClient;
  sids: string[];
  lat: number[];
  statuses: Map<number, number>;
  errors: string[];
}
const users: U[] = [];
for (const [i, f] of files.entries()) {
  const a = JSON.parse(readFileSync(f, 'utf8'));
  const acct: HarnessAccount = {
    name: `u${i + 1}`,
    address: a.address,
    did: a.did,
    edSigningMnemonic: a.edSigningMnemonic,
    matrixUserId: a.matrixUserId,
    matrixPassword: a.matrixPassword,
    matrixMnemonic: '',
  };
  const inv = await mintAuthInvocation(acct, ORACLE_DID, 900);
  users.push({
    name: `u${i + 1}`,
    acct,
    inv,
    chat: new ChatClient(ORACLE_URL, { invocation: inv }),
    sids: [],
    lat: [],
    statuses: new Map(),
    errors: [],
  });
}
const hdr = (u: U) => ({
  Authorization: `Bearer ${u.inv}`,
  'X-Auth-Type': 'ucan',
});
const api = async (u: U, method: string, path: string, body?: unknown) => {
  const t = Date.now();
  const res = await fetch(`${ORACLE_URL}${path}`, {
    method,
    headers: {
      ...hdr(u),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  u.statuses.set(res.status, (u.statuses.get(res.status) ?? 0) + 1);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, ms: Date.now() - t };
};
const record = (
  u: U,
  label: string,
  status: number,
  text: string,
  ok: number[] = [200, 201],
) => {
  if (!ok.includes(status))
    u.errors.push(`${label}: ${status} ${text.slice(0, 100)}`);
};

// health poller (worker-level) while the load runs
const health: number[] = [];
let healthErrors = 0;
let polling = true;
const poller = (async () => {
  while (polling) {
    const t = Date.now();
    try {
      const r = await fetch(`${ORACLE_URL}/health`);
      if (!r.ok) healthErrors += 1;
      await r.text();
    } catch {
      healthErrors += 1;
    }
    health.push(Date.now() - t);
    await new Promise((r) => setTimeout(r, 2000));
  }
})();

console.log(
  `[stress] ${users.length} users in parallel (excluded: ${[...EXCLUDE].join(',')})`,
);
// ── prep: grants (parallel across users) ────────────────────────────────────
const t0 = Date.now();
await Promise.all(
  users.map(async (u) => {
    try {
      await depositVfsDelegation(u.acct, ORACLE_DID, UCAN_STORE);
      const raw = await mintDelegation(u.acct, ORACLE_DID, [
        { can: '*', with: 'ixo:oracle' },
        { can: '*', with: 'ixo:memory' },
        { can: '*', with: 'ixo:sandbox' },
        { can: '*', with: 'ixo:skills' },
      ]);
      const post = await api(u, 'POST', '/delegation', {
        raw,
        expiration: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      });
      record(u, 'delegation', post.status, post.text);
    } catch (e) {
      u.errors.push(`prep threw: ${(e as Error).message.slice(0, 120)}`);
    }
  }),
);
console.log(
  `  grants done in ${Math.round((Date.now() - t0) / 1000)} s; prep errors=${users.reduce((n, u) => n + u.errors.length, 0)}`,
);

// ── phase 1: everyone creates SESSIONS_PER_USER sessions at once ────────────
if (PHASES.has('1')) {
  console.log(
    `[stress] phase 1: ${users.length} × ${SESSIONS_PER_USER} session creates, all at once`,
  );
  const createLat: number[] = [];
  const t1 = Date.now();
  await Promise.all(
    users.map(async (u) => {
      for (let i = 0; i < SESSIONS_PER_USER; i++) {
        const c = await api(u, 'POST', '/sessions', {});
        createLat.push(c.ms);
        record(u, 'create', c.status, c.text, [201]);
        if (c.status === 201) u.sids.push(String(c.json.sessionId ?? ''));
      }
    }),
  );
  console.log(
    `  wall ${Math.round((Date.now() - t1) / 1000)} s; create ${ms(createLat)}`,
  );
} else {
  await Promise.all(
    users.map(async (u) => {
      const c = await api(u, 'POST', '/sessions', {});
      if (c.status === 201) u.sids.push(String(c.json.sessionId ?? ''));
    }),
  );
}

// ── phase 2: everyone runs TURNS turns in parallel (sequential per user) ─────
if (PHASES.has('2')) {
  console.log(
    `[stress] phase 2: ${users.length} users × ${TURNS} turns in parallel`,
  );
  const t2 = Date.now();
  await Promise.all(
    users.map(async (u) => {
      const sid = u.sids[0];
      if (!sid) {
        u.errors.push('no session');
        return;
      }
      for (let i = 0; i < TURNS; i++) {
        const t = Date.now();
        try {
          const r = await u.chat.send(
            sid,
            `Reply with "${u.name}-${i}" and nothing else.`,
          );
          u.statuses.set(r.status, (u.statuses.get(r.status) ?? 0) + 1);
          if (r.status !== 200)
            u.errors.push(
              `turn ${i}: ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`,
            );
        } catch (e) {
          u.errors.push(
            `turn ${i} threw: ${(e as Error).message.slice(0, 100)}`,
          );
        }
        u.lat.push(Date.now() - t);
      }
    }),
  );
  const all = users.flatMap((u) => u.lat);
  console.log(
    `  wall ${Math.round((Date.now() - t2) / 1000)} s; turns ${ms(all)}; errors=${users.reduce((n, u) => n + u.errors.length, 0)}`,
  );
}

// ── phase 2b: mixed — half create sessions while the other half message, all at once ─
if (PHASES.has('2b')) {
  console.log(
    `[stress] phase 2b: mixed — ${Math.ceil(users.length / 2)} users creating 3 sessions each while ${Math.floor(users.length / 2)} users run 3 turns each, simultaneously`,
  );
  {
    const creators = users.filter((_, i) => i % 2 === 0);
    const talkers = users.filter((_, i) => i % 2 === 1);
    const cLat: number[] = [];
    const tLat: number[] = [];
    const t = Date.now();
    await Promise.all([
      ...creators.map(async (u) => {
        for (let i = 0; i < 3; i++) {
          const c = await api(u, 'POST', '/sessions', {});
          cLat.push(c.ms);
          record(u, 'mixed-create', c.status, c.text, [201]);
          if (c.status === 201) u.sids.push(String(c.json.sessionId ?? ''));
        }
      }),
      ...talkers.map(async (u) => {
        const sid = u.sids[0];
        if (!sid) return;
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now();
          try {
            const r = await u.chat.send(
              sid,
              `Reply with "mixed-${i}" and nothing else.`,
            );
            u.statuses.set(r.status, (u.statuses.get(r.status) ?? 0) + 1);
            if (r.status !== 200) u.errors.push(`mixed turn ${i}: ${r.status}`);
          } catch (e) {
            u.errors.push(
              `mixed turn threw: ${(e as Error).message.slice(0, 80)}`,
            );
          }
          tLat.push(Date.now() - t0);
        }
      }),
    ]);
    console.log(
      `  wall ${Math.round((Date.now() - t) / 1000)} s; creates ${ms(cLat)}; turns ${ms(tLat)}`,
    );
  }
}

// ── phase 3: synchronized bursts, everyone on a different session each time ─
console.log(
  `[stress] phase 3: ${BURSTS} bursts of ${users.length} simultaneous turns`,
);
for (let b = 0; b < (PHASES.has('3') ? BURSTS : 0); b++) {
  const lat: number[] = [];
  let errs = 0;
  await Promise.all(
    users.map(async (u) => {
      const sid = u.sids[(b + 1) % Math.max(u.sids.length, 1)];
      if (!sid) return;
      const t = Date.now();
      try {
        const r = await u.chat.send(
          sid,
          `Reply with "burst-${b}" and nothing else.`,
        );
        u.statuses.set(r.status, (u.statuses.get(r.status) ?? 0) + 1);
        if (r.status !== 200) {
          errs += 1;
          u.errors.push(`burst ${b}: ${r.status}`);
        }
      } catch (e) {
        errs += 1;
        u.errors.push(`burst ${b} threw: ${(e as Error).message.slice(0, 80)}`);
      }
      lat.push(Date.now() - t);
    }),
  );
  console.log(`  burst ${b}: ${ms(lat)} errors=${errs}`);
}

// ── phase 4: mixed read load — lists + transcripts from everyone at once ────
console.log(
  `[stress] phase 4: reads (list + transcript) from everyone, 3 rounds`,
);
const readLat: number[] = [];
for (let r = 0; r < (PHASES.has('4') ? 3 : 0); r++) {
  await Promise.all(
    users.map(async (u) => {
      const l = await api(u, 'GET', '/sessions');
      readLat.push(l.ms);
      record(u, 'list', l.status, l.text, [200]);
      const sid = u.sids[0];
      if (!sid) return;
      const m = await api(u, 'GET', `/messages/${encodeURIComponent(sid)}`);
      readLat.push(m.ms);
      record(u, 'transcript', m.status, m.text, [200]);
    }),
  );
}
console.log(`  reads ${ms(readLat)}`);
polling = false;
await poller;
console.log(
  `[stress] /health during load: ${ms(health)} errors=${healthErrors}`,
);

// ── phase 5: objects after the storm ────────────────────────────────────────
const inst = new Set<string>();
let active = 0;
let pending = 0;
for (const u of users) {
  const st = await api(u, 'GET', '/debug/storage');
  inst.add(String(st.json.instanceId));
  active += Number(st.json.activeTurns ?? 0);
  pending += Number(st.json.pendingTimers ?? 0);
  if (Number(st.json.flushFailures ?? 0) > 0)
    u.errors.push(`flushFailures=${st.json.flushFailures}`);
}
console.log(
  `[stress] objects: distinct=${inst.size}/${users.length} activeTurns=${active} pendingTimers=${pending}`,
);
const codes = new Map<number, number>();
for (const u of users)
  for (const [k, v] of u.statuses) codes.set(k, (codes.get(k) ?? 0) + v);
console.log(
  `[stress] status codes: ${[...codes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}×${v}`)
    .join(' ')}`,
);
for (const u of users)
  if (u.errors.length)
    console.log(
      `  ${u.name}: ${u.errors.slice(0, 3).join(' | ')}${u.errors.length > 3 ? ` (+${u.errors.length - 3})` : ''}`,
    );
const totalErrors = users.reduce((n, u) => n + u.errors.length, 0);
console.log(
  `[stress] DONE users=${users.length} errors=${totalErrors} healthErrors=${healthErrors}`,
);
process.exit(totalErrors || healthErrors ? 1 : 0);
