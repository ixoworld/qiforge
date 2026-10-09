import { env, runInDurableObject } from 'cloudflare:test';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import {
  bytesOfStream,
  streamOfBytes,
  type FileSnapshot,
  type OwnerCopy,
  type OwnerStore,
} from '../owner-store/types';
import { DoSqliteDatabase } from '../sqlite/database';
import { SqliteSaver } from '../sqlite/sqlite-saver';
import { createUserOracleDO } from './user-oracle-do';
import { MigratingOwnerStore } from '../owner-store/migrating-store';
import {
  VfsNoDelegationError,
  VfsRequestError,
} from '../owner-store/ixo-vfs-store';
import {
  createDelegation,
  generateKeypair,
  serializeDelegation,
} from '@ixo/ucan';
import {
  CHANNEL_DELEGATION_MIN_REMAINING_SECONDS,
  type ChannelTurnInput,
} from '../channels/contract';

import type { SqliteTestDO } from '../sqlite/test-do';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { turnLimitsFromEnv } from '../core/turn-budget';
import { SessionsStore, UNTITLED_SESSION } from '../sqlite/sessions-store';
import { RunCoordinator, type LiveRun } from './run-coordinator';
import { RunStore } from './run-store';
import { DEFAULT_MODEL_ID, OPENROUTER_MODEL_MAP } from '../core/llm';
import { renderTurnTimeNote } from '../core/prompt-composer';
import { TURN_TIME_NOTE_KWARG } from '../core/turn-time-note';
import { RunBuffer } from './run-buffer';
import { storedRunRequest } from './run-request';
import type { TurnRequest } from './contracts';
import { installTimerTracker, pendingTimers } from './debug-timers';
/**
 * The user object's lifecycle over a real Durable Object's storage: boot and
 * import, the owner-copy flush, alarm multiplexing, idle eviction (with and
 * without the R2 page tier), and what a request or a turn costs in storage
 * operations. A real `UserOracleDO` instance runs over a real wa-sqlite
 * working copy; the gateway and the owner store are in-memory fakes and the
 * alarm is held in memory (the host test object has no alarm handler).
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
      TIER_TEST: R2Bucket;
    }
  }
}

const USER_DID = 'did:ixo:lifecycle';
const DAY_MS = 24 * 60 * 60_000;

/** The user's file upstream, as a VFS would hold it. */
function fakeOwnerStore(
  opts: { legacy?: () => Promise<OwnerCopy | null> } = {},
) {
  const upstream: { file: Uint8Array | null; etag: string; saves: number } = {
    file: null,
    etag: 'etag-0',
    saves: 0,
  };
  const store = {
    kind: 'vfs' as const,
    upstream,
    load: vi.fn(
      async (): Promise<OwnerCopy | null> =>
        upstream.file
          ? { stream: streamOfBytes(upstream.file), etag: upstream.etag }
          : null,
    ),
    head: vi.fn(
      async (): Promise<{ etag: string } | null> =>
        upstream.file ? { etag: upstream.etag } : null,
    ),
    save: vi.fn(async (snapshot: FileSnapshot) => {
      upstream.file = await bytesOfStream(snapshot.open());
      upstream.saves += 1;
      upstream.etag = `etag-${upstream.saves}`;
      return { etag: upstream.etag, bytes: upstream.file.byteLength };
    }),
    remove: vi.fn(async () => {
      upstream.file = null;
    }),
    ...(opts.legacy
      ? {
          loadLegacy: vi.fn(opts.legacy),
          removeLegacyCopy: vi.fn(async (_etag: string) => true),
        }
      : {}),
  } satisfies OwnerStore & Record<string, unknown>;
  return store;
}

type FakeOwnerStore = ReturnType<typeof fakeOwnerStore>;

function fakeGateway() {
  return {
    ensureStarted: vi.fn(async () => ({})),
    getOracleSigningMnemonic: vi.fn(async () => null),
    getOracleSecretsKey: vi.fn(async () => null),
    resolveUserRoom: vi.fn(async () => null),
    getRoomStateEvent: vi.fn(async () => null),
    sendText: vi.fn(async () => '$event'),
    sendEvent: vi.fn(async () => '$event'),
    /** Media that never finishes arriving. */
    downloadMxcMediaStream: vi.fn(
      async (_mxc: string, _opts?: { timeoutMs?: number }) =>
        new ReadableStream<Uint8Array>({ pull: () => undefined }),
    ),
    downloadEventMediaStream: vi.fn(
      async (
        _roomId: string,
        _eventId: string,
        _opts?: { timeoutMs?: number },
      ): Promise<{ stream: ReadableStream<Uint8Array> } | null> => null,
    ),
  };
}

interface HarnessOptions {
  env?: Record<string, unknown>;
  plugins?: OraclePlugin[];
  store?: FakeOwnerStore;
  /** What the object boots from instead of `store` (a store composed of fakes). */
  ownerStore?: OwnerStore;
}

/**
 * Storage with the alarm kept in memory: the host test object has no alarm
 * handler, and a test asserts on the alarm rather than letting it fire.
 */
function storageWithMemoryAlarm(storage: DurableObjectStorage) {
  let alarm: number | null = null;
  const alarms = {
    /** The platform consumes the alarm as it fires. */
    consumeAlarm: (): void => {
      alarm = null;
    },
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (at: number | Date): Promise<void> => {
      alarm = typeof at === 'number' ? at : at.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    },
  };
  return new Proxy(storage, {
    get(target, property) {
      if (property in alarms) return Reflect.get(alarms, property);
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function userObjectHarness(
  state: DurableObjectState,
  opts: HarnessOptions = {},
) {
  const core = createRuntimeCore({
    config: { name: 'Test' },
    env: makeEnv(),
    plugins: opts.plugins ?? [],
  });
  const store = opts.store ?? fakeOwnerStore();
  const gateway = fakeGateway();
  const sockets: unknown[] = [];
  const background: Promise<unknown>[] = [];
  const ctx = {
    id: state.id,
    storage: storageWithMemoryAlarm(state.storage),
    getWebSockets: () => sockets,
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
    abort: (reason?: string) => state.abort(reason),
  };
  const workerEnv = makeEnv({
    BLOCKSYNC_GRAPHQL_URL: '',
    ORACLE_SIGNING_MNEMONIC: '',
    ...opts.env,
  });
  const Oracle = createUserOracleDO({ core: () => core });

  /** A new in-memory instance over the same storage (an unload in between). */
  const instance = (): object => {
    const host: object = Reflect.construct(Oracle, [state, workerEnv]);
    // The object reaches its state through `ctx`: the memory alarm and the
    // test's socket list stand in for the platform's.
    Object.defineProperty(host, 'ctx', { value: ctx });
    Object.defineProperty(host, 'gateway', { get: () => gateway });
    Object.assign(host, {
      createOwnerStore: async () => opts.ownerStore ?? store,
    });
    return host;
  };

  let host = instance();

  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const method: unknown = Reflect.get(host, name);
    if (typeof method !== 'function')
      throw new Error(`Missing host method ${name}`);
    return Reflect.apply(method, host, args);
  };
  const field = (name: string): unknown => Reflect.get(host, name);
  const db = (): DoSqliteDatabase | null => {
    const value = field('db');
    return value instanceof DoSqliteDatabase ? value : null;
  };
  const saver = (): SqliteSaver => {
    const value = field('saver');
    if (!(value instanceof SqliteSaver)) throw new Error('not booted');
    return value;
  };

  return {
    core,
    store,
    gateway,
    sockets,
    ctx,
    storage: ctx.storage,
    get host(): object {
      return host;
    },
    call,
    field,
    db,
    saver,
    /** The alarm fires: consumed, then the handler runs. */
    async fireAlarm(): Promise<void> {
      Reflect.get(ctx.storage, 'consumeAlarm')();
      await call('alarm');
    },
    /** A request from the user (records access). */
    ready: () => call('ready', { userDid: USER_DID }),
    /** Commit one checkpoint, the way a turn's graph step does. */
    async writeTurn(sessionId = 'session'): Promise<void> {
      await saver().put(
        { configurable: { thread_id: sessionId, checkpoint_ns: '' } },
        emptyCheckpoint(),
        { source: 'update', step: 1, parents: {} },
      );
    },
    /** Every `ctx.waitUntil` handed over so far, settled. */
    async settle(): Promise<void> {
      while (background.length > 0)
        await Promise.allSettled(background.splice(0));
    },
    /** Unload: close the working copy and start a fresh instance. */
    async restart(): Promise<object> {
      await db()?.close();
      host = instance();
      return host;
    },
    async close(): Promise<void> {
      await Promise.allSettled(background.splice(0));
      await db()?.close();
    },
  };
}

type UserObjectHarness = ReturnType<typeof userObjectHarness>;

async function withObject(
  name: string,
  opts: HarnessOptions,
  body: (h: UserObjectHarness) => Promise<void>,
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const h = userObjectHarness(state, opts);
    try {
      await body(h);
    } finally {
      await h.close();
    }
  });
}

/** Boot, commit one turn and upload it: a clean copy the owner store verifiably holds. */
async function verifiedCopy(h: UserObjectHarness): Promise<void> {
  await h.ready();
  await h.writeTurn();
  // The first ticks of a new object finish its blob compaction.
  while (await h.call('compactionTick', h.db()));
  await h.call('markDirty');
  await h.call('flushToOwnerStore');
  expect(h.field('dirty')).toBe(false);
}

/** An open browser tab: a hibernated socket and the heartbeat it needs. */
function attachSocket(h: UserObjectHarness, pingInMs = 180_000) {
  h.sockets.push({});
  const realtime = {
    pingTick: vi.fn(() => Date.now() + pingInMs),
    nextPingAt: vi.fn(() => Date.now() + pingInMs),
    frontend: undefined,
  };
  Object.defineProperty(h.host, 'realtime', { get: () => realtime });
  return realtime;
}

/** Replace one method of `target` by a recording wrapper around it. */
function recordCalls(target: unknown, name: string): unknown[][] {
  if (typeof target !== 'object' || target === null)
    throw new Error(`no object to record ${name} on`);
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== 'function') throw new Error(`no method ${name}`);
  const calls: unknown[][] = [];
  Reflect.set(target, name, (...args: unknown[]) => {
    calls.push(args);
    return Reflect.apply(original, target, args);
  });
  return calls;
}

