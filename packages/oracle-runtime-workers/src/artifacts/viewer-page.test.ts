import { env } from 'cloudflare:test';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { newShareKey, sealArtifact } from './crypto';
import { artifactPageResponse } from './routes';
import { VIEWER_SCRIPT, viewerHtml } from './viewer-page';

interface ViewerInlineToken {
  kind: 'code' | 'strong' | 'del' | 'em' | 'image' | 'link' | 'url';
  start: number;
  end: number;
  text: string;
  href: string;
}

interface ViewerParsing {
  scanInline: (value: string) => ViewerInlineToken[];
  parseHeading: (line: string) => { level: number; text: string } | null;
  DIVIDER: RegExp;
}

/**
 * The parsing part of the page script, evaluated from the script text the
 * browser receives (nothing else in scope).
 */
function pageParsing(): ViewerParsing {
  const begin = VIEWER_SCRIPT.indexOf('// ── Inline and block parsing');
  const end = VIEWER_SCRIPT.indexOf('// ── End of parsing ──');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const build = new Function(
    `'use strict';\n${VIEWER_SCRIPT.slice(begin, end)}\nreturn { scanInline: scanInline, parseHeading: parseHeading, DIVIDER: DIVIDER };`,
  );
  const parsing: ViewerParsing = build();
  return parsing;
}

const { scanInline, parseHeading, DIVIDER } = pageParsing();

const TICK = '`';

/** The page's previous inline pattern: the reference for ordinary text. */
const PREVIOUS_INLINE = new RegExp(
  '(' +
    TICK +
    '+)([\\s\\S]*?[^' +
    TICK +
    '])\\1(?!' +
    TICK +
    ')' +
    '|\\*\\*([\\s\\S]+?)\\*\\*' +
    '|__([\\s\\S]+?)__' +
    '|~~([\\s\\S]+?)~~' +
    '|\\*([^\\s*][\\s\\S]*?)\\*' +
    '|(?<![\\w])_([^\\s_][\\s\\S]*?)_(?![\\w])' +
    '|!\\[([^\\]]*)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)(?:\\s+"[^"]*")?\\)' +
    '|\\[([^\\]]+)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)(?:\\s+"[^"]*")?\\)' +
    '|<(https?:\\/\\/[^>\\s]+)>' +
    '|(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?\'"])',
  'g',
);

function previousTokens(value: string): ViewerInlineToken[] {
  const out: ViewerInlineToken[] = [];
  for (const m of value.matchAll(PREVIOUS_INLINE)) {
    const start = m.index;
    const end = start + m[0].length;
    const base = { start, end };
    if (m[1]) out.push({ ...base, kind: 'code', text: m[2]!, href: '' });
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push({ ...base, kind: 'strong', text: m[3] ?? m[4]!, href: '' });
    else if (m[5] !== undefined)
      out.push({ ...base, kind: 'del', text: m[5], href: '' });
    else if (m[6] !== undefined || m[7] !== undefined)
      out.push({ ...base, kind: 'em', text: m[6] ?? m[7]!, href: '' });
    else if (m[9] !== undefined)
      out.push({ ...base, kind: 'image', text: m[8] ?? '', href: m[9] });
    else if (m[11] !== undefined)
      out.push({ ...base, kind: 'link', text: m[10]!, href: m[11] });
    else {
      const url = m[12] ?? m[13]!;
      out.push({ ...base, kind: 'url', text: url, href: url });
    }
  }
  return out;
}

const ORDINARY = [
  'Plain text with nothing special.',
  'Run `npm test` then `pnpm build`, or ``a ` inside`` code.',
  'This is **bold**, __also bold__, ~~gone~~, *em* and _em too_.',
  'snake_case_names stay as they are, and so does a_b.',
  'Mixed **bold with *em* inside** and *em with `code`*.',
  'A [link](https://example.com/path?q=1) and [one with a title](https://x.test "Title").',
  'Wiki style [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) keeps its parens.',
  'An image ![chart](https://img.test/c.png) and an empty alt ![](https://img.test/x.png).',
  'Autolink <https://auto.test/a?b=c> and a bare https://bare.test/page, then http://plain.test.',
  'Bad link [text](javascript:alert(1)) and [no target]() and [](https://e.test).',
  'Line one\nline **two\nspans** lines.',
  'Stars * alone * and underscores _ alone _ are text.',
  'Ends with a dangling **bold and `tick and [bracket and <https://open',
];

