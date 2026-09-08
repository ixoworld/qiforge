/**
 * Node → Workers migration e2e: proves a user's sessions + chat memory created
 * on the NODE runtime migrate to the WORKERS runtime through the shared Matrix
 * media owner copy (`m.ixo.media_state[storageKey]`), for the SAME oracle DID.
 *
 *   pnpm exec tsx test/e2e-migration.ts
 *
 * Flow:
 *   1. provision SSSS + a megolm-backup secret on the oracle account (the
 *      production-onboarding step; without it the Node runtime never backs up
 *      its megolm keys and a new Workers device cannot decrypt the
 *      `m.ixo.media_upload` pointer events → zero sessions after migration)
 *   2. boot the Node oracle (qf-node-oracle) against the harness — it extracts
 *      the backup key from SSSS via MATRIX_RECOVERY_PHRASE, creates the
 *      server-side key backup, and uploads its room keys
 *   3. two users create a session and state a memorable fact
 *   4. wait until the megolm keys are on the server backup
 *   5. stop the Node oracle — its graceful shutdown uploads the DB to Matrix
 *   6. assert `m.ixo.media_state[storageKey]` now exists in each user's room
 *   7. boot the WORKERS oracle as the SAME oracle DID — its gateway logs in
 *      its own fresh device with the password, OWNER_STORE=matrix, unlocks
 *      SSSS with the same recovery phrase and restores the room keys from
 *      backup
 *   8. GET /sessions → the Node-created session id is present (migrated)
 *   9. a follow-up chat recalls the fact stated on the Node runtime
 *  10. the Workers oracle flushes its own copy back to Matrix (pointer
 *      rewritten with a Workers-sent event) and its room keys reach the backup
 *  11. token rotation: a second fresh Workers device still lists the sessions —
 *      i.e. what one Workers device wrote, the next can read
 *
 * Requires: the harness up, Redis on 6379, the qf-node-oracle account
 * (scratchpad/qf-node-oracle.txt) with its vault mnemonics, and rooms between
 * the two static users and the qf-node-oracle bot. The Node launcher script
 * must export MATRIX_RECOVERY_PHRASE equal to RECOVERY_PHRASE below and run
 * the app without a process wrapper (`node --import tsx src/main.ts`).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatClient } from './lib/chat-client';
import { provisionSSSS } from './lib/provision-ssss';
import {
  APPSERVICE_BOT,
  MATRIX_BASE_URL,
  MATRIX_SERVER_NAME,
  STATIC_ACCOUNTS,
  appserviceRequest,
  matrixLogin,
  matrixRequest,
  mintAuthInvocation,
  waitFor,
  type HarnessAccount,
} from './lib/harness';
import { APP_DIR } from './lib/oracle';

const SCRATCH =
  '/private/tmp/claude-501/-Users-michael-dev-ixo/95c7d059-eb21-4ef9-87f0-ccd4b0de3687/scratchpad';
const NODE_LAUNCHER = `${SCRATCH}/run-node-oracle.sh`;
const NODE_URL = 'http://localhost:34690';
const NODE_LOG_DUMP = `${SCRATCH}/e2e-migration-node.log`;
const WORKERS_PORT = 8787;
const WORKERS_URL = `http://127.0.0.1:${WORKERS_PORT}`;
// Must match `export MATRIX_RECOVERY_PHRASE=…` in the Node launcher script.
const RECOVERY_PHRASE = 'qiforge-harness-recovery-phrase-2026';
const OPEN_ROUTER_API_KEY = process.env.OPEN_ROUTER_API_KEY;
if (!OPEN_ROUTER_API_KEY)
  throw new Error('OPEN_ROUTER_API_KEY is required for test/e2e-migration.ts');

interface NodeOracle {
  did: string;
  address: string;
  rootMnemonic: string;
  edSigningMnemonic: string;
  pin: string;
  matrix: {
    userId: string;
    accessToken: string;
    password: string;
    roomId: string;
  };
}

function readNodeOracle(): NodeOracle {
  const raw = readFileSync(`${SCRATCH}/qf-node-oracle.txt`, 'utf8');
  return JSON.parse(raw.slice(raw.indexOf('{'))) as NodeOracle;
}

function storageKey(userDid: string, oracleDid: string): string {
  return createHash('sha256')
    .update(`checkpoint_${userDid}_${oracleDid}`)
    .digest('hex')
    .slice(0, 17);
}

function didPart(did: string): string {
  return did.replace(/:/g, '-');
}

/** The `m.ixo.media_state[storageKey].eventId` for this user↔oracle room, or null. */
async function mediaPointer(
  user: HarnessAccount,
  oracleDid: string,
): Promise<string | null> {
  const session = await matrixLogin(user.matrixUserId, user.matrixPassword);
  const key = storageKey(user.did, oracleDid);
  const aliasLocal = `${didPart(user.did)}_${didPart(oracleDid)}`;
  const dir = await matrixRequest<{ room_id: string }>(
    session,
    'GET',
    `/_matrix/client/v3/directory/room/${encodeURIComponent(`#${aliasLocal}:${MATRIX_SERVER_NAME}`)}`,
  );
  const state = await matrixRequest<{ eventId?: string }>(
    session,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(dir.room_id)}/state/m.ixo.media_state/${encodeURIComponent(key)}`,
  ).catch((): { eventId?: string } => ({}));
  return state.eventId ?? null;
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    results.push({ name, ok: true });
    console.log('ok');
    return out;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`FAILED\n    ${detail}`);
    throw err;
  }
}

async function ensureRoom(
  user: HarnessAccount,
  botUserId: string,
  oracleDid: string,
): Promise<string> {
  const aliasLocal = `${didPart(user.did)}_${didPart(oracleDid)}`;
  const alias = `#${aliasLocal}:${MATRIX_SERVER_NAME}`;
  const session = await matrixLogin(user.matrixUserId, user.matrixPassword);
  const dir = await fetch(
    `${MATRIX_BASE_URL}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
  );
  let roomId: string;
  if (dir.ok) {
    roomId = ((await dir.json()) as { room_id: string }).room_id;
    await matrixRequest(
      session,
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { user_id: botUserId },
    ).catch(() => undefined);
  } else {
    const room = await matrixRequest<{ room_id: string }>(
      session,
      'POST',
      '/_matrix/client/v3/createRoom',
      {
        preset: 'private_chat',
        name: `${user.name} ↔ migration oracle`,
        invite: [botUserId, APPSERVICE_BOT],
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      },
    );
    roomId = room.room_id;
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
  await waitFor(
    async () => {
      const members = await matrixRequest<{ joined: Record<string, unknown> }>(
        session,
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      );
      return botUserId in members.joined;
    },
    60_000,
    `bot join ${user.name}`,
  );
  const pl = await matrixRequest<{ users?: Record<string, number> }>(
    session,
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
  );
  if ((pl.users?.[botUserId] ?? 0) < 50) {
    await matrixRequest(
      session,
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
      { ...pl, users: { ...(pl.users ?? {}), [botUserId]: 50 } },
    );
  }
  return roomId;
}

interface Managed {
  child: ChildProcess;
  logs: () => string;
  /** Signal the whole process group (tsx spawns a grandchild that holds the app). */
  signalGroup: (signal: NodeJS.Signals) => void;
}

function spawnProcess(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Managed {
  let logs = '';
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
    detached: true, // new process group so we can signal the grandchild too
  });
  const onData = (d: Buffer): void => {
    logs += d.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal); // negative pid = process group
    } catch {
      child.kill(signal); // fall back to the direct child
    }
  };
  return { child, logs: () => logs, signalGroup };
}

async function main(): Promise<void> {
  const oracle = readNodeOracle();
  const botUserId = oracle.matrix.userId;
  const users = [STATIC_ACCOUNTS[0], STATIC_ACCOUNTS[1]] as HarnessAccount[];
  const facts = ['the Aegean Sea', 'the planet Neptune'];
  const sessionIds: string[] = [];
  /** Number of room keys in the oracle account's server-side key backup. */
  const backupCount = async (): Promise<number> => {
    const res = await fetch(
      `${MATRIX_BASE_URL}/_matrix/client/v3/room_keys/version`,
      { headers: { Authorization: `Bearer ${oracle.matrix.accessToken}` } },
    );
    if (!res.ok) return 0;
    return ((await res.json()) as { count?: number }).count ?? 0;
  };

  console.log(`migration test — oracle ${oracle.did}\n`);

  await step('ensure user↔oracle rooms exist', async () => {
    for (const user of users) await ensureRoom(user, botUserId, oracle.did);
  });

  await step(
    'SSSS + megolm-backup secret provisioned on the account',
    async () => {
      const { keyId, created } = await provisionSSSS({
        baseUrl: MATRIX_BASE_URL,
        accessToken: oracle.matrix.accessToken,
        userId: botUserId,
        recoveryPhrase: RECOVERY_PHRASE,
      });
      console.log(
        `\n    default key ${keyId}${created ? ' (created)' : ' (existing)'}`,
      );
    },
  );

  // ── Node runtime ──────────────────────────────────────────────────────────
  if (!existsSync(NODE_LAUNCHER))
    throw new Error(`${NODE_LAUNCHER} not found — run the Node harness setup`);
  const node = spawnProcess('bash', [NODE_LAUNCHER]);
  try {
    await step('Node oracle boots + loads signing key', async () => {
      await waitFor(
        async () => {
          if (node.child.exitCode !== null)
            throw new Error(`node exited:\n${node.logs().slice(-2000)}`);
          try {
            return (await fetch(`${NODE_URL}/health`)).ok;
          } catch {
            return false;
          }
        },
        180_000,
        'node /health',
      );
      await waitFor(
        async () => /UCAN signing mnemonic loaded/.test(node.logs()),
        60_000,
        'node signing key',
      );
    });

    await step('two users create a session + state a fact (Node)', async () => {
      for (let i = 0; i < users.length; i++) {
        const user = users[i]!;
        const client = new ChatClient(NODE_URL, {
          invocation: await mintAuthInvocation(user, oracle.did),
        });
        const sid = await client.createSession();
        sessionIds.push(sid);
        const r = await client.stream(
          sid,
          `Please remember this for later: my favourite thing is ${facts[i]}. Reply with exactly: NOTED`,
        );
        if (!/NOTED/i.test(r.text))
          throw new Error(`user ${i} no NOTED: "${r.text.slice(0, 200)}"`);
      }
    });

    await step('megolm keys are on the server key backup', async () => {
      // The Workers gateway can only decrypt the Node-sent media pointer
      // events after restoring these from backup — gate the shutdown on it.
      await waitFor(
        async () => (await backupCount()) >= 2,
        120_000,
        'server key backup count',
      );
    });
  } finally {
    // Graceful shutdown (SIGTERM → onModuleDestroy) uploads every user's DB to
    // Matrix media. The success signal is the media pointer appearing in the
    // rooms, not the exit code — so poll for that, then make sure the process
    // is actually gone before the Workers oracle reuses the bot device.
    await step('Node oracle shuts down + uploads DB to Matrix', async () => {
      // Signal the NestJS app process DIRECTLY by its command line: tsx runs
      // the app as a grandchild, and only that process holds the SIGTERM
      // graceful-shutdown handler (which uploads every cached user's DB).
      // The child-process handle / group signal does not reach it reliably.
      // A pointer may already exist from an earlier run, so the success
      // signal is each pointer CHANGING to the event this shutdown uploads —
      // not log lines (a fast exit can truncate buffered stdout).
      const before = new Map<string, string | null>();
      for (const user of users)
        before.set(user.name, await mediaPointer(user, oracle.did));
      // The launcher runs the app with NO process wrapper (`node --import
      // tsx`), so this signals exactly one process: the tsx CLI wrapper was
      // observed taking the app down mid-shutdown-upload.
      spawnSync('pkill', ['-TERM', '-f', 'src/main.ts']);
      try {
        await waitFor(
          async () => {
            for (const user of users) {
              const now = await mediaPointer(user, oracle.did);
              if (!now || now === before.get(user.name)) return false;
            }
            return true;
          },
          120_000,
          `node checkpoint upload (full Node log: ${NODE_LOG_DUMP})`,
        );
      } finally {
        // The in-memory log is the only record of what the shutdown did.
        writeFileSync(NODE_LOG_DUMP, node.logs());
      }
      spawnSync('pkill', ['-KILL', '-f', 'src/main.ts']);
      await waitFor(
        async () => node.child.exitCode !== null,
        10_000,
        'node process exit',
      ).catch(() => undefined);
    });
  }

  const nodePointers = new Map<string, string>();
  await step(
    'm.ixo.media_state[storageKey] exists in each user room',
    async () => {
      for (const user of users) {
        const pointer = await mediaPointer(user, oracle.did);
        if (!pointer)
          throw new Error(
            `no m.ixo.media_state[${storageKey(user.did, oracle.did)}] media pointer in ${user.name}'s room`,
          );
        nodePointers.set(user.name, pointer);
      }
    },
  );

  // ── Workers runtime (same oracle DID, legacy Matrix owner store) ────────────
  /**
   * Boot the Workers oracle as the qf-node-oracle. Its gateway logs in its own
   * device with the password (never the Node oracle's token: two clients on
   * one device clobber each other's one-time keys) and reads the historical
   * media events only via the room keys restored from the account backup.
   */
  const bootWorkers = async (label: string): Promise<Managed> => {
    rmSync(join(APP_DIR, '.wrangler', 'state'), {
      recursive: true,
      force: true,
    });
    writeFileSync(
      join(APP_DIR, '.dev.vars'),
      `# generated by test/e2e-migration.ts — qf-node-oracle identity, Matrix owner store\n` +
        Object.entries({
          ORACLE_NAME: 'QiForge Migration Oracle',
          ORACLE_DID: oracle.did,
          ORACLE_ENTITY_DID: oracle.did,
          NETWORK: 'devnet',
          BLOCKSYNC_GRAPHQL_URL: 'http://localhost:34582/graphql',
          MATRIX_BASE_URL,
          MATRIX_HOMESERVER_NAME: MATRIX_SERVER_NAME,
          MATRIX_ORACLE_ADMIN_USER_ID: botUserId,
          MATRIX_ORACLE_ADMIN_PASSWORD: oracle.matrix.password,
          MATRIX_ACCOUNT_ROOM_ID: oracle.matrix.roomId,
          MATRIX_VALUE_PIN: oracle.pin,
          MATRIX_RECOVERY_PHRASE: RECOVERY_PHRASE,
          OPEN_ROUTER_API_KEY,
          OWNER_STORE: 'matrix',
          ORACLE_SIGNING_MNEMONIC: oracle.edSigningMnemonic,
          LOG_LEVEL: 'info',
        })
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') +
        '\n',
    );
    const managed = spawnProcess(
      'pnpm',
      [
        'exec',
        'wrangler',
        'dev',
        '--port',
        String(WORKERS_PORT),
        '--ip',
        '127.0.0.1',
      ],
      { cwd: APP_DIR, env: { CI: '1', WRANGLER_SEND_METRICS: 'false' } },
    );
    try {
      await step(`Workers oracle boots (${label})`, async () => {
        await waitFor(
          async () => {
            if (managed.child.exitCode !== null)
              throw new Error(
                `workers exited:\n${managed.logs().slice(-2000)}`,
              );
            try {
              return (await fetch(`${WORKERS_URL}/health`)).ok;
            } catch {
              return false;
            }
          },
          120_000,
          'workers /health',
        );
      });
    } catch (err) {
      managed.signalGroup('SIGKILL');
      throw err;
    }
    return managed;
  };

  const stopWorkers = async (managed: Managed): Promise<void> => {
    managed.signalGroup('SIGTERM');
    await waitFor(
      async () => managed.child.exitCode !== null,
      15_000,
      'workers exit',
    ).catch(() => managed.signalGroup('SIGKILL'));
    // The port must be free before the next boot.
    await waitFor(
      async () => {
        try {
          await fetch(`${WORKERS_URL}/health`);
          return false;
        } catch {
          return true;
        }
      },
      15_000,
      'workers port released',
    ).catch(() => undefined);
  };

  const assertNodeSessionsVisible = async (): Promise<void> => {
    for (let i = 0; i < users.length; i++) {
      const user = users[i]!;
      const client = new ChatClient(WORKERS_URL, {
        invocation: await mintAuthInvocation(user, oracle.did),
      });
      const body = (await client.listSessions()) as {
        sessions: Array<{ sessionId: string }>;
      };
      const ids = body.sessions.map((s) => s.sessionId);
      if (!ids.includes(sessionIds[i]!))
        throw new Error(
          `user ${i}: Node session ${sessionIds[i]} not in Workers sessions [${ids.join(', ')}]`,
        );
    }
  };

  const backupBeforeWorkers = await backupCount();
  let workers = await bootWorkers('same DID, OWNER_STORE=matrix, device #1');
  try {
    await step(
      'sessions created on Node are visible on Workers',
      assertNodeSessionsVisible,
    );

    await step('chat memory from Node is recalled on Workers', async () => {
      for (let i = 0; i < users.length; i++) {
        const user = users[i]!;
        const client = new ChatClient(WORKERS_URL, {
          invocation: await mintAuthInvocation(user, oracle.did),
        });
        const r = await client.stream(
          sessionIds[i]!,
          'What was the favourite thing I asked you to remember? Reply with just that thing.',
        );
        const fact = facts[i]!;
        const needle = fact.split(' ').at(-1)!; // "Sea" / "Neptune"
        if (!new RegExp(needle, 'i').test(r.text))
          throw new Error(
            `user ${i}: expected "${fact}", got "${r.text.slice(0, 200)}"`,
          );
      }
    });

    await step(
      'Workers flushes its own owner copy to Matrix + backs up its room keys',
      async () => {
        // The recall turn dirtied the DB; the debounced (30 s) alarm exports
        // it, rewriting each user's media pointer with a Workers-sent event…
        await waitFor(
          async () => {
            for (const user of users) {
              const now = await mediaPointer(user, oracle.did);
              if (!now || now === nodePointers.get(user.name)) return false;
            }
            return true;
          },
          120_000,
          'workers owner-copy flush',
        );
        // …encrypted with a NEW megolm session that must reach the backup, or
        // no later device (token rotation, redeploy) could ever read the file.
        await waitFor(
          async () => (await backupCount()) > backupBeforeWorkers,
          60_000,
          'workers room keys in backup',
        );
      },
    );

    await step('Workers oracle stops for a token rotation', () =>
      stopWorkers(workers),
    );
    workers = await bootWorkers('rotated token, device #2');
    await step(
      'sessions still visible on a brand-new device (Workers-written copy readable)',
      assertNodeSessionsVisible,
    );
  } finally {
    workers.signalGroup('SIGTERM');
    await new Promise((res) => setTimeout(res, 2000));
    const failed = results.filter((r) => !r.ok);
    console.log('\n=== migration e2e summary ===');
    for (const r of results)
      console.log(
        `${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`,
      );
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