/** The `requestAlarm` hook a component received from the object. */
function armHook(component: unknown): (at: number) => unknown {
  if (typeof component !== 'object' || component === null)
    throw new Error('component not built');
  const host: unknown = Reflect.get(component, 'host');
  const hook: unknown =
    typeof host === 'object' && host !== null
      ? Reflect.get(host, 'requestAlarm')
      : undefined;
  if (typeof hook !== 'function') throw new Error('no requestAlarm hook');
  return (at: number) => Reflect.apply(hook, host, [at]);
}

async function fileSizeOnDisk(h: UserObjectHarness): Promise<number> {
  const db = await DoSqliteDatabase.open(h.ctx, 'oracle.db');
  try {
    return db.fileSize;
  } finally {
    await db.close();
  }
}

describe('idle eviction', () => {
  it('wipes a cold, clean, verified copy whose last request is six days old', async () => {
    await withObject('idle-six-days', {}, async (h) => {
      await verifiedCopy(h);
      await h.restart();
      const aged = Date.now() - 6 * DAY_MS;
      await h.storage.put('meta:lastAccessAt', aged);

      await h.fireAlarm();

      expect(h.db()).toBeNull();
      expect(await fileSizeOnDisk(h)).toBe(0);
      expect(await h.storage.get('meta:ownerEtag')).toBeUndefined();
      expect(await h.storage.getAlarm()).toBeNull();
      // The alarm's own boot is not a request.
      expect(await h.storage.get('meta:lastAccessAt')).toBe(aged);
      // Nothing new was uploaded: the copy was already verified.
      expect(h.store.save).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps a copy whose last request is four days old and re-arms for the horizon', async () => {
    await withObject('idle-four-days', {}, async (h) => {
      await verifiedCopy(h);
      await h.restart();
      const aged = Date.now() - 4 * DAY_MS;
      await h.storage.put('meta:lastAccessAt', aged);

      await h.fireAlarm();

      expect(h.db()).not.toBeNull();
      expect(await h.storage.get('meta:lastAccessAt')).toBe(aged);
      const alarm = await h.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now() + 4 * DAY_MS);
      expect(await h.storage.get('meta:housekeepingAt')).toBe(alarm);
    });
  });

  it('keeps a copy a request reached in between, even before that access was persisted', async () => {
    await withObject('idle-request-between', {}, async (h) => {
      await verifiedCopy(h);
      await h.restart();
      await h.ready();
      // The hourly throttle has not written this request yet: storage
      // still says six days (written by this instance an hour or more ago).
      const aged = Date.now() - 6 * DAY_MS;
      await h.storage.put('meta:lastAccessAt', aged);
      Reflect.set(h.host, 'persistedAccessAt', aged);

      await h.fireAlarm();

      expect(h.db()).not.toBeNull();
      expect(await fileSizeOnDisk(h)).toBeGreaterThan(0);
      // The tick stored what this instance saw before deciding on it.
      const stored = await h.storage.get<number>('meta:lastAccessAt');
      expect(stored).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  it('wipes an idle tiered copy and its R2 prefix although a tier pass is pending', async () => {
    await withObject(
      'idle-tiered',
      { env: { TIER_BUCKET: env.TIER_TEST } },
      async (h) => {
        await verifiedCopy(h);
        expect(h.db()?.tierEnabled).toBe(true);
        await h.restart();
        await h.storage.put('meta:lastAccessAt', Date.now() - 6 * DAY_MS);

        await h.fireAlarm();

        expect(h.db()).toBeNull();
        expect(await h.storage.getAlarm()).toBeNull();
        const left = await env.TIER_TEST.list({
          prefix: h.ctx.id.toString(),
        });
        expect(left.objects).toEqual([]);
      },
    );
  });

  it('flushes a dirty idle copy before the wipe', async () => {
    await withObject('idle-dirty', {}, async (h) => {
      await verifiedCopy(h);
      await h.writeTurn('second');
      await h.call('markDirty');
      await h.restart();
      await h.storage.put('meta:lastAccessAt', Date.now() - 6 * DAY_MS);

      await h.fireAlarm();

      // The unflushed turn went up first; the copy stays until the next
      // tick verifies the upload.
      expect(h.store.save).toHaveBeenCalledTimes(2);
      expect(await h.storage.get('meta:dirty')).toBeUndefined();
    });
  });
});

describe('alarm multiplexing with a socket attached', () => {
  it('a heartbeat-only wake of a cold object re-arms at the ping without booting', async () => {
    await withObject('fast-path-cold', {}, async (h) => {
      await verifiedCopy(h);
      await h.restart();
      const realtime = attachSocket(h);
      await h.storage.put('meta:housekeepingAt', Date.now() + DAY_MS);

      await h.fireAlarm();

      expect(realtime.pingTick).toHaveBeenCalledTimes(1);
      expect(h.db()).toBeNull();
      const alarm = await h.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now() + 170_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 180_000);
    });
  });

  it('a task armed after the last full tick runs at its time', async () => {
    await withObject('fast-path-task', {}, async (h) => {
      await verifiedCopy(h);
      attachSocket(h);
      await h.storage.put('meta:housekeepingAt', Date.now() + 5 * DAY_MS);
      const scheduler = h.field('taskScheduler');
      const ticks = recordCalls(scheduler, 'onAlarm');

      await armHook(scheduler)(Date.now() + 500);
      expect(
        await h.storage.get<number>('meta:housekeepingAt'),
      ).toBeLessThanOrEqual(Date.now() + 500);
      await h.fireAlarm();

      expect(ticks).toHaveLength(1);
    });
  });

  it('a flush retry armed after the last full tick uploads at its time', async () => {
    await withObject('fast-path-flush-retry', {}, async (h) => {
      await verifiedCopy(h);
      attachSocket(h);
      await h.writeTurn('second');
      await h.call('markDirty');
      await h.storage.put('meta:housekeepingAt', Date.now() + 5 * DAY_MS);

      await h.call('scheduleFlushRetry', Date.now() + 300);
      await h.fireAlarm();

      expect(h.store.save).toHaveBeenCalledTimes(2);
      expect(h.field('dirty')).toBe(false);
    });
  });

  it('a run keep-alive armed before a reset boots the next instance to recover', async () => {
    await withObject('fast-path-recovery', {}, async (h) => {
      await verifiedCopy(h);
      await h.storage.put('meta:housekeepingAt', Date.now() + 5 * DAY_MS);
      await armHook(h.field('runs'))(Date.now() + 300);
      await h.settle();
      await h.restart();
      attachSocket(h);

      await h.fireAlarm();

      expect(h.db()).not.toBeNull();
    });
  });

  it('a deadline armed while a full tick runs is not overwritten by its housekeeping write', async () => {
    await withObject('tick-floor', {}, async (h) => {
      await verifiedCopy(h);
      attachSocket(h);
      const scheduler = h.field('taskScheduler');
      const arm = armHook(scheduler);
      Reflect.set(scheduler as object, 'onAlarm', async () => {
        await arm(Date.now() + 400);
        return null;
      });
      Reflect.set(scheduler as object, 'nextWakeAt', async () => null);
      await h.storage.put('meta:housekeepingAt', Date.now());

      await h.fireAlarm();

      expect(
        await h.storage.get<number>('meta:housekeepingAt'),
      ).toBeLessThanOrEqual(Date.now() + 400);
      expect(await h.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 400);
    });
  });
});

describe('boot', () => {
  it('skips the whole-file hash when no legacy copy can be left to remove', async () => {
    const legacyStore = fakeOwnerStore({ legacy: async () => null });
    await withObject('boot-no-hash', { store: legacyStore }, async (h) => {
      await verifiedCopy(h);
      // The upload removed the legacy copy. A user whose removal failed
      // then (a gateway outage) still has one to remove:
      expect(legacyStore.removeLegacyCopy).toHaveBeenCalledTimes(1);
      await h.storage.delete('meta:legacyCleared');
      const checksum = vi.spyOn(DoSqliteDatabase.prototype, 'checksum');
      const reads = vi.spyOn(DoSqliteDatabase.prototype, 'get');
      try {
        // A legacy copy may still exist: verified once, then removed.
        await h.restart();
        await h.ready();
        expect(checksum).toHaveBeenCalledTimes(1);
        expect(legacyStore.removeLegacyCopy).toHaveBeenCalledTimes(2);
        expect(await h.storage.get('meta:legacyCleared')).toBe(true);

        checksum.mockClear();
        reads.mockClear();
        await h.restart();
        await h.ready();
        expect(checksum).not.toHaveBeenCalled();
        // One existence query for "does the copy hold turns", no counts.
        const turnQueries = reads.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.includes('FROM checkpoints'));
        expect(turnQueries).toEqual([
          'SELECT 1 AS one FROM checkpoints LIMIT 1',
        ]);
      } finally {
        checksum.mockRestore();
        reads.mockRestore();
      }
    });
  });

  it('never hashes on boot for a store without a legacy source', async () => {
    await withObject('boot-no-legacy-source', {}, async (h) => {
      await verifiedCopy(h);
      const checksum = vi.spyOn(DoSqliteDatabase.prototype, 'checksum');
      try {
        await h.restart();
        await h.ready();
        expect(checksum).not.toHaveBeenCalled();
      } finally {
        checksum.mockRestore();
      }
    });
  });

  it('keeps unflushed local turns when the upstream file changed', async () => {
    await withObject('boot-etag-dirty', {}, async (h) => {
      await verifiedCopy(h);
      await h.writeTurn('unsaved');
      await h.call('markDirty');
      await h.restart();
      h.store.load.mockClear();
      h.store.upstream.etag = 'etag-replaced-upstream';

      await h.ready();

      expect(h.store.load).not.toHaveBeenCalled();
      expect(h.field('dirty')).toBe(true);
      expect(await h.storage.get('meta:dirty')).toBe(true);
      const unsaved = await h.saver().getTuple({
        configurable: { thread_id: 'unsaved', checkpoint_ns: '' },
      });
      expect(unsaved).toBeDefined();
    });
  });

  it('keeps a turn that ended without its dirty mark when the upstream file changed', async () => {
    await withObject('boot-etag-unmarked', {}, async (h) => {
      await verifiedCopy(h);
      // A turn that died mid-way: checkpoints committed, no mark.
      await h.writeTurn('unmarked');
      await h.restart();
      h.store.load.mockClear();
      h.store.upstream.etag = 'etag-replaced-upstream';

      await h.ready();

      expect(h.store.load).not.toHaveBeenCalled();
      expect(h.field('dirty')).toBe(true);
    });
  });

  it('re-imports a changed upstream file over a clean copy', async () => {
    await withObject('boot-etag-clean', {}, async (h) => {
      await verifiedCopy(h);
      await h.restart();
      h.store.load.mockClear();
      h.store.upstream.etag = 'etag-replaced-upstream';

      await h.ready();

      expect(h.store.load).toHaveBeenCalledTimes(1);
      expect(h.field('reloadedFromOwnerStore')).toBe(true);
      expect(await h.storage.get('meta:ownerEtag')).toBe(
        'etag-replaced-upstream',
      );
    });
  });

  it('a boot that fails after opening the database leaves one connection and a re-bootable object', async () => {
    await withObject('boot-fails-after-open', {}, async (h) => {
      await verifiedCopy(h);
      const openFiles = h.db()?.vfsStats().openFiles;
      await h.restart();
      const warm = vi
        .spyOn(h.core, 'warm')
        .mockRejectedValueOnce(new Error('getTools failed'));

      await expect(h.ready()).rejects.toThrow('getTools failed');
      expect(h.db()).toBeNull();
      expect(h.field('taskScheduler')).toBeNull();

      await h.ready();
      expect(warm).toHaveBeenCalledTimes(2);
      expect(h.db()?.vfsStats().openFiles).toBe(openFiles);
    });
  });

  it('an alarm whose boot failed after opening the database boots again on the retry', async () => {
    await withObject('boot-fails-alarm', {}, async (h) => {
      await verifiedCopy(h);
      await h.restart();
      vi.spyOn(h.core, 'warm').mockRejectedValueOnce(
        new Error('getTools failed'),
      );

      await h.fireAlarm();
      expect(h.db()).toBeNull();
      const retry = await h.storage.getAlarm();
      expect(retry).toBeGreaterThan(Date.now() + 50_000);
      expect(retry).toBeLessThanOrEqual(Date.now() + 60_000);

      await h.fireAlarm();
      expect(h.db()).not.toBeNull();
      expect(h.field('taskScheduler')).not.toBeNull();
    });
  });

  it('refuses to start empty when the owner copy cannot be loaded, and stays re-bootable', async () => {
    await withObject('boot-load-fails', {}, async (h) => {
      h.store.load.mockRejectedValue(new Error('VFS unreachable'));
      await expect(h.ready()).rejects.toThrow();
      expect(h.db()).toBeNull();
      expect(await fileSizeOnDisk(h)).toBe(0);

      h.store.load.mockResolvedValue(null);
      await h.ready();
      expect(h.db()).not.toBeNull();
    });
  }, 30_000);

  it.each([
    { label: 'a short file', bytes: 40 },
    { label: 'a file with a foreign header', bytes: 4096 },
  ])(
    'an owner copy that is not a database ($label) fails the boot and leaves the object empty',
    async ({ bytes }) => {
      await withObject(`boot-corrupt-${bytes}`, {}, async (h) => {
        h.store.upstream.file = new Uint8Array(bytes).fill(0x41);
        await expect(h.ready()).rejects.toThrow();
        expect(h.db()).toBeNull();
        expect(await fileSizeOnDisk(h)).toBe(0);
        // Fixed upstream: the next request boots normally.
        h.store.upstream.file = null;
        await h.ready();
        expect(h.db()).not.toBeNull();
      });
    },
  );

  it('remembers that no legacy copy is usable, so later boots skip the gateway', async () => {
    const legacy = vi.fn(async (): Promise<OwnerCopy | null> => null);
    const store = fakeOwnerStore({ legacy });
    await withObject('boot-legacy-absent', { store }, async (h) => {
      await h.ready();
      expect(legacy).toHaveBeenCalledTimes(1);
      expect(await h.storage.get('meta:legacyUnusable')).toBe(true);
      await h.restart();
      await h.ready();
      expect(legacy).toHaveBeenCalledTimes(1);
    });
  });

  it('remembers a legacy copy without turns and adopts one with turns', async () => {
    let legacyBytes: Uint8Array | null = null;
    const legacy = vi.fn(
      async (): Promise<OwnerCopy | null> =>
        legacyBytes
          ? {
              stream: streamOfBytes(legacyBytes),
              etag: 'legacy',
              fromLegacy: true,
            }
          : null,
    );
    const store = fakeOwnerStore({ legacy });
    await withObject('boot-legacy-empty', { store }, async (h) => {
      await h.ready();
      // An empty legacy file: tried, put back, remembered.
      legacyBytes = (await h.db()?.export()) ?? null;
      await h.storage.delete('meta:legacyUnusable');
      await h.restart();
      await h.ready();
      expect(legacy).toHaveBeenCalledTimes(2);
      expect(await h.storage.get('meta:legacyUnusable')).toBe(true);
      await h.restart();
      await h.ready();
      expect(legacy).toHaveBeenCalledTimes(2);
    });
  });
});

describe('delegations', () => {
  const as = (ucanDelegation: string) =>
    ({ userDid: USER_DID, ucanDelegation }) as const;

  it('alternating delegations of two clients never flush early without a recorded failure', async () => {
    await withObject('delegation-alternating', {}, async (h) => {
      await verifiedCopy(h);
      await h.writeTurn('pending');
      await h.call('markDirty');
      for (const raw of ['client-a', 'client-b', 'client-a', 'client-b'])
        await h.call('ready', as(raw));
      await h.settle();
      await Promise.resolve(h.field('flushInFlight')).catch(() => undefined);
      expect(h.store.save).toHaveBeenCalledTimes(1);
      expect(h.field('dirty')).toBe(true);
    });
  });

  it('a new delegation after a failed flush uploads at once and clears the failure streak', async () => {
    await withObject('delegation-after-failure', {}, async (h) => {
      await verifiedCopy(h);
      await h.writeTurn('pending');
      await h.call('markDirty');
      await h.storage.put('meta:flushFailures', 2);

      await h.call('ready', as('fresh-grant'));
      await h.settle();
      await vi.waitFor(() => expect(h.store.save).toHaveBeenCalledTimes(2));
      expect(await h.storage.get('meta:flushFailures')).toBeUndefined();
    });
  });

  it('stores a delegation once, not on every request that carries it', async () => {
    await withObject('delegation-stored-once', {}, async (h) => {
      await h.ready();
      const puts = vi.spyOn(h.storage, 'put');
      try {
        for (let i = 0; i < 3; i++) await h.call('ready', as('same'));
        const delegationWrites = puts.mock.calls.filter(
          ([key]) => typeof key === 'string' && key === 'meta:delegation',
        );
        expect(delegationWrites).toHaveLength(1);
        expect(
          await h.storage.get<{ raw: string }>('meta:delegation'),
        ).toMatchObject({ raw: 'same' });
      } finally {
        puts.mockRestore();
      }
    });
  });
});

describe("the user's Matrix id", () => {
  it('falls back to the oracle homeserver when Blocksync does not answer in time', async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      await withObject(
        'matrix-id-timeout',
        {
          env: {
            BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.invalid/graphql',
            MATRIX_HOMESERVER_NAME: 'oracle.example',
          },
        },
        async (h) => {
          const started = Date.now();
          expect(await h.call('resolveMatrixUserId', USER_DID)).toBe(
            '@did-ixo-lifecycle:oracle.example',
          );
          expect(Date.now() - started).toBeLessThan(5_000);
          expect(fetch).toHaveBeenCalledTimes(1);
          // The fallback is remembered (and re-resolved after its TTL).
          expect(await h.call('resolveMatrixUserId', USER_DID)).toBe(
            '@did-ixo-lifecycle:oracle.example',
          );
          expect(fetch).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/** The booted object's session store. */
function sessionsOf(h: UserObjectHarness): SessionsStore {
  const sessions = h.field('sessions');
  if (!(sessions instanceof SessionsStore)) throw new Error('not booted');
  return sessions;
}

async function newSession(h: UserObjectHarness, sessionId: string) {
  return sessionsOf(h).createSession({
    sessionId,
    oracleName: 'Test',
    oracleDid: 'did:ixo:oracle1',
    oracleEntityDid: 'did:ixo:oracle1',
  });
}

/** Route the object's session-title model to `invoke`. */
function titleModel(
  h: UserObjectHarness,
  invoke: (
    prompt: string,
    options?: { signal?: AbortSignal },
  ) => Promise<{
    content: string;
  }>,
) {
  const model = { invoke: vi.fn(invoke) };
  const ambient = h.field('ambient');
  if (typeof ambient !== 'object' || ambient === null)
    throw new Error('not booted');
  Reflect.set(h.host, 'ambient', { ...ambient, llm: { get: () => model } });
  return model;
}

const exchange = [new HumanMessage('Plan my week'), new AIMessage('Sure.')];

describe('session titles', () => {
  it('a title model that never answers does not hold the turn, and the turn abort ends it', async () => {
    await withObject('title-hanging', {}, async (h) => {
      installTimerTracker();
      await h.ready();
      await newSession(h, 's1');
      // A provider that ignores the abort signal entirely.
      const model = titleModel(h, () => new Promise(() => undefined));
      const turn = new AbortController();

      await h.call('afterTurn', 's1', exchange, { kind: 'agent' }, turn.signal);
      await vi.waitFor(() => expect(model.invoke).toHaveBeenCalledTimes(1));
      expect(model.invoke.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
        AbortSignal,
      );
      expect(
        pendingTimers().filter((timer) => timer.delayMs === 15_000),
      ).toHaveLength(1);

      turn.abort(new Error('user stopped'));
      await h.settle();
      expect((await sessionsOf(h).getSession('s1'))?.title).toBe(
        UNTITLED_SESSION,
      );
      expect(
        pendingTimers().filter((timer) => timer.delayMs === 15_000),
      ).toEqual([]);
    });
  });

  it('titles the session in the background once the model answers', async () => {
    await withObject('title-background', {}, async (h) => {
      await h.ready();
      await newSession(h, 's1');
      let answer: (title: { content: string }) => void = () => undefined;
      titleModel(
        h,
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );

      await h.call('afterTurn', 's1', exchange, { kind: 'agent' });
      expect((await sessionsOf(h).getSession('s1'))?.title).toBe(
        UNTITLED_SESSION,
      );

      answer({ content: '"Weekly plan"' });
      await h.settle();
      expect((await sessionsOf(h).getSession('s1'))?.title).toBe('Weekly plan');
      expect(h.field('dirty')).toBe(true);
    });
  });
});

describe('storage operations per request and turn', () => {
  it('a second turn of a warm object writes nothing to the KV storage', async () => {
    await withObject(
      'storage-ops',
      { env: { MATRIX_HOMESERVER_NAME: 'oracle.example' } },
      async (h) => {
        await h.ready();
        const puts = vi.spyOn(h.storage, 'put');
        const deletes = vi.spyOn(h.storage, 'delete');
        const identity = { userDid: USER_DID, ucanDelegation: 'grant' };
        /** What one non-streamed HTTP turn asks of the object. */
        const turn = async (): Promise<string[]> => {
          puts.mockClear();
          await h.call('ready', identity); // fetch
          await h.call('ready', identity); // runTurn
          await h.call('resolveMatrixUserId', USER_DID); // prepareTurn
          await h.call('markDirty'); // afterTurn
          await h.call('ready', identity); // listMessages
          await h.settle();
          await Promise.resolve(Reflect.get(h.host, 'alarmArm'));
          return puts.mock.calls.map(([key]) => String(key));
        };
        try {
          const first = await turn();
          expect(new Set(first)).toEqual(
            new Set(['meta:delegation', 'meta:dirty', 'meta:flushAt']),
          );
          expect(first).toHaveLength(3);
          expect(await turn()).toEqual([]);
          expect(deletes).not.toHaveBeenCalled();
          // The upload is still scheduled for the first write's deadline.
          const flushAt = await h.storage.get<number>('meta:flushAt');
          expect(await h.storage.getAlarm()).toBeLessThanOrEqual(flushAt ?? 0);
        } finally {
          puts.mockRestore();
          deletes.mockRestore();
        }
      },
    );
  });
});

describe('turn preparation', () => {
  it('a build that fails part-way leaves no turn timer and no abort entry behind', async () => {
    await withObject('prepare-fails', {}, async (h) => {
      installTimerTracker();
      await h.ready();
      Reflect.set(h.host, 'contextWindows', {
        resolve: async () => ({
          model: 'test',
          tokens: 100_000,
          origin: 'default',
        }),
      });
      Reflect.set(h.host, 'resolveMatrixUserId', async () => {
        throw new Error('storage unavailable');
      });
      const durationMs = turnLimitsFromEnv(h.core.validatedEnv).durationMs;
      const abortController = new AbortController();

      await expect(
        h.call(
          'prepareTurn',
          {
            identity: { userDid: USER_DID },
            sessionId: 's1',
            message: 'hello',
            client: 'portal',
            requestId: 'r1',
          },
          { message: 'hello' },
          {
            runId: 'run-1',
            abortController,
            resumed: false,
            continuation: null,
          },
        ),
      ).rejects.toThrow('storage unavailable');

      expect(
        pendingTimers().filter((timer) => timer.delayMs === durationMs),
      ).toEqual([]);
      const aborts = h.field('aborts');
      expect(aborts instanceof Map && aborts.has('s1')).toBe(false);
    });
  });
});

describe('deleting a session', () => {
  it('ends the running run and the one queued behind it before the rows go', async () => {
    await withObject('delete-session-runs', {}, async (h) => {
      await h.ready();
      await newSession(h, 's1');
      const runs = h.field('runs');
      if (!(runs instanceof RunCoordinator)) throw new Error('not booted');
      const started: string[] = [];
      Reflect.set(h.host, 'runAttempt', async (live: LiveRun) => {
        started.push(live.runId);
        // The graph's first step, then work until aborted.
        await h.writeTurn('s1');
        await new Promise((resolve) =>
          live.abort.signal.addEventListener('abort', resolve),
        );
        return { status: 'aborted', text: '' };
      });
      const begin = (runId: string, multitask: 'interrupt' | 'enqueue') =>
        runs.begin({
          runId,
          sessionId: 's1',
          requestId: runId,
          client: 'portal',
          request: JSON.stringify({
            turn: {
              identity: { userDid: USER_DID },
              sessionId: 's1',
              message: 'hi',
              client: 'portal',
              requestId: runId,
            },
          }),
          multitask,
        });
      const first = await begin('run-1', 'interrupt');
      await vi.waitFor(() => expect(started).toEqual(['run-1']));
      const second = await begin('run-2', 'enqueue');
      expect(second.queued).toBe(true);

      expect(await h.call('deleteSession', { userDid: USER_DID }, 's1')).toBe(
        true,
      );
      await Promise.all([first.live.done, second.live.done]);
      await h.settle();

      expect(started).toEqual(['run-1']);
      expect((await second.live.done).status).toBe('aborted');
      expect(await sessionsOf(h).getSession('s1')).toBeUndefined();
      expect(
        await h.saver().getTuple({
          configurable: { thread_id: 's1', checkpoint_ns: '' },
        }),
      ).toBeUndefined();
    });
  });

  it('deleting an unknown session changes nothing', async () => {
    await withObject('delete-session-unknown', {}, async (h) => {
      await verifiedCopy(h);
      expect(
        await h.call('deleteSession', { userDid: USER_DID }, 'missing'),
      ).toBe(false);
      expect(h.field('dirty')).toBe(false);
    });
  });
});

const portalTurn: TurnRequest = {
  identity: { userDid: USER_DID, timezone: 'Africa/Johannesburg' },
  sessionId: 's1',
  message: 'What is on today?',
  client: 'portal',
  requestId: 'r1',
};

/** A booted object whose model lookups stay offline. */
async function bootedForTurns(h: UserObjectHarness) {
  await h.ready();
  const resolve = vi.fn(async (model: string) => ({
    model,
    tokens: 100_000,
    origin: 'default',
  }));
  Reflect.set(h.host, 'contextWindows', {
    resolve,
    learnFromError: () => undefined,
  });
  const router = vi.fn(async (_input: Record<string, unknown>) => undefined);
  Reflect.set(h.host, 'capabilityRouter', router);
  return { resolve, router };
}

function attemptRun(runId = 'run-1') {
  return {
    runId,
    abortController: new AbortController(),
    resumed: false,
    continuation: null,
  };
}

/** The first message of a prepared turn's graph input. */
function inputMessage(prepared: unknown): HumanMessage {
  if (typeof prepared !== 'object' || prepared === null)
    throw new Error('no prepared turn');
  const input: unknown = Reflect.get(prepared, 'stateInput');
  const messages: unknown =
    typeof input === 'object' && input !== null
      ? Reflect.get(input, 'messages')
      : undefined;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  if (!(first instanceof HumanMessage)) throw new Error('no input message');
  return first;
}

async function disposeTurn(h: UserObjectHarness, prepared: unknown) {
  if (typeof prepared === 'object' && prepared !== null)
    await h.call(
      'runTurnDisposables',
      Reflect.get(prepared, 'turnDisposables'),
    );
}

describe('turn preparation wiring', () => {
  it("puts the turn's exact time on the user's message, recorded so it can be taken off", async () => {
    await withObject('turn-time-note', {}, async (h) => {
      await bootedForTurns(h);
      const prepared = await h.call(
        'prepareTurn',
        portalTurn,
        { message: portalTurn.message },
        attemptRun(),
      );
      const message = inputMessage(prepared);
      const note = message.additional_kwargs[TURN_TIME_NOTE_KWARG];
      expect(typeof note).toBe('string');
      expect(message.content).toBe(`${String(note)}\n\n${portalTurn.message}`);
      // The note is the instant the prompt was built for.
      const timestamp = message.additional_kwargs.timestamp;
      expect(note).toBe(
        renderTurnTimeNote(
          new Date(String(timestamp)),
          portalTurn.identity.timezone,
        ),
      );
      await disposeTurn(h, prepared);
    });
  });

  it("keeps a supplied-context task's input exactly as supplied", async () => {
    await withObject('turn-time-note-supplied', {}, async (h) => {
      await bootedForTurns(h);
      Reflect.set(h.host, 'taskScheduler', {
        assertTurnProfile: async () => undefined,
        isRestrictedSession: async () => true,
      });
      const prepared = await h.call(
        'prepareTurn',
        {
          ...portalTurn,
          sessionId: 'task:brief',
          executionProfile: 'supplied-context-markdown',
        },
        { message: portalTurn.message },
        attemptRun(),
      );
      const message = inputMessage(prepared);
      expect(message.content).toBe(portalTurn.message);
      expect(message.additional_kwargs[TURN_TIME_NOTE_KWARG]).toBeUndefined();
      await disposeTurn(h, prepared);
    });
  });

  it('a resumed attempt hands the graph no new message, so no second note', async () => {
    await withObject('turn-time-note-resumed', {}, async (h) => {
      await bootedForTurns(h);
      await newSession(h, 's1');
      const original: unknown = Reflect.get(h.host, 'prepareTurn');
      if (typeof original !== 'function') throw new Error('no prepareTurn');
      const handed: unknown[] = [];
      Reflect.set(h.host, 'prepareTurn', async (...args: unknown[]) => {
        const prepared: unknown = await Reflect.apply(original, h.host, args);
        if (typeof prepared !== 'object' || prepared === null)
          throw new Error('no prepared turn');
        return {
          ...prepared,
          agent: {
            streamEvents: (input: unknown) => {
              handed.push(input);
              return (async function* () {})();
            },
          },
        };
      });
      const run = async (resumed: boolean, runId: string) => {
        const live: LiveRun = {
          runId,
          sessionId: 's1',
          requestId: runId,
          record: {
            runId,
            sessionId: 's1',
            requestId: runId,
            client: 'portal',
            status: 'running',
            request: JSON.stringify({
              ...storedRunRequest({ ...portalTurn, requestId: runId }),
              disposition: { kind: 'agent' },
            }),
            checkpointId: null,
            startCheckpointId: null,
            startRecorded: true,
            instanceId: 'test',
            attempts: 0,
            generation: 0,
            nextAttemptAt: null,
            lastSeq: 0,
            messageId: null,
            partialText: null,
            error: null,
            taskRunId: null,
            usage: null,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          buffer: new RunBuffer({
            flushMs: 60_000,
            flushBytes: 100_000,
            onPack: () => undefined,
          }),
          abort: new AbortController(),
          continuation: null,
          done: Promise.resolve({ status: 'finished', text: '' }),
          resolve: () => undefined,
          attemptInFlight: true,
        };
        await h.call('runAttempt', live, resumed);
        await live.buffer.close();
      };
      await run(false, 'fresh');
      await run(true, 'resumed');
      expect(handed).toHaveLength(2);
      expect(
        inputMessage({ stateInput: handed[0] }).additional_kwargs,
      ).toHaveProperty(TURN_TIME_NOTE_KWARG);
      expect(handed[1]).toBeNull();
    });
  });

  it("derives the context budget from the main model's window alone and hands the router lazy, capability-aware inputs", async () => {
    await withObject('turn-summary-window', {}, async (h) => {
      const { resolve, router } = await bootedForTurns(h);
      const prepared = await h.call(
        'prepareTurn',
        portalTurn,
        { message: portalTurn.message },
        attemptRun(),
      );
      // The summary is written by the main model: no second window (the
      // helper `routing` model's) is resolved for it.
      expect(resolve.mock.calls.map(([model]) => model)).toEqual([
        DEFAULT_MODEL_ID,
      ]);
      expect(OPENROUTER_MODEL_MAP.routing).not.toBe(DEFAULT_MODEL_ID);
      const input = router.mock.calls[0]?.[0];
      expect(typeof input?.hidden).toBe('function');
      expect(typeof input?.hasCapability).toBe('function');
      await disposeTurn(h, prepared);
    });
  });

  it("titles a session from the user's own words, not the time note", async () => {
    await withObject('title-without-note', {}, async (h) => {
      await h.ready();
      await newSession(h, 's1');
      const prompts: string[] = [];
      titleModel(h, async (prompt) => {
        prompts.push(prompt);
        return { content: 'Plans' };
      });
      const note = 'Current time: Monday, 2026-10-05 09:00 (UTC)';
      const noted = new HumanMessage({
        content: `${note}\n\nPlan my week`,
        additional_kwargs: { [TURN_TIME_NOTE_KWARG]: note },
      });
      await h.call('afterTurn', 's1', [noted, new AIMessage('Sure.')]);
      await h.settle();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('User: Plan my week');
      expect(prompts[0]).not.toContain('Current time');
    });
  });
});

describe('alarm and boot wiring', () => {
  it('uses the next wake the task tick reports, and asks again only when the tick failed', async () => {
    await withObject('task-next-wake', {}, async (h) => {
      await verifiedCopy(h);
      const scheduler = h.field('taskScheduler');
      if (typeof scheduler !== 'object' || scheduler === null)
        throw new Error('no scheduler');
      const at = Date.now() + 50_000;
      const nextWakeAt = vi.fn(async () => at + 10_000);
      Reflect.set(scheduler, 'nextWakeAt', nextWakeAt);
      Reflect.set(scheduler, 'onAlarm', async () => at);
      await h.fireAlarm();
      expect(nextWakeAt).not.toHaveBeenCalled();
      expect(await h.storage.get('meta:housekeepingAt')).toBe(at);

      Reflect.set(scheduler, 'onAlarm', async () => {
        throw new Error('tick failed');
      });
      await h.fireAlarm();
      expect(nextWakeAt).toHaveBeenCalledTimes(1);
      expect(await h.storage.get('meta:housekeepingAt')).toBe(at + 10_000);
    });
  });

  it('a failing recovery start on the heartbeat path does not reject the alarm', async () => {
    await withObject('fast-path-resume-fails', {}, async (h) => {
      await verifiedCopy(h);
      attachSocket(h);
      const runs = h.field('runs');
      if (!(runs instanceof RunCoordinator)) throw new Error('not booted');
      Reflect.set(runs, 'nextRecoveryAt', () => Date.now());
      const resumeDue = vi.fn(async () => {
        throw new Error('run store unavailable');
      });
      Reflect.set(runs, 'resumeDue', resumeDue);

      await expect(h.fireAlarm()).resolves.toBeUndefined();
      expect(resumeDue).toHaveBeenCalled();
      expect(await h.storage.getAlarm()).not.toBeNull();
    });
  });

  it('sweeps expired blobs page by page without holding an idle copy back', async () => {
    await withObject('blob-sweep', {}, async (h) => {
      await verifiedCopy(h);
      const expired = Date.now() - 1000;
      for (let i = 0; i < 130; i++)
        await h.storage.put(`blob:${String(i).padStart(3, '0')}`, {
          name: 'n',
          value: 'v',
          expiresAt: expired,
        });
      await h.storage.put('blob:zzz-live', {
        name: 'n',
        value: 'v',
        expiresAt: Date.now() + DAY_MS,
      });
      await h.restart();
      await h.storage.put('meta:lastAccessAt', Date.now() - 6 * DAY_MS);

      await h.fireAlarm();

      // One page went, the rest waits for the next tick; the wipe did not.
      const left = await h.storage.list({ prefix: 'blob:' });
      expect(left.size).toBe(3);
      expect(h.db()).toBeNull();
    });
  });

  it('forgets the cached attachment text of a deleted session', async () => {
    await withObject('attachment-cache-forget', {}, async (h) => {
      await h.ready();
      await newSession(h, 's1');
      const store = h.field('attachmentTextCache');
      if (typeof store !== 'object' || store === null)
        throw new Error('no attachment text cache');
      const forSession: unknown = Reflect.get(store, 'forSession');
      if (typeof forSession !== 'function') throw new Error('no forSession');
      const cache: unknown = Reflect.apply(forSession, store, ['s1']);
      if (typeof cache !== 'object' || cache === null) throw new Error();
      const put: unknown = Reflect.get(cache, 'put');
      const get: unknown = Reflect.get(cache, 'get');
      if (typeof put !== 'function' || typeof get !== 'function')
        throw new Error('no cache methods');
      await Reflect.apply(put, cache, ['ref', 'model', 'text']);
      expect(await Reflect.apply(get, cache, ['ref', 'model'])).toBe('text');

      await h.call('deleteSession', { userDid: USER_DID }, 's1');

      expect(await Reflect.apply(get, cache, ['ref', 'model'])).toBeUndefined();
    });
  });

  /** A stalled stream that records the reason it was cancelled with. */
  function stalledMedia() {
    const cancelled: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      pull: () => undefined,
      cancel: (reason) => {
        cancelled.push(reason);
      },
    });
    return { stream, cancelled };
  }

  async function mediaMethod(
    h: { call(name: string): Promise<unknown> },
    name: 'downloadMxc' | 'downloadEvent',
  ): Promise<{ source: object; method: unknown }> {
    const source = await h.call('matrixMediaSource');
    if (typeof source !== 'object' || source === null)
      throw new Error('no media source');
    return { source, method: Reflect.get(source, name) };
  }

  it("stops reading Matrix media when the turn's signal aborts and cancels the gateway stream", async () => {
    await withObject('media-signal', {}, async (h) => {
      await h.ready();
      const media = stalledMedia();
      h.gateway.downloadMxcMediaStream.mockImplementationOnce(
        async () => media.stream,
      );
      const { source, method } = await mediaMethod(h, 'downloadMxc');
      if (typeof method !== 'function') throw new Error('no downloadMxc');
      const abort = new AbortController();
      const reading = Reflect.apply(method, source, [
        'mxc://example/media',
        1024,
        abort.signal,
      ]);
      const stop = new Error('turn stopped');
      // Abort only once the read is waiting on the stalled stream.
      await vi.waitFor(() =>
        expect(h.gateway.downloadMxcMediaStream).toHaveBeenCalled(),
      );
      abort.abort(stop);
      await expect(reading).rejects.toThrow();
      // Only the deadline crosses the RPC; the abort arrives as a cancel.
      expect(h.gateway.downloadMxcMediaStream).toHaveBeenCalledWith(
        'mxc://example/media',
        { timeoutMs: 60_000 },
      );
      expect(media.cancelled).toEqual([stop]);
    });
  });

  it('bounds an event media download by the deadline and cancels it on abort', async () => {
    await withObject('media-event-signal', {}, async (h) => {
      await h.ready();
      const media = stalledMedia();
      h.gateway.downloadEventMediaStream.mockImplementationOnce(async () => ({
        stream: media.stream,
      }));
      const { source, method } = await mediaMethod(h, 'downloadEvent');
      if (typeof method !== 'function') throw new Error('no downloadEvent');
      const abort = new AbortController();
      const reading = Reflect.apply(method, source, [
        '!room:example',
        '$event',
        1024,
        abort.signal,
      ]);
      await vi.waitFor(() =>
        expect(h.gateway.downloadEventMediaStream).toHaveBeenCalled(),
      );
      const stop = new Error('turn stopped');
      abort.abort(stop);
      await expect(reading).rejects.toThrow();
      expect(h.gateway.downloadEventMediaStream).toHaveBeenCalledWith(
        '!room:example',
        '$event',
        { timeoutMs: 60_000 },
      );
      expect(media.cancelled).toEqual([stop]);
    });
  });
});

/** Unix seconds `seconds` from now. */
const secondsFromNow = (seconds: number): number =>
  Math.floor(Date.now() / 1000) + seconds;

/** A real serialized delegation from the user, expiring at `expiration`. */
async function delegationToken(expiration: number): Promise<string> {
  const user = await generateKeypair();
  const oracle = await generateKeypair();
  return serializeDelegation(
    await createDelegation({
      issuer: user.signer,
      audience: oracle.did,
      capabilities: [{ can: 'memory/*', with: 'ixo:memory' }],
      expiration,
    }),
  );
}

const channelInput: ChannelTurnInput = {
  provider: 'whatsapp',
  bindingId: 'chb_lifecycle',
  bindingRevision: 1,
  requestId: 'wa:lifecycle',
  remoteMessageRef: `hmac:${'c'.repeat(64)}`,
  message: 'Hello',
  context: { kind: 'companion' },
};

const channelIdentity = {
  userDid: USER_DID,
  channel: {
    callerDid: 'did:web:channels.test',
    provider: 'whatsapp' as const,
    bindingId: channelInput.bindingId,
    bindingRevision: 1,
  },
};

const delegationRequired = {
  ok: false,
  status: 428,
  code: 'delegation_required',
  message:
    'Companion delegation required: the user must authorize this oracle again',
};

/** What the shell's `/delegation` deposit stored for this user. */
async function storeDelegation(
  h: UserObjectHarness,
  expiration: number,
): Promise<void> {
  await h.storage.put('meta:delegation', {
    raw: 'deposited-grant',
    at: Date.now(),
    expiration,
  });
}

/**
 * Replace the object's channel admission by `submit` once it boots, so a
 * test observes whether a turn got past the delegation check and the boot.
 */
function admitAfterBoot(h: UserObjectHarness) {
  const submit = vi.fn(async () => ({ status: 'queued' }));
  const ready: unknown = h.field('ready');
  if (typeof ready !== 'function') throw new Error('no ready');
  Reflect.set(h.host, 'ready', async (...args: unknown[]) => {
    await Reflect.apply(ready, h.host, args);
    Reflect.set(h.host, 'channelTurns', { submit });
  });
  return submit;
}

describe('channel turn admission', () => {
  it('refuses a user without a delegation with 428 before the object boots', async () => {
    await withObject('channel-no-delegation', {}, async (h) => {
      const submit = admitAfterBoot(h);
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toEqual(delegationRequired);
      expect(h.db()).toBeNull();
      expect(h.store.load).not.toHaveBeenCalled();
      expect(await h.storage.get('meta:userDid')).toBeUndefined();
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: 'expired', left: -60 },
    {
      name: 'inside the margin',
      left: CHANNEL_DELEGATION_MIN_REMAINING_SECONDS - 30,
    },
  ])(
    'refuses a stored delegation $name with 428 before the object boots',
    async ({ name, left }) => {
      await withObject(`channel-delegation-${name}`, {}, async (h) => {
        await storeDelegation(h, secondsFromNow(left));
        const submit = admitAfterBoot(h);
        expect(
          await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
        ).toEqual(delegationRequired);
        expect(h.db()).toBeNull();
        expect(h.store.load).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      });
    },
  );

  it('admits a turn under a stored delegation with more than the margin left', async () => {
    await withObject('channel-delegation-valid', {}, async (h) => {
      await storeDelegation(
        h,
        secondsFromNow(CHANNEL_DELEGATION_MIN_REMAINING_SECONDS + 60),
      );
      const submit = admitAfterBoot(h);
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toEqual({ ok: true, result: { status: 'queued' } });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(h.db()).not.toBeNull();
    });
  });

  it('refuses a delegation that lapsed while the object stayed warm', async () => {
    await withObject('channel-delegation-lapsed', {}, async (h) => {
      await storeDelegation(h, secondsFromNow(3600));
      const submit = admitAfterBoot(h);
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toMatchObject({ ok: true });
      // Still held in memory, but now inside the margin.
      Reflect.set(
        h.host,
        'delegations',
        new Map([
          [
            USER_DID,
            { raw: 'deposited-grant', expiration: secondsFromNow(60) },
          ],
        ]),
      );
      await storeDelegation(h, secondsFromNow(60));
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toEqual(delegationRequired);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  it('answers 428 delegation_required when the delegation cannot load the owner copy', async () => {
    await withObject('channel-no-vfs-capability', {}, async (h) => {
      await storeDelegation(h, secondsFromNow(3600));
      h.store.load.mockRejectedValue(
        new VfsNoDelegationError(USER_DID, 'no-capability'),
      );
      const submit = admitAfterBoot(h);
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toEqual(delegationRequired);
      expect(h.store.load).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it('lets any other boot failure propagate (the shell answers 503 unavailable)', async () => {
    await withObject('channel-boot-failure', {}, async (h) => {
      await storeDelegation(h, secondsFromNow(3600));
      h.store.load.mockRejectedValue(
        new VfsRequestError(401, '', 'VFS rejected the oracle'),
      );
      admitAfterBoot(h);
      await expect(
        h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).rejects.toThrow('VFS_AUTH_FAILED');
    });
  });

  it('a deposited delegation makes a refused turn admissible at once', async () => {
    await withObject('channel-delegation-deposit', {}, async (h) => {
      const submit = admitAfterBoot(h);
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toEqual(delegationRequired);
      // What `POST /delegation` hands the object after storing the deposit
      // (the room-state re-read after the miss above is throttled).
      await h.call(
        'setDelegation',
        USER_DID,
        'deposited-grant',
        secondsFromNow(3600),
      );
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toEqual({ ok: true, result: { status: 'queued' } });
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { name: 'long-lived', left: 3600, admitted: true },
    { name: 'short-lived', left: 600, admitted: false },
  ])(
    "reads a $name delegation's expiry off the token when none is stated",
    async ({ name, left, admitted }) => {
      await withObject(`channel-token-expiry-${name}`, {}, async (h) => {
        const expiration = secondsFromNow(left);
        await h.call(
          'setDelegation',
          USER_DID,
          await delegationToken(expiration),
        );
        const delegations = h.field('delegations');
        expect(
          delegations instanceof Map && delegations.get(USER_DID),
        ).toMatchObject({ expiration });
        admitAfterBoot(h);
        const outcome = await h.call(
          'channelTurn',
          channelIdentity,
          channelInput,
          'hash',
        );
        expect(outcome).toEqual(
          admitted
            ? { ok: true, result: { status: 'queued' } }
            : delegationRequired,
        );
      });
    },
  );

  it('answers 428 room_not_ready while the user has no Companion room', async () => {
    await withObject('channel-room-not-ready', {}, async (h) => {
      await storeDelegation(h, secondsFromNow(3600));
      expect(
        await h.call('channelTurn', channelIdentity, channelInput, 'hash'),
      ).toEqual({
        ok: false,
        status: 428,
        code: 'room_not_ready',
        message: 'Companion room is not ready',
      });
    });
  });
});

describe('channel turns', () => {
  it('does not check the binding again after the shell did', async () => {
    await withObject('channel-turn-binding', {}, async (h) => {
      await h.ready();
      await h.call('setDelegation', USER_DID, 'grant', secondsFromNow(3600));
      const submit = vi.fn(async () => ({ status: 'accepted' }));
      Reflect.set(h.host, 'channelTurns', { submit });
      const outcome = await h.call(
        'channelTurn',
        { userDid: USER_DID },
        { text: 'hi' },
        'hash',
      );
      expect(outcome).toMatchObject({ ok: true });
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { source: 'begin' as const, checked: false },
    { source: 'recovery' as const, checked: true },
  ])(
    'a $source attempt checks the channel binding: $checked',
    async ({ source, checked }) => {
      await withObject(`channel-attempt-${source}`, {}, async (h) => {
        await h.ready();
        Reflect.set(
          h.host,
          'delegations',
          new Map([
            [USER_DID, { raw: 'grant', expiration: secondsFromNow(3600) }],
          ]),
        );
        const prepared = vi.fn(async () => {
          throw new Error('agent build reached');
        });
        Reflect.set(h.host, 'prepareTurn', prepared);
        const req: TurnRequest = { ...portalTurn, client: 'channel' };
        const live = {
          runId: 'run',
          sessionId: req.sessionId,
          requestId: req.requestId,
          attemptSource: source,
          record: {
            request: JSON.stringify({
              ...storedRunRequest(req),
              disposition: { kind: 'agent' },
            }),
          },
          buffer: { isClosed: false, push: vi.fn() },
          abort: new AbortController(),
          continuation: null,
        };
        const attempt = h.call('runAttempt', live, false);
        // A refused check never reaches the agent build; an unchecked
        // attempt does. (This request carries no channel identity.)
        await expect(attempt).rejects.toThrow(
          checked ? 'Channel identity is required' : 'agent build reached',
        );
        expect(prepared).toHaveBeenCalledTimes(checked ? 0 : 1);
      });
    },
  );
});

describe('run rows per turn', () => {
  it('a turn writes its run row twice: when it starts and when it ends, usage included', async () => {
    await withObject('run-row-writes', {}, async (h) => {
      await bootedForTurns(h);
      await newSession(h, 's1');
      const runs = h.field('runs');
      const store = h.field('runStore');
      if (!(runs instanceof RunCoordinator) || !(store instanceof RunStore))
        throw new Error('not booted');
      const original: unknown = Reflect.get(h.host, 'prepareTurn');
      if (typeof original !== 'function') throw new Error('no prepareTurn');
      Reflect.set(h.host, 'prepareTurn', async (...args: unknown[]) => {
        const prepared: unknown = await Reflect.apply(original, h.host, args);
        if (typeof prepared !== 'object' || prepared === null)
          throw new Error('no prepared turn');
        return {
          ...prepared,
          agent: { streamEvents: () => (async function* () {})() },
        };
      });
      const creates = vi.spyOn(store, 'create');
      const updates = vi.spyOn(store, 'update');
      const { live } = await runs.begin({
        runId: 'run-rows',
        sessionId: 's1',
        requestId: 'r1',
        client: 'portal',
        request: String(
          await h.call(
            'runRequestJson',
            portalTurn,
            storedRunRequest(portalTurn),
          ),
        ),
        multitask: 'interrupt',
      });
      await live.done;
      expect(creates).toHaveBeenCalledTimes(1);
      expect(updates).toHaveBeenCalledTimes(1);
      expect(updates.mock.calls[0]?.[1]).toMatchObject({
        usage: expect.stringContaining('"modelCalls":0'),
      });
      expect((await store.get('run-rows'))?.usage).toContain('"modelCalls"');
    });
  });
});

describe('what a person reads back', () => {
  it('indexes the history without the turn time note', async () => {
    await withObject('history-without-note', {}, async (h) => {
      await h.ready();
      const note = 'Current time: Monday, 2026-10-05 09:00 (UTC)';
      await h.saver().appendTurnMessages('s1', [
        new HumanMessage({
          id: 'h1',
          content: `${note}\n\nPlan my week`,
          additional_kwargs: { [TURN_TIME_NOTE_KWARG]: note },
        }),
        new AIMessage({ id: 'a1', content: 'Sure.' }),
      ]);
      const history = await h.call('historyMessages', 's1');
      expect(JSON.stringify(history)).not.toContain('Current time:');
      expect(history).toEqual([
        { type: 'human', content: 'Plan my week' },
        { type: 'ai', content: 'Sure.' },
      ]);
    });
  });
});

/** The bytes of a SQLite file built in this object's storage under `name`. */
async function sqliteFile(
  h: UserObjectHarness,
  name: string,
  withTurn: boolean,
): Promise<Uint8Array> {
  const db = await DoSqliteDatabase.open(h.ctx, name);
  try {
    const saver = new SqliteSaver(db);
    await saver.setup();
    if (withTurn)
      await saver.put(
        { configurable: { thread_id: 'legacy', checkpoint_ns: '' } },
        emptyCheckpoint(),
        { source: 'update', step: 1, parents: {} },
      );
    return await db.export();
  } finally {
    await db.close();
  }
}

describe('the legacy Matrix copy', () => {
  it('a legacy read that fails is retried on the next boot, which adopts the copy', async () => {
    const primary = fakeOwnerStore();
    const legacy = fakeOwnerStore();
    const ownerStore = new MigratingOwnerStore({
      primary,
      legacy,
      log: () => undefined,
    });
    await withObject('legacy-probe-retry', { ownerStore }, async (h) => {
      // The VFS holds a never-chatted stub; Matrix holds the history.
      primary.upstream.file = await sqliteFile(h, 'stub.db', false);
      legacy.upstream.file = await sqliteFile(h, 'history.db', true);
      legacy.load.mockRejectedValueOnce(new Error('homeserver timed out'));

      await h.ready();
      expect(await h.storage.get('meta:legacyUnusable')).toBeUndefined();

      await h.restart();
      await h.ready();
      expect(
        await h.saver().getTuple({
          configurable: { thread_id: 'legacy', checkpoint_ns: '' },
        }),
      ).toBeDefined();
      expect(h.field('dirty')).toBe(true);
    });
  });
});

describe('the expired-blob sweep', () => {
  it('runs at most once an hour while nothing is left to page through', async () => {
    await withObject('blob-sweep-throttle', {}, async (h) => {
      await verifiedCopy(h);
      const list = vi.spyOn(h.storage, 'list');
      try {
        await h.fireAlarm();
        await h.fireAlarm();
        const blobLists = list.mock.calls.filter(
          ([options]) => options?.prefix === 'blob:',
        );
        expect(blobLists).toHaveLength(1);
      } finally {
        list.mockRestore();
      }
    });
  });
});

describe('resetting the working copy', () => {
  /** The owner store answers only once the object holds a delegation, as the VFS does. */
  function requireDelegation(h: UserObjectHarness): void {
    h.store.load.mockImplementation(async () => {
      const delegations = h.field('delegations');
      if (!(delegations instanceof Map) || !delegations.has(USER_DID))
        throw new VfsNoDelegationError(USER_DID, 'no-delegation');
      return null;
    });
  }

  it('boots an object that never booted, with the delegation the request carried', async () => {
    await withObject('reset-fresh-object', {}, async (h) => {
      requireDelegation(h);
      expect(await h.storage.get('meta:userDid')).toBeUndefined();

      expect(
        await h.call('resetWorkingCopy', {
          userDid: USER_DID,
          ucanDelegation: 'reset-grant',
        }),
      ).toEqual({ reloadedFromOwnerStore: false });

      expect(h.db()).not.toBeNull();
      const status = await h.call('storageStatus');
      expect(status).toMatchObject({
        writeGeneration: expect.any(Number),
        tier: expect.any(Object),
      });
      expect(await h.storage.get('meta:userDid')).toBe(USER_DID);
    });
  });

  it('keeps the delegation the reset request carried', async () => {
    await withObject('reset-keeps-delegation', {}, async (h) => {
      await h.call('ready', { userDid: USER_DID, ucanDelegation: 'old-grant' });

      await h.call('resetWorkingCopy', {
        userDid: USER_DID,
        ucanDelegation: 'new-grant',
      });

      const delegations = h.field('delegations');
      expect(delegations instanceof Map && delegations.get(USER_DID)).toEqual({
        raw: 'new-grant',
      });
      expect(
        await h.storage.get<{ raw: string }>('meta:delegation'),
      ).toMatchObject({ raw: 'new-grant' });
    });
  });

  it('refuses a DID other than the one the object is bound to', async () => {
    await withObject('reset-other-did', {}, async (h) => {
      await verifiedCopy(h);
      const etag = await h.storage.get('meta:ownerEtag');
      await expect(
        h.call('resetWorkingCopy', {
          userDid: 'did:ixo:someone-else',
          ucanDelegation: 'other-grant',
        }),
      ).rejects.toThrow('did:ixo:someone-else');
      expect(h.db()).not.toBeNull();
      expect(await h.storage.get('meta:ownerEtag')).toBe(etag);
    });
  });
});
