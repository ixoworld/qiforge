/**
 * Local PDF text extraction (pdf.js through `unpdf`'s serverless build, which
 * runs on Workers with no DOM or canvas). Used by document ingestion, where
 * the text must be the document's own words rather than a model's rendering.
 * A PDF without a text layer (a scan) is reported as `scanned` so the caller
 * can fall back to the helper model.
 *
 * Pages are read one at a time and reading stops as soon as the caller's
 * character cap is reached, so a thousand-page file costs what the first
 * pages cost, and the document is always destroyed (pdf.js otherwise keeps
 * its worker-side state, fonts and page caches, alive).
 */
import { getDocumentProxy } from 'unpdf';

import { capText } from './extract';

/** Below this many non-whitespace characters per page on average, a PDF is treated as scanned. */
export const MIN_CHARS_PER_PAGE = 50;

/** Pages read at most, whatever the character cap. */
export const DEFAULT_MAX_PDF_PAGES = 2000;

export interface PdfTextOptions {
  /** Stop reading once the text passes this many UTF-16 units. */
  maxChars: number;
  /** Stop after this many pages (default {@link DEFAULT_MAX_PDF_PAGES}). */
  maxPages?: number;
  /** Checked between pages; an aborted signal throws its reason. */
  signal?: AbortSignal;
}

export type PdfTextResult =
  | {
      kind: 'text';
      /** At most `maxChars` units, as `--- page N ---` blocks. */
      text: string;
      /** Pages in the document. */
      pages: number;
      /** Pages actually read. */
      pagesRead: number;
      /** True when pages were left unread or the text was cut at `maxChars`. */
      truncated: boolean;
    }
  | { kind: 'scanned'; pages: number };

function pageBlock(pageNumber: number, text: string): string {
  return `--- page ${pageNumber} ---\n${text.trim()}`;
}

export async function extractPdfText(
  bytes: Uint8Array,
  opts: PdfTextOptions,
): Promise<PdfTextResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PDF_PAGES;
  opts.signal?.throwIfAborted();
  // pdf.js takes ownership of (and detaches) the buffer it is handed.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const totalPages = pdf.numPages;
    const blocks: string[] = [];
    let length = 0;
    let visible = 0;
    let pagesRead = 0;
    while (pagesRead < totalPages && pagesRead < maxPages) {
      opts.signal?.throwIfAborted();
      const page = await pdf.getPage(pagesRead + 1);
      let pageText: string;
      try {
        const content = await page.getTextContent();
        pageText = content.items
          .map((item) =>
            'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '',
          )
          .join('');
      } finally {
        page.cleanup();
      }
      pagesRead += 1;
      visible += pageText.replace(/\s/g, '').length;
      const block = pageBlock(pagesRead, pageText);
      blocks.push(block);
      length += block.length + 2;
      if (length > opts.maxChars) break;
    }
    if (totalPages === 0 || visible < pagesRead * MIN_CHARS_PER_PAGE) {
      return { kind: 'scanned', pages: totalPages };
    }
    const capped = capText(blocks.join('\n\n'), opts.maxChars);
    return {
      kind: 'text',
      text: capped.text,
      pages: totalPages,
      pagesRead,
      truncated: capped.truncated || pagesRead < totalPages,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
