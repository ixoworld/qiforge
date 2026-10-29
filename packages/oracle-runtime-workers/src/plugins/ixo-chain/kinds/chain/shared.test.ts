import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Outcome } from '../../http';
import { chainFetch, contextOf } from './fixtures/context';
import {
  DEC_ONE,
  ReadCache,
  decMul,
  decQuo,
  decPercent,
  durationText,
  parseDec,
  setDuration,
  sharePercent,
} from './shared';
import { wholeUnits } from '../coins';

afterEach(() => {
  vi.useRealTimers();
});

describe('decimals', () => {
  it('parses LegacyDec strings exactly and refuses anything else', () => {
    expect(parseDec('1')).toBe(DEC_ONE);
    expect(parseDec('0.666666666666666666')).toBe(666_666_666_666_666_666n);
    expect(parseDec('28999999999.999999971000000000')).toBe(
      28_999_999_999_999_999_971_000_000_000n,
    );
    expect(parseDec('28999999999.999999971')).toBe(
      28_999_999_999_999_999_971_000_000_000n,
    );
    for (const bad of ['-1', '1e6', '.5', '01', '', `0.${'1'.repeat(19)}`])
      expect(parseDec(bad)).toBeNull();
  });

  it('multiplies as LegacyDec does: rounded half to even at 18 places', () => {
    const half = 500_000_000_000_000_000n;
    // 0.5 × 0.000000000000000001 = 5e-19: exactly half a unit, rounds to even (0).
    expect(decMul(half, 1n)).toBe(0n);
    // 1.5e-18 rounds to 2e-18.
    expect(decMul(3n * half, 1n)).toBe(2n);
    expect(decMul(43_500_000_000n * DEC_ONE, 666_666_666_666_666_666n)).toBe(
      28_999_999_999_999_999_971_000_000_000n,
    );
  });

  it('divides as LegacyDec.Quo does: truncated at 36 places, then rounded half to even at 18', () => {
    expect(decQuo(DEC_ONE, 3n * DEC_ONE)).toBe(333_333_333_333_333_333n);
    expect(decQuo(2n * DEC_ONE, 3n * DEC_ONE)).toBe(666_666_666_666_666_667n);
    // 5,740,000 PAY units × 1.0313590143 IXO per unit: 5,920,000.742082 uixo.
    expect(
      decQuo(5_740_000n * 10_313_590_143n * DEC_ONE, 10_000_000_000n * DEC_ONE),
    ).toBe(5_920_000_742_082_000_000_000_000n);
  });

  it('shows rates, shares and whole units', () => {
    expect(decPercent('0.100000000000000000')).toBe('10%');
    expect(decPercent('0.333333333333333333')).toBe('33.33%');
    expect(decPercent('nope')).toBeNull();
    expect(sharePercent(1n, 3n)).toBe('33.33%');
    expect(sharePercent(0n, 0n)).toBe('0%');
    expect(wholeUnits('570925.434280604784000000')).toBe('570925');
    expect(wholeUnits('12')).toBe('12');
    expect(wholeUnits('-3')).toBeNull();
  });

  it('puts durations in words', () => {
    expect(durationText('86400s')).toBe('1 day');
    expect(durationText('2592000s')).toBe('30 days');
    expect(durationText('5400s')).toBe('90 minutes');
    expect(durationText('3600.5s')).toBe('1 hour');
    expect(durationText('45s')).toBe('45 seconds');
    expect(durationText('soon')).toBe('soon');
    expect(setDuration('0s')).toBeNull();
    expect(setDuration(null)).toBeNull();
    expect(setDuration('60s')).toBe('1 minute');
  });
});

