import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactSweepIntervalMs } from './config';
import {
  ARTIFACT_SWEEP_STATE_KEY,
  sweepExpiredArtifacts,
  type ArtifactSweepState,
  type SweepOptions,
} from './sweep';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      ARTIFACT_TEST: R2Bucket;
    }
  }
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T03:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-11-01T00:00:00.000Z';

const bucket = () => env.ARTIFACT_TEST;

async function clearBucket(): Promise<void> {
  for (;;) {
    const page = await bucket().list();
    if (page.objects.length > 0)
      await bucket().delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
}

async function seed(
  key: string,
  customMetadata?: Record<string, string>,
): Promise<void> {
  await bucket().put(
    key,
    'ciphertext',
    customMetadata ? { customMetadata } : {},
  );
}

async function keys(): Promise<string[]> {
  const page = await bucket().list();
  return page.objects.map((o) => o.key).sort();
}

async function state(): Promise<ArtifactSweepState | null> {
  const object = await bucket().get(ARTIFACT_SWEEP_STATE_KEY);
  return object ? JSON.parse(await object.text()) : null;
}

function logger() {
  return { log: vi.fn(), error: vi.fn() };
}

function sweep(overrides: Partial<SweepOptions> = {}) {
  return sweepExpiredArtifacts({
    bucket: bucket(),
    now: NOW,
    intervalMs: 24 * HOUR,
    log: logger(),
    ...overrides,
  });
}

describe('sweepExpiredArtifacts', () => {
  beforeEach(clearBucket);
  afterEach(() => vi.restoreAllMocks());

  it('deletes expired share copies and keeps fresh ones', async () => {
    await seed('art/expired', { expiresAt: PAST });
    await seed('art/expires-now', { expiresAt: new Date(NOW).toISOString() });
    await seed('art/fresh', { expiresAt: FUTURE });
    const log = logger();

    const outcome = await sweep({ log });

    expect(outcome).toMatchObject({
      skipped: false,
      done: true,
      pages: 1,
      seen: 3,
      deleted: 2,
      unknown: 0,
      resumed: false,
    });
    expect(await keys()).toEqual(['art/fresh', ARTIFACT_SWEEP_STATE_KEY]);
    expect(await state()).toEqual({
      v: 1,
      sweptAt: new Date(NOW).toISOString(),
      cursor: null,
    });
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0]?.[0]).toMatch(
      /^\[artifacts\] sweep finished: pages=1 seen=3 deleted=2 unknown=0 resumed=false elapsedMs=\d+$/,
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps objects without a readable expiresAt and counts them as unknown', async () => {
    await seed('art/no-metadata');
    await seed('art/other-metadata', { owner: 'x' });
    await seed('art/malformed', { expiresAt: 'next tuesday' });
    await seed('art/expired', { expiresAt: PAST });

    const outcome = await sweep();

    expect(outcome).toMatchObject({
      done: true,
      seen: 4,
      deleted: 1,
      unknown: 3,
    });
    expect(await keys()).toEqual([
      'art/malformed',
      'art/no-metadata',
      'art/other-metadata',
      ARTIFACT_SWEEP_STATE_KEY,
    ]);
  });

  it('only lists art/: the state object and other prefixes are never deleted', async () => {
    await seed('art/expired', { expiresAt: PAST });
    await seed('results/expired', { expiresAt: PAST });
    await bucket().put(
      ARTIFACT_SWEEP_STATE_KEY,
      JSON.stringify({ v: 1, sweptAt: PAST, cursor: null }),
    );
    const del = vi.spyOn(bucket(), 'delete');

    await sweep();

    expect(await keys()).toEqual([ARTIFACT_SWEEP_STATE_KEY, 'results/expired']);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls.flatMap(([batch]) => batch)).toEqual(['art/expired']);
  });

  it('pages through the prefix, stops at maxPages and resumes from the stored cursor', async () => {
    const expected: string[] = [];
    for (let i = 0; i < 7; i++) {
      const key = `art/${String(i).padStart(2, '0')}`;
      const fresh = i % 3 === 0;
      await seed(key, { expiresAt: fresh ? FUTURE : PAST });
      if (fresh) expected.push(key);
    }
    const list = vi.spyOn(bucket(), 'list');

    const first = await sweep({ pageSize: 2, maxPages: 2 });

    expect(first).toMatchObject({
      skipped: false,
      done: false,
      pages: 2,
      seen: 4,
      resumed: false,
    });
    expect(list).toHaveBeenCalledTimes(2);
    for (const [options] of list.mock.calls)
      expect(options).toMatchObject({
        prefix: 'art/',
        limit: 2,
        include: ['customMetadata'],
      });
    const paused = await state();
    expect(paused).toMatchObject({ v: 1, sweptAt: null });
    expect(typeof paused?.cursor).toBe('string');

    // Inside the interval, yet an unfinished sweep resumes.
    const second = await sweep({ pageSize: 2, maxPages: 2, now: NOW + HOUR });

    expect(second).toMatchObject({
      skipped: false,
      done: true,
      pages: 2,
      seen: 3,
      resumed: true,
    });
    expect(list.mock.calls[2]?.[0]).toMatchObject({ cursor: paused?.cursor });
    expect(await state()).toEqual({
      v: 1,
      sweptAt: new Date(NOW + HOUR).toISOString(),
      cursor: null,
    });
    expect(await keys()).toEqual([...expected, ARTIFACT_SWEEP_STATE_KEY]);
  });

  it('skips with one state read and no list, write or log inside the interval, and sweeps again after it', async () => {
    await seed('art/fresh', { expiresAt: FUTURE });
    await sweep();
    const after = await state();
    await seed('art/expired', { expiresAt: PAST });
    const get = vi.spyOn(bucket(), 'get');
    const list = vi.spyOn(bucket(), 'list');
    const put = vi.spyOn(bucket(), 'put');
    const del = vi.spyOn(bucket(), 'delete');
    const log = logger();

    const skipped = await sweep({ now: NOW + 23 * HOUR, log });

    expect(skipped).toEqual({ skipped: true });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ARTIFACT_SWEEP_STATE_KEY);
    expect(list).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(log.log).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(await state()).toEqual(after);

    const again = await sweep({ now: NOW + 24 * HOUR, log });

    expect(again).toMatchObject({ skipped: false, done: true, deleted: 1 });
    expect(list).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(await keys()).toEqual(['art/fresh', ARTIFACT_SWEEP_STATE_KEY]);
  });

  it('deletes in batches of at most deleteBatchSize keys', async () => {
    for (let i = 0; i < 5; i++) await seed(`art/${i}`, { expiresAt: PAST });
    const del = vi.spyOn(bucket(), 'delete');

    const outcome = await sweep({ pageSize: 5, deleteBatchSize: 2 });

    expect(outcome).toMatchObject({ done: true, deleted: 5 });
    expect(del.mock.calls.map(([batch]) => batch)).toEqual([
      ['art/0', 'art/1'],
      ['art/2', 'art/3'],
      ['art/4'],
    ]);
    expect(await keys()).toEqual([ARTIFACT_SWEEP_STATE_KEY]);
  });

  it('contains a failing list: logs once, returns the error, writes no state', async () => {
    await seed('art/expired', { expiresAt: PAST });
    vi.spyOn(bucket(), 'list').mockRejectedValueOnce(new Error('R2 is down'));
    const put = vi.spyOn(bucket(), 'put');
    const log = logger();

    const outcome = await sweep({ log });

    expect(outcome).toMatchObject({ skipped: false, error: 'R2 is down' });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toMatch(
      /^\[artifacts\] sweep failed: R2 is down/,
    );
    expect(log.log).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await keys()).toEqual(['art/expired']);
  });

  it('drops a stored cursor the first list rejects, so the next tick starts over', async () => {
    await seed('art/expired', { expiresAt: PAST });
    const sweptAt = new Date(NOW - 48 * HOUR).toISOString();
    await bucket().put(
      ARTIFACT_SWEEP_STATE_KEY,
      JSON.stringify({ v: 1, sweptAt, cursor: 'stale' }),
    );
    vi.spyOn(bucket(), 'list').mockRejectedValueOnce(
      new Error('invalid cursor'),
    );
    const log = logger();

    const failed = await sweep({ log });

    expect(failed).toMatchObject({
      skipped: false,
      error: 'invalid cursor',
      resumed: true,
      pages: 0,
    });
    expect(await state()).toEqual({ v: 1, sweptAt, cursor: null });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0]?.[0]).toMatch(/dropped its stored cursor/);
    expect(await keys()).toEqual(['art/expired', ARTIFACT_SWEEP_STATE_KEY]);

    const recovered = await sweep({ log });

    expect(recovered).toMatchObject({
      skipped: false,
      done: true,
      deleted: 1,
      resumed: false,
    });
    expect(await keys()).toEqual([ARTIFACT_SWEEP_STATE_KEY]);
  });

  it.each([
    ['not JSON', 'not json'],
    [
      'an unknown version',
      JSON.stringify({ v: 2, sweptAt: PAST, cursor: null }),
    ],
    ['a wrong shape', JSON.stringify({ v: 1, sweptAt: 7 })],
  ])(
    'treats a state object holding %s as never swept',
    async (_label, body) => {
      // Recent enough to skip, were the state readable.
      await bucket().put(ARTIFACT_SWEEP_STATE_KEY, body);
      await seed('art/expired', { expiresAt: PAST });

      const outcome = await sweep({ now: Date.parse(PAST) + HOUR });

      expect(outcome).toMatchObject({ skipped: false, done: true, deleted: 1 });
      expect(await state()).toEqual({
        v: 1,
        sweptAt: new Date(Date.parse(PAST) + HOUR).toISOString(),
        cursor: null,
      });
    },
  );
});

describe('artifactSweepIntervalMs', () => {
  it('defaults to 24 hours, takes 1–168 and warns on anything else', () => {
    const warn = vi.fn();
    expect(artifactSweepIntervalMs({}, warn)).toBe(24 * HOUR);
    expect(
      artifactSweepIntervalMs({ ARTIFACT_SWEEP_INTERVAL_HOURS: '6' }, warn),
    ).toBe(6 * HOUR);
    expect(
      artifactSweepIntervalMs({ ARTIFACT_SWEEP_INTERVAL_HOURS: '168' }, warn),
    ).toBe(168 * HOUR);
    expect(warn).not.toHaveBeenCalled();
    for (const bad of ['0', '169', '1.5', 'daily']) {
      expect(
        artifactSweepIntervalMs({ ARTIFACT_SWEEP_INTERVAL_HOURS: bad }, warn),
      ).toBe(24 * HOUR);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^\[artifacts\] ARTIFACT_SWEEP_INTERVAL_HOURS must be a whole number from 1 to 168/,
    );
  });
});