function time(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe('scanInline', () => {
  it('finds what the previous pattern found in ordinary text', () => {
    for (const sample of ORDINARY)
      expect({ sample, tokens: scanInline(sample) }).toEqual({
        sample,
        tokens: previousTokens(sample),
      });
  });

  it('reads a link with a title and a bare URL without its trailing punctuation', () => {
    expect(
      scanInline('See [docs](https://d.test "Docs") or https://u.test/a.'),
    ).toEqual([
      {
        kind: 'link',
        start: 4,
        end: 33,
        text: 'docs',
        href: 'https://d.test',
      },
      {
        kind: 'url',
        start: 37,
        end: 53,
        text: 'https://u.test/a',
        href: 'https://u.test/a',
      },
    ]);
  });

  it('stays linear on lines built to make a backtracking parser stall', () => {
    const n = 100_000;
    const lines = [
      '_a '.repeat(n / 3),
      '[a '.repeat(n / 3),
      '![a'.repeat(n / 3),
      '[x](y'.repeat(n / 5),
      TICK.repeat(n),
      `${TICK}a ${TICK}${TICK}b `.repeat(n / 7),
      '<https://a'.repeat(n / 10),
      '**a'.repeat(n / 3) + '*'.repeat(n / 3),
      'https://' + '.'.repeat(n),
      `a${' '.repeat(n)}b`,
    ];
    for (const line of lines) {
      const elapsed = time(() => scanInline(line));
      expect({ line: line.slice(0, 12), fast: elapsed < 500 }).toEqual({
        line: line.slice(0, 12),
        fast: true,
      });
    }
  });
});

describe('parseHeading', () => {
  it('reads the level and the text, dropping a closing run of #s', () => {
    expect(parseHeading('# Title')).toEqual({ level: 1, text: 'Title' });
    expect(parseHeading('### Title ###  ')).toEqual({
      level: 3,
      text: 'Title',
    });
    expect(parseHeading('## C#')).toEqual({ level: 2, text: 'C#' });
    expect(parseHeading('# ###')).toEqual({ level: 1, text: '' });
    expect(parseHeading('#hashtag')).toBeNull();
    expect(parseHeading('####### seven')).toBeNull();
    expect(parseHeading('plain')).toBeNull();
  });

  it('returns at once on a heading padded with thousands of spaces', () => {
    const line = `# a${' '.repeat(50_000)}b`;
    let heading: ReturnType<typeof parseHeading> = null;
    expect(time(() => (heading = parseHeading(line)))).toBeLessThan(100);
    expect(heading).toEqual({
      level: 1,
      text: `a${' '.repeat(50_000)}b`,
    });
    const paragraph = `a${' '.repeat(50_000)}#x`;
    expect(time(() => parseHeading(paragraph))).toBeLessThan(100);
  });
});

describe('the table divider', () => {
  it('matches the divider rows the previous pattern matched, and nothing else', () => {
    const previous = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
    const divider = ['---|---', '|---|:---:|', ' | :--- | ---: | ', '---'];
    const other = ['--', '| a | b |', '---|--', 'text ---', '|:--:|'];
    for (const row of divider) {
      expect({ row, matches: DIVIDER.test(row) }).toEqual({
        row,
        matches: true,
      });
      expect({ row, matches: previous.test(row) }).toEqual({
        row,
        matches: true,
      });
    }
    for (const row of other) {
      expect({ row, matches: DIVIDER.test(row) }).toEqual({
        row,
        matches: false,
      });
      expect({ row, matches: previous.test(row) }).toEqual({
        row,
        matches: false,
      });
    }
  });

  it('returns at once on long lines of spaces and dashes', () => {
    for (const row of [
      `${' '.repeat(50_000)}x`,
      `---${' '.repeat(50_000)}x`,
      `|${' |'.repeat(25_000)}x`,
    ])
      expect(time(() => DIVIDER.test(row))).toBeLessThan(100);
  });
});

describe('viewer page script', () => {
  it('is one static text with no bundler helpers in it', () => {
    expect(VIEWER_SCRIPT).not.toMatch(/__\w+\(/);
    expect(VIEWER_SCRIPT).not.toContain('${');
  });

  it('renders a document end to end from its text alone, against a page without anything else in scope', async () => {
    const key = newShareKey();
    const sealed = await sealArtifact(key, {
      v: 1,
      title: 'Plan',
      mime: 'text/markdown',
      content: [
        '# Week plan #',
        '',
        'Do **this**, then `that`, see [docs](https://d.test "Docs").',
        '',
        '| Item | Due |',
        '|---|:---:|',
        '| Deck | Wed |',
        '',
        '- one',
        '- two _soon_',
      ].join('\n'),
      createdAt: '2026-10-01T09:00:00.000Z',
    });
    const { document } = parseHTML(viewerHtml('Qi'));
    const objectUrls: Blob[] = [];
    class PageUrl extends URL {
      static override createObjectURL(blob: Blob): string {
        objectUrls.push(blob);
        return 'blob:page/1';
      }
    }
    let fetched = '';
    const run = new Function(
      'document',
      'location',
      'fetch',
      'navigator',
      'URL',
      VIEWER_SCRIPT,
    );
    run(
      document,
      {
        hash: `#k=${key}`,
        pathname: `/a/${'a'.repeat(32)}`,
        href: `https://oracle.test/a/${'a'.repeat(32)}#k=${key}`,
      },
      async (url: string) => {
        fetched = url;
        return new Response(sealed);
      },
      { clipboard: { writeText: async () => undefined } },
      PageUrl,
    );
    const article = document.getElementById('doc');
    for (let i = 0; i < 50 && article?.hidden !== false; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(document.getElementById('status')?.hidden).toBe(true);
    expect(fetched).toBe(`/a/${'a'.repeat(32)}/data`);
    expect(article?.querySelector('h1')?.textContent).toBe('Week plan');
    expect(article?.querySelector('strong')?.textContent).toBe('this');
    expect(article?.querySelector('code')?.textContent).toBe('that');
    expect(article?.querySelector('a')?.getAttribute('href')).toBe(
      'https://d.test/',
    );
    expect(article?.querySelector('td')?.textContent).toBe('Deck');
    expect(article?.querySelectorAll('li')).toHaveLength(2);
    expect(article?.querySelector('li em')?.textContent).toBe('soon');
    expect(objectUrls).toHaveLength(1);
  });

  it('pins the script it serves by hash in the CSP', async () => {
    const page = await artifactPageResponse(
      { ORACLE_NAME: 'Qi', ARTIFACT_BUCKET: env.ARTIFACT_TEST },
      'a'.repeat(32),
    );
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(VIEWER_SCRIPT),
    );
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(page.headers.get('content-security-policy')).toContain(
      `script-src 'sha256-${hash}'`,
    );
    expect(await page.text()).toContain(`<script>${VIEWER_SCRIPT}</script>`);
  });
});