describe('ReadCache', () => {
  const ctx = () => contextOf(chainFetch({}));
  const found = (value: string): Outcome<string> => ({ ok: true, value });

  it('keeps a value for its TTL, keyed by REST base and key', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
    const cache = new ReadCache<string>(1_000, 10);
    const read = vi.fn(async () => found('a'));
    await cache.get(ctx(), 'k', read);
    await cache.get(ctx(), 'k', read);
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_001);
    await cache.get(ctx(), 'k', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failure', async () => {
    const cache = new ReadCache<string>(60_000, 10);
    const failure: Outcome<string> = {
      ok: false,
      failure: { reason: 'timeout', detail: 'x', retryable: true },
    };
    const read = vi.fn(async () => failure);
    await cache.get(ctx(), 'k', read);
    await cache.get(ctx(), 'k', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares a read in flight', async () => {
    const cache = new ReadCache<string>(60_000, 10);
    let release: (value: Outcome<string>) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<Outcome<string>>((resolve) => {
          release = resolve;
        }),
    );
    const both = Promise.all([
      cache.get(ctx(), 'k', read),
      cache.get(ctx(), 'k', read),
    ]);
    release(found('a'));
    expect(await both).toEqual([found('a'), found('a')]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again itself when the shared read ended in another turn's abort", async () => {
    const cache = new ReadCache<string>(60_000, 10);
    let fail: (error: Error) => void = () => undefined;
    const aborted = vi.fn(
      () =>
        new Promise<Outcome<string>>((_, reject) => {
          fail = reject;
        }),
    );
    const own = vi.fn(async () => found('mine'));
    const first = cache.get(ctx(), 'k', aborted);
    const second = cache.get(ctx(), 'k', own);
    fail(new DOMException('Aborted', 'AbortError'));
    await expect(first).rejects.toThrow('Aborted');
    expect(await second).toEqual(found('mine'));
  });

  it('reads again itself when the shared read timed out and its own budget allows', async () => {
    const cache = new ReadCache<string>(60_000, 10);
    const timedOut: Outcome<string> = {
      ok: false,
      failure: { reason: 'timeout', detail: 'x', retryable: true },
    };
    let finish: (value: Outcome<string>) => void = () => undefined;
    const shared = vi.fn(
      () =>
        new Promise<Outcome<string>>((resolve) => {
          finish = resolve;
        }),
    );
    const own = vi.fn(async () => found('mine'));
    const first = cache.get(ctx(), 'k', shared);
    const second = cache.get(ctx(), 'k', own);
    finish(timedOut);
    expect(await first).toEqual(timedOut);
    expect(await second).toEqual(found('mine'));
    // Without the budget for an attempt, the shared timeout is the answer.
    const late = contextOf(chainFetch({}), { deadline: Date.now() + 500 });
    const third = cache.get(ctx(), 'j', shared);
    const fourth = cache.get(late, 'j', own);
    finish(timedOut);
    expect(await third).toEqual(timedOut);
    expect(await fourth).toEqual(timedOut);
    expect(own).toHaveBeenCalledTimes(1);
    // Any other failure is shared as it is.
    const unavailable: Outcome<string> = {
      ok: false,
      failure: { reason: 'unavailable', detail: 'y', retryable: true },
    };
    const fifth = cache.get(ctx(), 'i', shared);
    const sixth = cache.get(ctx(), 'i', own);
    finish(unavailable);
    expect(await fifth).toEqual(unavailable);
    expect(await sixth).toEqual(unavailable);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("throws its own turn's abort at once while it waits on a shared read", async () => {
    const cache = new ReadCache<string>(60_000, 10);
    let finish: (value: Outcome<string>) => void = () => undefined;
    const shared = vi.fn(
      () =>
        new Promise<Outcome<string>>((resolve) => {
          finish = resolve;
        }),
    );
    const turn = new AbortController();
    const launching = cache.get(ctx(), 'k', shared);
    const joining = cache.get(
      contextOf(chainFetch({}), { signal: turn.signal }),
      'k',
      shared,
    );
    const reason = new Error('joiner cancelled');
    turn.abort(reason);
    await expect(joining).rejects.toBe(reason);
    finish(found('a'));
    expect(await launching).toEqual(found('a'));
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest entry past its size cap', async () => {
    const cache = new ReadCache<string>(60_000, 2);
    const read = vi.fn(async () => found('v'));
    for (const key of ['a', 'b', 'c']) await cache.get(ctx(), key, read);
    await cache.get(ctx(), 'c', read);
    await cache.get(ctx(), 'b', read);
    expect(read).toHaveBeenCalledTimes(3);
    await cache.get(ctx(), 'a', read);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
