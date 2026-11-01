import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOperation, submissionSummaryIssue } from '@ixo/action-protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Evidence } from './drafts';
import {
  gridCell,
  loadSurveyCore,
  openModel,
  questionAt,
  setAnswer,
  visibleQuestions,
  type FormQuestion,
} from './engine';
import {
  buildApplicationOperation,
  buildClaimOperation,
  cardRequestKey,
  EVIDENCE_LINK_MARGIN_S,
  lapsedEvidence,
  MAX_CARD_ROWS,
  MAX_CARD_VALUE,
  pendingFileValue,
  REVIEW_PAGE_CHARS,
  reviewPages,
} from './submission';

beforeAll(loadSurveyCore);

const FIXTURES = join(__dirname, 'fixtures');
const draft = { collectionId: '9787', title: 'Job' };

/** A value each kind of question takes, as chat would store it. */
function sample(
  model: ReturnType<typeof openModel>,
  view: FormQuestion,
  evidence: Evidence[],
): unknown {
  switch (view.input) {
    case 'number':
      return 3;
    case 'rating':
      return view.rateValues?.[0];
    case 'date':
      return '2026-10-30';
    case 'datetime':
      return '2026-10-30T10:00';
    case 'email':
      return 'lebo@example.org';
    case 'phone':
      return '+27711234567';
    case 'url':
      return 'https://example.org';
    case 'pick-one':
    case 'yes-no':
      return view.options?.[0]?.value;
    case 'pick-many':
      return [view.options?.[0]?.value];
    case 'location':
      return gridCell(model, view.path, {
        latitude: -26.2,
        longitude: 28.04,
        placeName: 'Soweto',
      });
    case 'file': {
      const sha256 = String(evidence.length).padStart(64, 'a');
      const file: Evidence = {
        path: view.path,
        url: `https://channels.test/media/b/${sha256}?exp=9999999999&sig=x`,
        filename: 'photo.jpg',
        mimetype: 'image/jpeg',
        size: 10,
        sha256,
        kind: 'image',
        receivedAt: '2026-10-30T00:00:00.000Z',
      };
      evidence.push(file);
      return [pendingFileValue(file)];
    }
    default:
      return 'An answer';
  }
}

/** Every visible question chat can answer, answered (a few passes, as answers reveal more). */
function fill(template: unknown) {
  const model = openModel(template);
  const evidence: Evidence[] = [];
  for (let pass = 0; pass < 3; pass++)
    for (const view of visibleQuestions(model)) {
      if (view.input === 'web-only') continue;
      if (!questionAt(model, view.path)?.isEmpty()) continue;
      setAnswer(model, view.path, sample(model, view, evidence));
    }
  return { model, evidence };
}

