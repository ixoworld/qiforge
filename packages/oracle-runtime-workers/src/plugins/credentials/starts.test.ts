import { describe, expect, it } from 'vitest';
import { CredentialsServiceError, refusalFor } from './errors';
import {
  friendlyWait,
  limitSentence,
  limitWait,
  startsLeftSentence,
  startsOf,
} from './starts';

const NOW = Date.UTC(2026, 10, 14, 6, 0);
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

describe('friendlyWait: the wait in words', () => {
  it.each([
    [1, 'in a minute'],
    [60, 'in a minute'],
    [61, 'in a few minutes'],
    [4 * 60 + 59, 'in a few minutes'],
    [5 * 60, 'in about 5 minutes'],
    [12 * 60 + 1, 'in about 13 minutes'],
    [15 * 60, 'in about 15 minutes'],
    [36 * 60, 'in about 40 minutes'],
    [40 * 60, 'in about 40 minutes'],
    [41 * 60, 'in about 45 minutes'],
    [89 * 60, 'in about 90 minutes'],
    [89 * 60 + 59, 'in about 90 minutes'],
    [90 * 60, 'in about 2 hours'],
    [2 * 3600 + 29 * 60, 'in about 2 hours'],
    [4 * 3600 + 40 * 60, 'in about 5 hours'],
    [5 * 3600 + 48 * 60, 'in about 6 hours'],
    [23 * 3600 + 40 * 60, 'in about 24 hours'],
  ])('%i s -> %s', (seconds, words) => {
    expect(friendlyWait(seconds)).toBe(words);
  });

  it('says "in a minute" only when it is at most a minute', () => {
    for (let s = 61; s < 6 * 3600; s += 37)
      expect(friendlyWait(s)).not.toBe('in a minute');
  });

  it('never says "about 1 hours" or "0": 2 hours at least once in hours', () => {
    for (let s = 85 * 60; s < 3 * 3600; s += 7)
      expect(friendlyWait(s)).not.toMatch(/ [01] hours/);
  });

  it('never tells minutes that come before the real time', () => {
    for (let s = 5 * 60; s < 90 * 60; s += 13) {
      const told = Number(/(\d+) minutes/.exec(friendlyWait(s))?.[1]);
      expect(told * 60).toBeGreaterThanOrEqual(s);
    }
  });
});

describe('startsLeftSentence', () => {
  it.each([
    [2, 'You can try 2 more times.'],
    [1, 'You can try 1 more time.'],
  ])('%i', (n, words) => expect(startsLeftSentence(n)).toBe(words));
});

describe('startsOf: what Self said about starts', () => {
  it('reads the new fields (top level)', () => {
    expect(
      startsOf(
        {
          resetsAt: at(5 * 3600),
          retryAfterSeconds: 5 * 3600,
          startsLeft: 0,
          startsMax: 3,
          windowHours: 6,
        },
        NOW,
      ),
    ).toEqual({
      resetsAt: NOW / 1000 + 5 * 3600,
      startsLeft: 0,
      startsMax: 3,
      windowHours: 6,
    });
  });

  it("reads today's link status (`limit: { code, resetsAt }`)", () => {
    expect(
      startsOf({ limit: { code: 'daily_limit', resetsAt: at(600) } }, NOW),
    ).toEqual({ resetsAt: NOW / 1000 + 600, limited: true });
  });

  it('turns a wait in seconds (body, else Retry-After) into a time', () => {
    expect(startsOf({ retryAfterSeconds: 120 }, NOW)).toEqual({
      resetsAt: NOW / 1000 + 120,
    });
    expect(startsOf({}, NOW, 300, 'daily_limit')).toEqual({
      resetsAt: NOW / 1000 + 300,
      limited: true,
    });
  });

  it('is lenient: wrong types or ranges are unknown, nothing is undefined', () => {
    expect(
      startsOf(
        {
          startsLeft: -1,
          startsMax: '3',
          windowHours: 0,
          resetsAt: 'tomorrow',
          retryAfterSeconds: 1.5,
        },
        NOW,
      ),
    ).toBeUndefined();
    expect(startsOf(null, NOW)).toBeUndefined();
    expect(startsOf({ startsLeft: 2 }, NOW)).toEqual({ startsLeft: 2 });
  });
});

