import { describe, expect, it } from 'vitest';
import type { Evidence } from './drafts';
import {
  cardRequestKey,
  cardSummary,
  EVIDENCE_LINK_MARGIN_S,
  lapsedEvidence,
  MAX_CARD_ROWS,
  REVIEW_PAGE_CHARS,
  reviewPages,
} from './submission';

describe('the card shows everything it sends', () => {
  it('splits a long answer over rows instead of cutting it', () => {
    const story = 'a'.repeat(1_100);
    const rows = cardSummary([{ label: 'Describe it', value: story }]);
    expect(rows?.map((row) => row.label)).toEqual([
      'Describe it (1/3)',
      'Describe it (2/3)',
      'Describe it (3/3)',
    ]);
    expect(rows?.map((row) => row.value).join('')).toBe(story);
    expect(rows?.every((row) => row.value.length <= 500)).toBe(true);
  });

  it('never splits a character in two', () => {
    const value = `${'a'.repeat(499)}😀b`;
    const rows = cardSummary([{ label: 'x', value }])!;
    expect(rows[0]!.value).toBe('a'.repeat(499));
    expect(rows.map((row) => row.value).join('')).toBe(value);
  });

  it('refuses rather than hide answers past the rows one card shows', () => {
    const rows = Array.from({ length: MAX_CARD_ROWS + 1 }, (_, i) => ({
      label: `Q${i}`,
      value: 'yes',
    }));
    expect(cardSummary(rows)).toBeUndefined();
    expect(cardSummary(rows.slice(0, MAX_CARD_ROWS))).toHaveLength(
      MAX_CARD_ROWS,
    );
    expect(cardSummary([])).toEqual([
      { label: 'Answers', value: 'No answers' },
    ]);
  });

  it('pages a long read-back without leaving anything out', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      label: `Question ${i}`,
      value: 'x'.repeat(480),
    }));
    const pages = reviewPages(rows);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(rows);
    for (const page of pages)
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(
        REVIEW_PAGE_CHARS + 2,
      );
    expect(reviewPages([])).toEqual([[]]);
  });
});

describe('request keys', () => {
  const base = {
    ownerDid: 'did:ixo:ixo1a',
    runId: 'run-1',
    toolCallId: 'tool-1',
    cardAttempt: 0,
  };

  it('gives every send its own key, and two people never the same one', async () => {
    const key = await cardRequestKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await cardRequestKey(base)).toBe(key);
    for (const change of [
      { ownerDid: 'did:ixo:ixo1b' },
      { runId: 'run-2' },
      { toolCallId: 'tool-2' },
      { cardAttempt: 1 },
    ])
      expect(await cardRequestKey({ ...base, ...change })).not.toBe(key);
  });
});

describe('file links', () => {
  const now = Date.UTC(2026, 9, 30);
  const file = (url: string): Evidence => ({
    path: 'photo',
    url,
    filename: 'a.jpg',
    mimetype: 'image/jpeg',
    size: 1,
    sha256: 'a'.repeat(64),
    kind: 'image',
    receivedAt: '2026-10-01T00:00:00.000Z',
  });
  const at = (s: number) =>
    `https://channels.test/media/binding/abc?exp=${s}&sig=x`;

  it('finds a gateway link that lapses before the Hub could fetch it', () => {
    const fresh = file(at(now / 1000 + EVIDENCE_LINK_MARGIN_S + 60));
    const soon = file(at(now / 1000 + 60));
    const gone = file(at(now / 1000 - 1));
    expect(lapsedEvidence([fresh, soon, gone], now)).toEqual([soon, gone]);
    // No `exp`: left to the Hub's own check.
    expect(
      lapsedEvidence([file('https://channels.test/media/b/x')], now),
    ).toEqual([]);
    expect(lapsedEvidence([file(at(Number.NaN))], now)).toHaveLength(1);
  });
});
