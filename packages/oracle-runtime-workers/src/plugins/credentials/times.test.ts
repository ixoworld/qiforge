import { describe, expect, it } from 'vitest';
import {
  CredentialsServiceError,
  MESSAGES,
  NO_LATER_MESSAGE,
  refusal,
  refusalFor,
} from './errors';
import * as runtime from '../../index';
import { relativeTime, SelfTime, selfTimeSeconds, whenItEnds } from './times';

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

describe('relativeTime', () => {
  it.each([
    [1, 'in 1 minute'],
    [59, 'in 1 minute'],
    [60, 'in 1 minute'],
    [61, 'in 2 minutes'],
    [15 * MIN, 'in 15 minutes'],
    // A 15-minute link read a moment after Self made it.
    [15 * MIN - 0.4, 'in 15 minutes'],
    [59 * MIN, 'in 59 minutes'],
    [59 * MIN + 1, 'in about 1 hour'],
    [HOUR, 'in about 1 hour'],
    [HOUR + 29 * MIN, 'in about 1 hour'],
    [HOUR + 30 * MIN, 'in about 2 hours'],
    [2 * HOUR, 'in about 2 hours'],
    [23 * HOUR + 29 * MIN, 'in about 23 hours'],
    [23 * HOUR + 30 * MIN, 'in about 1 day'],
    [DAY, 'in about 1 day'],
    [DAY + 12 * HOUR, 'in about 2 days'],
    [7 * DAY, 'in about 7 days'],
  ])('%s s → %s', (seconds, words) => {
    expect(relativeTime(seconds)).toBe(words);
  });
});

describe('whenItEnds', () => {
  const NOW_MS = Date.UTC(2026, 10, 10, 6, 19);
  const ENDS = Date.UTC(2026, 10, 10, 6, 34) / 1000;

  it('is relative without a zone, never naming UTC', () => {
    expect(whenItEnds(ENDS, { nowMs: NOW_MS })).toBe('in 15 minutes');
  });

  it("is the person's local time when their zone is known", () => {
    expect(whenItEnds(ENDS, { timeZone: 'Asia/Tbilisi', nowMs: NOW_MS })).toBe(
      'at 10:34',
    );
    expect(whenItEnds(ENDS, { timeZone: 'UTC', nowMs: NOW_MS })).toBe(
      'at 06:34',
    );
  });

  it('is relative for a zone name the runtime does not know', () => {
    expect(whenItEnds(ENDS, { timeZone: 'Mars/Olympus', nowMs: NOW_MS })).toBe(
      'in 15 minutes',
    );
  });

  it('is null once the moment has passed, with or without a zone', () => {
    expect(whenItEnds(ENDS, { nowMs: ENDS * 1000 })).toBeNull();
    expect(whenItEnds(ENDS, { nowMs: ENDS * 1000 + 1 })).toBeNull();
    expect(
      whenItEnds(ENDS, { timeZone: 'Asia/Tbilisi', nowMs: ENDS * 1000 + 1 }),
    ).toBeNull();
  });
});

describe('selfTimeSeconds', () => {
  it('reads ISO 8601 with a zone and Unix seconds', () => {
    const s = Date.UTC(2026, 10, 10, 6, 34, 12) / 1000;
    expect(selfTimeSeconds('2026-11-10T06:34:12.000Z')).toBe(s);
    expect(selfTimeSeconds('2026-11-10T06:34:12.999Z')).toBe(s);
    expect(selfTimeSeconds('2026-11-10T10:34:12+04:00')).toBe(s);
    expect(selfTimeSeconds(s)).toBe(s);
  });

  it('refuses anything else', () => {
    for (const raw of [
      '2026-11-10T06:34:12',
      '2026-11-10',
      '1793000000',
      'soon',
      -1,
      1.5,
      null,
      undefined,
      {},
    ])
      expect(selfTimeSeconds(raw)).toBeNull();
  });
});

describe('refusalFor: link_active', () => {
  const NOW_MS = Date.UTC(2026, 10, 10, 6, 19);
  const linkActive = (expiresAt: unknown) =>
    new CredentialsServiceError({
      service: 'self',
      status: 409,
      code: 'link_active',
      body: {
        error: { code: 'link_active', message: 'x', retryable: false },
        linkId: 'lnk_0',
        status: 'in_progress',
        expiresAt,
      },
    });

  it('says when it ends in plain words without a zone (ISO and seconds)', () => {
    for (const ends of [
      '2026-11-10T06:34:00.000Z',
      Date.UTC(2026, 10, 10, 6, 34) / 1000,
    ])
      expect(refusalFor(linkActive(ends), { nowMs: NOW_MS })).toEqual({
        error: 'link_active',
        message:
          'Your identity check is already in progress; it ends in 15 minutes. Please carry on with it.',
        hint: `Its link cannot be sent again. ${NO_LATER_MESSAGE}`,
      });
  });

  it("says the person's local time when their zone is known", () => {
    expect(
      refusalFor(linkActive('2026-11-10T06:34:00.000Z'), {
        timeZone: 'Asia/Tbilisi',
        nowMs: NOW_MS,
      }).message,
    ).toBe(
      'Your identity check is already in progress; it ends at 10:34. Please carry on with it.',
    );
  });

  it('names no end once it has passed, or when Self named none', () => {
    const plain =
      'Your identity check is already in progress. Please carry on with it.';
    expect(
      refusalFor(linkActive('2026-11-10T06:00:00.000Z'), { nowMs: NOW_MS })
        .message,
    ).toBe(plain);
    expect(refusalFor(linkActive(undefined), { nowMs: NOW_MS }).message).toBe(
      plain,
    );
  });
});

describe("refusalFor: Self's codes", () => {
  const selfError = (status: number, code: string) =>
    new CredentialsServiceError({ service: 'self', status, code });

  it('maps the codes Self names on its link routes', () => {
    expect(refusalFor(selfError(409, 'already_verified'))).toEqual(
      refusal('already_verified', MESSAGES.alreadyVerified),
    );
    expect(refusalFor(selfError(429, 'rate_limited'))).toEqual(
      refusal('rate_limited', MESSAGES.rateLimited),
    );
    expect(refusalFor(selfError(400, 'offer_consent_invalid'))).toEqual(
      refusal('offer_consent_invalid', MESSAGES.permissionEnded),
    );
    expect(refusalFor(selfError(401, 'unauthorized'))).toEqual(
      refusal('unauthorized', MESSAGES.notConfirmed),
    );
    expect(refusalFor(selfError(403, 'forbidden'))).toEqual(
      refusal('forbidden', MESSAGES.permissionEnded),
    );
    expect(refusalFor(selfError(404, 'not_found'))).toEqual(
      refusal('not_found', MESSAGES.notFound),
    );
    expect(refusalFor(selfError(503, 'auth_unavailable'))).toEqual(
      refusal('auth_unavailable', MESSAGES.busy),
    );
  });
});

describe('the public exports', () => {
  it('exports the wording helpers from the package root, so other plugins use the same words', () => {
    expect(runtime.relativeTime).toBe(relativeTime);
    expect(runtime.whenItEnds).toBe(whenItEnds);
    expect(runtime.SelfTime).toBe(SelfTime);
    expect(runtime.selfTimeSeconds).toBe(selfTimeSeconds);
    expect(runtime.relativeTime(2 * HOUR)).toBe('in about 2 hours');
  });
});