describe('the card shows exactly the answers it sends', () => {
  const forms = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

  it.each(forms)('%s: one row per answer, as Auth Hub checks it', (name) => {
    const template: unknown = JSON.parse(
      readFileSync(join(FIXTURES, name), 'utf8'),
    );
    const claim = fill(template);
    const built = buildClaimOperation({
      network: 'ixo mainnet',
      model: claim.model,
      draft: { ...draft, evidence: claim.evidence },
    });
    if (!built.ok) throw new Error(built.why);
    expect(submissionSummaryIssue(built.operation)).toBeNull();
    expect(() => parseOperation(built.operation)).not.toThrow();
    expect(built.operation.summary.length).toBeGreaterThan(0);
    for (const row of built.operation.summary)
      expect(row.label.length).toBeGreaterThan(0);
    const application = buildApplicationOperation({
      network: 'ixo mainnet',
      model: fill(template).model,
      draft,
    });
    if (!application.ok) throw new Error(application.why);
    expect(submissionSummaryIssue(application.operation)).toBeNull();
  });

  it('names an answer inside a repeating section by its path, labelled with the item number', () => {
    const model = openModel({
      question: {
        pages: [
          {
            elements: [
              {
                type: 'paneldynamic',
                name: 'shops',
                title: 'Shops',
                panelCount: 2,
                templateElements: [
                  { type: 'text', name: 'name', title: 'Name' },
                  { type: 'file', name: 'photo', title: 'Photo' },
                ],
              },
            ],
          },
        ],
      },
    });
    setAnswer(model, 'shops[0].name', 'Spaza');
    setAnswer(model, 'shops[1].name', 'Tuck shop');
    const file: Evidence = {
      path: 'shops[1].photo',
      url: 'https://channels.test/media/b/x?exp=9999999999&sig=x',
      filename: 'shop.jpg',
      mimetype: 'image/jpeg',
      size: 10,
      sha256: 'f'.repeat(64),
      kind: 'image',
      receivedAt: '2026-10-30T00:00:00.000Z',
    };
    setAnswer(model, 'shops[1].photo', [pendingFileValue(file)]);
    const built = buildClaimOperation({
      network: 'ixo mainnet',
      model,
      draft: { ...draft, evidence: [file] },
    });
    if (!built.ok) throw new Error(built.why);
    expect(built.operation.summary).toEqual([
      { field: 'shops.0.name', label: 'Shops 1 · Name', value: 'Spaza' },
      { field: 'shops.1.name', label: 'Shops 2 · Name', value: 'Tuck shop' },
    ]);
    expect(built.operation.evidence.map((e) => e.field)).toEqual([
      'shops.1.photo',
    ]);
    expect(submissionSummaryIssue(built.operation)).toBeNull();
  });

  it('shows a map pin as its parts, readably labelled, one row each', () => {
    const pins = (allowMultiple: boolean) =>
      openModel({
        question: {
          pages: [
            {
              elements: [
                {
                  type: 'map-grid-selector',
                  name: 'where',
                  title: 'Where',
                  gridPrecision: 7,
                  allowMultiple,
                },
              ],
            },
          ],
        },
      });
    const at = { latitude: -26.2, longitude: 28.04, placeName: 'Soweto' };
    const one = pins(false);
    setAnswer(one, 'where', gridCell(one, 'where', at));
    const built = buildApplicationOperation({
      network: 'ixo mainnet',
      model: one,
      draft,
    });
    if (!built.ok) throw new Error(built.why);
    expect(built.operation.summary.map((r) => [r.field, r.label])).toEqual([
      ['where.geoId', 'Where · grid cell'],
      ['where.latitude', 'Where · latitude'],
      ['where.longitude', 'Where · longitude'],
      ['where.gridPrecision', 'Where · grid size'],
      ['where.placeName', 'Where · place'],
    ]);
    expect(built.operation.summary[1]!.value).toBe('-26.2');
    expect(submissionSummaryIssue(built.operation)).toBeNull();
    const two = pins(true);
    setAnswer(two, 'where', [
      gridCell(two, 'where', at),
      gridCell(two, 'where', at),
    ]);
    const many = buildApplicationOperation({
      network: 'ixo mainnet',
      model: two,
      draft,
    });
    if (!many.ok) throw new Error(many.why);
    expect(many.operation.summary.map((r) => r.label)).toContain(
      'Where 2 · place',
    );
    expect(submissionSummaryIssue(many.operation)).toBeNull();
  });

  it('sends a claim of files only as no rows and empty data', () => {
    const model = openModel({
      question: {
        pages: [
          { elements: [{ type: 'file', name: 'photo', title: 'Photo' }] },
        ],
      },
    });
    const file: Evidence = {
      path: 'photo',
      url: 'https://channels.test/media/b/x?exp=9999999999&sig=x',
      filename: 'a.jpg',
      mimetype: 'image/jpeg',
      size: 10,
      sha256: 'e'.repeat(64),
      kind: 'image',
      receivedAt: '2026-10-30T00:00:00.000Z',
    };
    setAnswer(model, 'photo', [pendingFileValue(file)]);
    const built = buildClaimOperation({
      network: 'ixo mainnet',
      model,
      draft: { ...draft, evidence: [file] },
    });
    if (!built.ok) throw new Error(built.why);
    expect(built.operation).toMatchObject({ data: '{}', summary: [] });
    expect(submissionSummaryIssue(built.operation)).toBeNull();
    expect(() => parseOperation(built.operation)).not.toThrow();
  });

  it('refuses rather than cut: an answer past 2,000 characters, or more than 100 answers', () => {
    const long = openModel({
      question: {
        pages: [{ elements: [{ type: 'comment', name: 'story' }] }],
      },
    });
    setAnswer(long, 'story', 'a'.repeat(MAX_CARD_VALUE + 1));
    expect(
      buildApplicationOperation({ network: 'ixo mainnet', model: long, draft }),
    ).toEqual({ ok: false, why: 'value' });
    const many = openModel({
      question: {
        pages: [
          {
            elements: Array.from({ length: MAX_CARD_ROWS + 1 }, (_, i) => ({
              type: 'text',
              name: `q${i}`,
            })),
          },
        ],
      },
    });
    for (let i = 0; i <= MAX_CARD_ROWS; i++) setAnswer(many, `q${i}`, 'yes');
    expect(
      buildApplicationOperation({ network: 'ixo mainnet', model: many, draft }),
    ).toEqual({ ok: false, why: 'rows' });
  });

  it('pages a long read-back without leaving anything out', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      field: `q${i}`,
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