describe('limitWait and limitSentence', () => {
  it('holds only while the limit is reached and its reset is ahead', () => {
    expect(limitWait({ startsLeft: 1 }, NOW)).toBeNull();
    expect(limitWait({ startsLeft: 0 }, NOW)).toBe(0);
    expect(limitWait({ limited: true, resetsAt: NOW / 1000 + 60 }, NOW)).toBe(
      60,
    );
    expect(
      limitWait({ startsLeft: 0, resetsAt: NOW / 1000 - 1 }, NOW),
    ).toBeNull();
  });

  it('words the wait, with the number of tries when Self said it', () => {
    expect(limitSentence({ startsMax: 3 }, 5 * 3600)).toBe(
      "You've used your 3 tries for now. You can try again in about 5 hours. Just message me then and I'll send you a new link.",
    );
    expect(limitSentence(undefined, 40 * 60)).toBe(
      "You've used all your tries for now. You can try again in about 40 minutes. Just message me then and I'll send you a new link.",
    );
    expect(limitSentence({ startsMax: 3 }, 0)).toBe(
      "You've used your 3 tries for now. You can try again later today. Just message me then and I'll send you a new link.",
    );
  });
});

describe('refusalFor: 429 daily_limit', () => {
  const limited = (body: Record<string, unknown>, retryAfterSeconds?: number) =>
    new CredentialsServiceError({
      service: 'self',
      status: 429,
      code: 'daily_limit',
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      body: {
        error: {
          code: 'daily_limit',
          message: 'You can start up to 3 verifications a day.',
        },
        ...body,
      },
    });

  it("today's Self (resetsAt + Retry-After): the time from resetsAt, never 'in a minute'", () => {
    const answer = refusalFor(
      limited({ resetsAt: at(23 * 3600 + 10 * 60) }, 23 * 3600 + 10 * 60),
      { nowMs: NOW },
    );
    expect(answer).toMatchObject({
      error: 'daily_limit',
      message:
        "You've used all your tries for now. You can try again in about 23 hours. Just message me then and I'll send you a new link.",
      limit: {
        code: 'daily_limit',
        resetsAt: at(23 * 3600 + 10 * 60),
        retryAfterSeconds: 23 * 3600 + 10 * 60,
        tryAgain: 'in about 23 hours',
        startsLeft: 0,
      },
    });
    expect(answer.message).not.toContain('in a minute');
    expect(answer.hint).toContain('Do not create, offer or promise a new link');
    expect(answer.hint).toContain('"tomorrow" only if');
    expect(answer.hint).toContain('call credentials_request_action');
  });

  it('the new fields: the number of tries and the wait', () => {
    expect(
      refusalFor(
        limited({
          resetsAt: at(5 * 3600),
          retryAfterSeconds: 5 * 3600,
          startsLeft: 0,
          startsMax: 3,
          windowHours: 6,
        }),
        { nowMs: NOW },
      ),
    ).toMatchObject({
      message:
        "You've used your 3 tries for now. You can try again in about 5 hours. Just message me then and I'll send you a new link.",
      limit: { startsMax: 3, windowHours: 6, tryAgain: 'in about 5 hours' },
    });
  });

  it('only Retry-After: the wait from it', () => {
    expect(refusalFor(limited({}, 40 * 60), { nowMs: NOW })).toMatchObject({
      message:
        "You've used all your tries for now. You can try again in about 40 minutes. Just message me then and I'll send you a new link.",
    });
  });

  it('no time at all: "later today"', () => {
    const answer = refusalFor(limited({}), { nowMs: NOW });
    expect(answer.message).toBe(
      "You've used all your tries for now. You can try again later today. Just message me then and I'll send you a new link.",
    );
    expect(answer.limit).toEqual({
      code: 'daily_limit',
      tryAgain: 'later today',
      startsLeft: 0,
    });
  });

  it('recomputes the wait each time it is asked', () => {
    const error = limited({ resetsAt: at(5 * 3600) });
    expect(refusalFor(error, { nowMs: NOW }).message).toContain(
      'in about 5 hours',
    );
    expect(
      refusalFor(error, { nowMs: NOW + (4 * 3600 + 20 * 60) * 1000 }).message,
    ).toContain('in about 40 minutes');
    expect(
      refusalFor(error, { nowMs: NOW + (5 * 3600 - 120) * 1000 }).message,
    ).toContain('in a few minutes');
  });
});
