import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import type { TopicDeliverableResult } from '../tasks/topic-deliverables';
import { createUserOracleDO } from './user-oracle-do';

const USER_DID = 'did:ixo:owner';
const DAY_MS = 24 * 60 * 60_000;
const request = {
  topic: {
    id: 'topic',
    roomId: '!room:example.com',
    threadId: '$root',
    attemptId: 'attempt',
  },
  title: 'Brief',
  goal: 'A goal',
  instructions: 'Write a brief.',
  sources: [],
};
const queued: TopicDeliverableResult = {
  ok: true,
  snapshot: {
    operationId: 'op',
    taskId: 'task_brief',
    topic: request.topic,
    status: 'queued',
  },
};

/** DO storage as far as the request, dirty and idle paths use it. */
function fakeStorage() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    values,
    alarm: () => alarm,
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    }),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (at: number) => {
      alarm = at;
    }),
  };
}

/**
 * A booted `UserOracleDO` without its constructor: the real prototype
 * (`topicDeliverable`, `ready`, `markDirty`, `stillIdle`, `clearDirty`) over
 * a fake storage, a database that only reports its write generation and a
 * scheduler whose Start and cancel write (bump the generation).
 */
function bootedObject(opts: { startThrows?: boolean } = {}) {
  const core = createRuntimeCore({
    config: { name: 'Test', org: 'Test', description: 'Test' },
    plugins: [],
    env: makeEnv(),
  });
  const Oracle = createUserOracleDO({ core: () => core });
  const storage = fakeStorage();
  const db = { writeGeneration: 1 };
  const scheduler = {
    startTopicDeliverable: vi.fn(async () => {
      db.writeGeneration += 1;
      if (opts.startThrows) throw new Error('Alarm storage unavailable');
      return queued;
    }),
    readTopicDeliverable: vi.fn(async () => queued),
    cancelTopicDeliverable: vi.fn(async () => {
      db.writeGeneration += 1;
      return queued;
    }),
  };
  const host: object = Object.create(Oracle.prototype);
  Object.assign(host, {
    env: { TOPIC_DELIVERABLES_ENABLED: 'true' },
    ctx: { storage, waitUntil: vi.fn() },
    realtimeEndpoint: {},
    delegations: new Map([[USER_DID, { raw: 'delegation' }]]),
    userDid: USER_DID,
    initPromise: Promise.resolve(),
    evicting: null,
    db,
    dirty: false,
    flushInFlight: null,
    runs: null,
    alarmArm: Promise.resolve(),
    taskScheduler: scheduler,
  });
  const call = async (method: string, ...args: unknown[]): Promise<unknown> =>
    Reflect.apply(Reflect.get(host, method), host, args);
  const rpc = (command: unknown) =>
    call('topicDeliverable', { userDid: USER_DID }, 'op', command);
  /** Make the last request look older than the idle window. */
  const ageAccess = () =>
    storage.values.set('meta:lastAccessAt', Date.now() - 6 * DAY_MS);
  return { host, call, rpc, storage, db, scheduler, ageAccess };
}

describe('Topic deliverable RPC and the owner copy', () => {
  it('marks Start and cancel writes dirty and arms their flush; a read does not, and the object can evict once flushed', async () => {
    const o = bootedObject();
    await o.rpc({ action: 'read' });
    expect(Reflect.get(o.host, 'dirty')).toBe(false);
    expect(o.storage.values.has('meta:flushAt')).toBe(false);

    // A cancel-only change (a cancel recorded before any Start).
    const before = Date.now();
    await o.rpc({ action: 'cancel', request });
    expect(Reflect.get(o.host, 'dirty')).toBe(true);
    await expect
      .poll(() => o.storage.values.get('meta:flushAt'))
      .toBeGreaterThanOrEqual(before + DAY_MS);
    expect(o.storage.values.get('meta:dirty')).toBe(true);
    await expect
      .poll(() => o.storage.alarm())
      .toBe(o.storage.values.get('meta:flushAt'));

    // Not idle while the write is unflushed, however old the last request.
    o.ageAccess();
    expect(await o.call('stillIdle', o.db)).toBe(false);
    // The flush uploaded this generation: clean again, evictable.
    o.storage.values.set('meta:uploadedGen', o.db.writeGeneration);
    await o.call('clearDirty');
    expect(await o.call('stillIdle', o.db)).toBe(true);
  });

  it('marks a Start whose insert committed before a later step failed', async () => {
    const o = bootedObject({ startThrows: true });
    await expect(o.rpc({ action: 'start', request })).rejects.toThrow(
      'Alarm storage unavailable',
    );
    expect(Reflect.get(o.host, 'dirty')).toBe(true);
    o.ageAccess();
    expect(await o.call('stillIdle', o.db)).toBe(false);
  });

  it('waits for an idle eviction in progress before Start and records the access', async () => {
    const o = bootedObject();
    o.ageAccess();
    let finishWipe: () => void = () => undefined;
    const wipe = new Promise<void>((resolve) => {
      finishWipe = resolve;
    });
    Reflect.set(
      o.host,
      'evicting',
      wipe.finally(() => Reflect.set(o.host, 'evicting', null)),
    );
    const starting = o.rpc({ action: 'start', request });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(o.scheduler.startTopicDeliverable).not.toHaveBeenCalled();
    finishWipe();
    await starting;
    expect(o.scheduler.startTopicDeliverable).toHaveBeenCalledTimes(1);
    const access = o.storage.values.get('meta:lastAccessAt');
    expect(typeof access === 'number' && Date.now() - access < 60_000).toBe(
      true,
    );
    expect(await o.call('stillIdle', o.db)).toBe(false);
  });
});
