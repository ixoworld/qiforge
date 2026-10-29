/**
 * `extractPdfText` — runs in both vitest pools, so it proves the unpdf
 * serverless build works on workerd as well as on Node.
 */
import type * as Unpdf from 'unpdf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePdf } from './fixtures/make-pdf';

// Wrap the real pdf.js loader to observe page reads and teardown.
const observed = vi.hoisted(() => ({
  pagesRequested: [] as number[],
  destroyed: 0,
  pagesCleaned: 0,
  onPage: undefined as undefined | ((n: number) => void),
}));
vi.mock('unpdf', async (importActual) => {
  const actual = await importActual<typeof Unpdf>();
  return {
    ...actual,
    getDocumentProxy: async (
      ...args: Parameters<typeof actual.getDocumentProxy>
    ) => {
      const pdf = await actual.getDocumentProxy(...args);
      const getPage = pdf.getPage.bind(pdf);
      pdf.getPage = async (n: number) => {
        observed.pagesRequested.push(n);
        observed.onPage?.(n);
        const page = await getPage(n);
        const cleanup = page.cleanup.bind(page);
        page.cleanup = (...a: Parameters<typeof cleanup>) => {
          observed.pagesCleaned += 1;
          return cleanup(...a);
        };
        return page;
      };
      const destroy = pdf.loadingTask.destroy.bind(pdf.loadingTask);
      pdf.loadingTask.destroy = () => {
        observed.destroyed += 1;
        return destroy();
      };
      return pdf;
    },
  };
});

import { extractPdfText } from './pdf-text';

const LONG_A =
  'The board resolved on the first of October to approve the annual budget for the programme.';
const LONG_B =
  'Treasury will release the first tranche once the audit committee confirms the milestones.';
const BIG = { maxChars: 1_000_000 };

/** A page with enough text per line to count as a text layer. */
const densePage = (n: number): string[] =>
  Array.from({ length: 5 }, (_, l) => `${LONG_A} (page ${n}, line ${l})`);

afterEach(() => {
  observed.pagesRequested.length = 0;
  observed.destroyed = 0;
  observed.pagesCleaned = 0;
  observed.onPage = undefined;
});

describe('extractPdfText', () => {
  it('returns one --- page N --- block per page for a PDF with a text layer', async () => {
    const result = await extractPdfText(
      makePdf([[LONG_A, 'Second line (with) parens'], [LONG_B]]),
      BIG,
    );
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.pages).toBe(2);
    expect(result.pagesRead).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.text).toMatch(/^--- page 1 ---\n/);
    expect(result.text).toContain('--- page 2 ---');
    expect(result.text).toContain('annual budget');
    expect(result.text).toContain('(with) parens');
    expect(result.text.indexOf('annual budget')).toBeLessThan(
      result.text.indexOf('--- page 2 ---'),
    );
    expect(result.text.indexOf('first tranche')).toBeGreaterThan(
      result.text.indexOf('--- page 2 ---'),
    );
  });

  it('does not consume the caller buffer', async () => {
    const bytes = makePdf([[LONG_A]]);
    await extractPdfText(bytes, BIG);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('reports a PDF without a text layer as scanned', async () => {
    expect(await extractPdfText(makePdf([[], []]), BIG)).toEqual({
      kind: 'scanned',
      pages: 2,
    });
  });

  it('reports a PDF with only a little text per page as scanned', async () => {
    expect(
      await extractPdfText(makePdf([['Page 1'], ['Page 2']]), BIG),
    ).toEqual({ kind: 'scanned', pages: 2 });
  });

  it('rejects bytes that are not a PDF', async () => {
    await expect(
      extractPdfText(new TextEncoder().encode('not a pdf'), BIG),
    ).rejects.toThrow();
  });

  it('stops reading pages once past maxChars and reports truncation', async () => {
    const pdf = makePdf(Array.from({ length: 40 }, (_, i) => densePage(i + 1)));
    const result = await extractPdfText(pdf, { maxChars: 1500 });
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.pages).toBe(40);
    expect(result.truncated).toBe(true);
    // ~500 chars per page: a handful of pages reach 1500, never all 40.
    expect(result.pagesRead).toBeLessThan(10);
    expect(observed.pagesRequested).toEqual(
      Array.from({ length: result.pagesRead }, (_, i) => i + 1),
    );
    expect(result.text.length).toBeLessThanOrEqual(1500);
    expect(result.text).toMatch(/^--- page 1 ---\n/);
  });

  it('stops at maxPages', async () => {
    const pdf = makePdf(Array.from({ length: 6 }, (_, i) => densePage(i + 1)));
    const result = await extractPdfText(pdf, { ...BIG, maxPages: 2 });
    if (result.kind !== 'text') throw new Error('expected text');
    expect(result.pagesRead).toBe(2);
    expect(result.pages).toBe(6);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('--- page 3 ---');
  });

  it('destroys the document and cleans every page it read', async () => {
    const pdf = makePdf([densePage(1), densePage(2), densePage(3)]);
    await extractPdfText(pdf, BIG);
    expect(observed.destroyed).toBe(1);
    expect(observed.pagesCleaned).toBe(3);
  });

  it('destroys the document when it stops early too', async () => {
    const pdf = makePdf(Array.from({ length: 20 }, (_, i) => densePage(i + 1)));
    await extractPdfText(pdf, { maxChars: 800 });
    expect(observed.destroyed).toBe(1);
  });

  it('destroys the document when the signal aborts between pages', async () => {
    const controller = new AbortController();
    const pdf = makePdf(Array.from({ length: 10 }, (_, i) => densePage(i + 1)));
    // Abort while page 2 is being read: page 3 is never requested.
    observed.onPage = (n) => {
      if (n === 2) controller.abort();
    };
    await expect(
      extractPdfText(pdf, { ...BIG, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed.destroyed).toBe(1);
    expect(observed.pagesRequested).toEqual([1, 2]);
  });

  it('does not touch the document when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractPdfText(makePdf([densePage(1)]), {
        ...BIG,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed.pagesRequested).toEqual([]);
  });
});
