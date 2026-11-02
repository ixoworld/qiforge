/**
 * `viewAttachment` — the on-demand re-fetch behind `view_attachment`: native
 * block when the model reads the modality, helper-model text otherwise,
 * local decode for plain text. Fakes only (no network).
 */
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { MatrixMediaSource } from './download';
import { IngestTextLru, type AttachmentTextCache } from './view-cache';
import { makePdf } from './fixtures/make-pdf';
import {
  createAttachmentViewSurface,
  extractAttachmentText,
  findPersistedAttachmentMeta,
  viewAttachment,
} from './view';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const LOGGER = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const ALL_CAPS = { image: true, file: true, audio: false, video: false };
const NO_CAPS = { image: false, file: false, audio: false, video: false };
const PROVIDER = {
  baseURL: 'https://llm.example/v1',
  apiKey: 'k',
  headers: {},
  model: 'vision/model',
};

function source(files: Record<string, Uint8Array>): MatrixMediaSource {
  return {
    async downloadMxc(mxc) {
      const bytes = files[mxc];
      if (!bytes) throw new Error(`no media at ${mxc}`);
      return bytes;
    },
    async downloadEvent(_roomId, eventId) {
      const bytes = files[eventId];
      return bytes ? { bytes } : null;
    },
  };
}

describe('viewAttachment', () => {
  it('re-attaches an image natively when the model reads images', async () => {
    const view = await viewAttachment(
      {
        filename: 'red.png',
        mimetype: 'image/png',
        mxcUri: 'mxc://hs/red',
        category: 'image',
      },
      {
        source: source({ 'mxc://hs/red': PNG }),
        extraction: PROVIDER,
        caps: ALL_CAPS,
        logger: LOGGER,
      },
    );
    expect(view.kind).toBe('native');
    if (view.kind !== 'native') throw new Error('unreachable');
    expect(view.native).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'red.png',
    });
    expect(atob(view.native.base64)).toHaveLength(PNG.length);
  });

  it('falls back to the helper model when the model cannot read images', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(String(input));
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe('vision/model');
      return Response.json({
        choices: [{ message: { content: 'a red square' } }],
      });
    };
    const view = await viewAttachment(
      {
        filename: 'red.png',
        mimetype: 'image/png',
        eventId: '$ev',
        category: 'image',
      },
      {
        source: source({ $ev: PNG }),
        extraction: PROVIDER,
        caps: NO_CAPS,
        roomId: '!room',
        fetchImpl,
        logger: LOGGER,
      },
    );
    expect(view.kind).toBe('text');
    if (view.kind !== 'text') throw new Error('unreachable');
    expect(view.text).toContain('a red square');
    expect(seen).toHaveLength(1);
  });

  it('decodes plain text locally without a helper model', async () => {
    const view = await viewAttachment(
      {
        filename: 'notes.txt',
        mimetype: 'text/plain',
        mxcUri: 'mxc://hs/txt',
        category: 'text',
      },
      {
        source: source({
          'mxc://hs/txt': new TextEncoder().encode(
            'the secret word is pineapple',
          ),
        }),
        extraction: null,
        caps: ALL_CAPS,
        logger: LOGGER,
      },
    );
    expect(view.kind).toBe('text');
    if (view.kind !== 'text') throw new Error('unreachable');
    expect(view.text).toContain('pineapple');
  });

  it('propagates a failed download', async () => {
    await expect(
      viewAttachment(
        {
          filename: 'gone.png',
          mimetype: 'image/png',
          mxcUri: 'mxc://hs/gone',
          category: 'image',
        },
        {
          source: source({}),
          extraction: null,
          caps: ALL_CAPS,
          logger: LOGGER,
        },
      ),
    ).rejects.toThrow(/no media at mxc:\/\/hs\/gone/);
  });
});

describe('viewAttachment: extracted text is reused', () => {
  function memoryCache(): AttachmentTextCache & {
    entries: Map<string, string>;
  } {
    const entries = new Map<string, string>();
    return {
      entries,
      async get(ref, model) {
        return entries.get(`${ref}|${model}`);
      },
      async put(ref, model, text) {
        entries.set(`${ref}|${model}`, text);
      },
    };
  }

  function countingSource(files: Record<string, Uint8Array>) {
    const calls: string[] = [];
    const inner = source(files);
    const counted: MatrixMediaSource = {
      downloadMxc: (mxc, maxBytes, signal) => {
        calls.push(mxc);
        return inner.downloadMxc(mxc, maxBytes, signal);
      },
      downloadEvent: (roomId, eventId, maxBytes, signal) => {
        calls.push(eventId);
        return inner.downloadEvent(roomId, eventId, maxBytes, signal);
      },
    };
    return { calls, source: counted };
  }

  const image = {
    filename: 'red.png',
    mimetype: 'image/png',
    eventId: '$ev',
    category: 'image' as const,
  };

  it('a second view of the same file makes no download and no extraction call', async () => {
    const cache = memoryCache();
    const media = countingSource({ $ev: PNG });
    let completions = 0;
    const fetchImpl: typeof fetch = async () => {
      completions += 1;
      return Response.json({
        choices: [{ message: { content: 'a red square' } }],
      });
    };
    const deps = {
      source: media.source,
      extraction: PROVIDER,
      caps: NO_CAPS,
      roomId: '!room',
      fetchImpl,
      logger: LOGGER,
      cache,
    };
    const first = await viewAttachment(image, deps);
    const second = await viewAttachment(image, deps);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ kind: 'text' });
    expect(media.calls).toEqual(['$ev']);
    expect(completions).toBe(1);
    expect([...cache.entries.keys()]).toEqual(['$ev|vision/model']);

    // Another extraction model is another entry.
    await viewAttachment(image, {
      ...deps,
      extraction: { ...PROVIDER, model: 'other/vision' },
    });
    expect(completions).toBe(2);
  });

  it('caches locally decoded text too, and never caches a native view', async () => {
    const cache = memoryCache();
    const media = countingSource({
      'mxc://hs/txt': new TextEncoder().encode('pineapple'),
      'mxc://hs/red': PNG,
    });
    const text = {
      filename: 'notes.txt',
      mimetype: 'text/plain',
      mxcUri: 'mxc://hs/txt',
      category: 'text' as const,
    };
    const deps = {
      source: media.source,
      extraction: null,
      caps: ALL_CAPS,
      logger: LOGGER,
      cache,
    };
    await viewAttachment(text, deps);
    await viewAttachment(text, deps);
    const native = {
      filename: 'red.png',
      mimetype: 'image/png',
      mxcUri: 'mxc://hs/red',
      category: 'image' as const,
    };
    await viewAttachment(native, deps);
    await viewAttachment(native, deps);
    expect(media.calls).toEqual([
      'mxc://hs/txt',
      'mxc://hs/red',
      'mxc://hs/red',
    ]);
    expect(cache.entries.size).toBe(1);
  });

  it('does not download a file of an unsupported type', async () => {
    const media = countingSource({ 'mxc://hs/bin': PNG });
    const view = await viewAttachment(
      {
        filename: 'tool.exe',
        mimetype: 'application/x-msdownload',
        mxcUri: 'mxc://hs/bin',
        category: 'unknown',
      },
      {
        source: media.source,
        extraction: PROVIDER,
        caps: NO_CAPS,
        logger: LOGGER,
      },
    );
    expect(view).toMatchObject({ kind: 'text' });
    expect(media.calls).toEqual([]);
  });
});

describe('viewAttachment: content check', () => {
  const PDF = new TextEncoder().encode('%PDF-1.4 fake');

  it('re-attaches an Office document natively under its claimed type', async () => {
    const DOCX =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const view = await viewAttachment(
      {
        filename: 'report.docx',
        mimetype: DOCX,
        mxcUri: 'mxc://hs/docx',
        category: 'document',
      },
      {
        source: source({
          'mxc://hs/docx': new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0]),
        }),
        extraction: null,
        caps: ALL_CAPS,
        logger: LOGGER,
      },
    );
    expect(view).toMatchObject({
      kind: 'native',
      native: { kind: 'file', mimeType: DOCX },
    });
  });

  it('never re-attaches a file whose bytes contradict its claim', async () => {
    await expect(
      viewAttachment(
        {
          filename: 'x.png',
          mimetype: 'image/png',
          mxcUri: 'mxc://hs/x',
          category: 'image',
        },
        {
          source: source({ 'mxc://hs/x': PDF }),
          extraction: PROVIDER,
          caps: ALL_CAPS,
          logger: LOGGER,
        },
      ),
    ).rejects.toThrow(
      /content mismatch: claimed image\/png but detected application\/pdf/,
    );
  });
});

describe('extractAttachmentText', () => {
  function memoryCache(): AttachmentTextCache & {
    entries: Map<string, string>;
  } {
    const entries = new Map<string, string>();
    return {
      entries,
      async get(ref, model) {
        return entries.get(`${ref}|${model}`);
      },
      async put(ref, model, text) {
        entries.set(`${ref}|${model}`, text);
      },
    };
  }

  function recordingFetch(content: string) {
    const bodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content } }] });
    };
    return { bodies, fetchImpl };
  }

  const LONG =
    'The board resolved on the first of October to approve the annual budget for the programme.';
  const txt = {
    filename: 'notes.txt',
    mimetype: 'text/plain',
    mxcUri: 'mxc://hs/txt',
    size: 28,
    category: 'text' as const,
  };
  const pdf = {
    filename: 'resolution.pdf',
    mimetype: 'application/pdf',
    eventId: '$pdf',
    category: 'document' as const,
  };

  it('decodes plain text locally, unwrapped, with no helper model', async () => {
    const result = await extractAttachmentText(
      txt,
      {
        source: source({
          'mxc://hs/txt': new TextEncoder().encode(
            'the secret word is pineapple',
          ),
        }),
        extraction: null,
        caps: NO_CAPS,
        logger: LOGGER,
      },
      { maxChars: 1000 },
    );
    expect(result).toEqual({
      text: 'the secret word is pineapple',
      filename: 'notes.txt',
      mimetype: 'text/plain',
      bytes: 28,
      truncated: false,
      method: 'text',
    });
  });

  it('caps text at maxChars and reports it', async () => {
    const result = await extractAttachmentText(
      txt,
      {
        source: source({
          'mxc://hs/txt': new TextEncoder().encode('0123456789'),
        }),
        extraction: null,
        caps: NO_CAPS,
        logger: LOGGER,
      },
      { maxChars: 4 },
    );
    expect(result).toMatchObject({ text: '0123', truncated: true });
  });

  it('parses a PDF with a text layer into page blocks without a model call', async () => {
    const { bodies, fetchImpl } = recordingFetch('unused');
    const result = await extractAttachmentText(
      pdf,
      {
        source: source({ $pdf: makePdf([[LONG], [LONG]]) }),
        extraction: PROVIDER,
        caps: NO_CAPS,
        roomId: '!room',
        fetchImpl,
        logger: LOGGER,
      },
      { maxChars: 10_000 },
    );
    expect(result).toMatchObject({
      method: 'pdf',
      pages: 2,
      truncated: false,
      mimetype: 'application/pdf',
    });
    expect(result.text).toContain('--- page 1 ---');
    expect(result.text).toContain('--- page 2 ---');
    expect(result.text).toContain('annual budget');
    expect(bodies).toEqual([]);
  });

  it('sends a scanned PDF to the helper model and returns its raw text, capped', async () => {
    const { bodies, fetchImpl } = recordingFetch('x'.repeat(50));
    const result = await extractAttachmentText(
      pdf,
      {
        source: source({ $pdf: makePdf([[], []]) }),
        extraction: PROVIDER,
        caps: NO_CAPS,
        roomId: '!room',
        fetchImpl,
        logger: LOGGER,
      },
      { maxChars: 20 },
    );
    expect(result).toMatchObject({
      method: 'model',
      text: 'x'.repeat(20),
      truncated: true,
    });
    expect(result.text).not.toContain('[Content of');
    expect(result.text).not.toContain('[...truncated]');
    expect(bodies).toHaveLength(1);
  });

  it('falls back to the helper model when the PDF cannot be parsed locally', async () => {
    const { fetchImpl } = recordingFetch('model text');
    const result = await extractAttachmentText(
      pdf,
      {
        source: source({
          $pdf: new TextEncoder().encode('%PDF-1.4 truncated garbage'),
        }),
        extraction: PROVIDER,
        caps: NO_CAPS,
        roomId: '!room',
        fetchImpl,
        logger: LOGGER,
      },
      { maxChars: 1000 },
    );
    expect(result).toMatchObject({ method: 'model', text: 'model text' });
  });

  it('refuses a model-lane file when no helper model is configured', async () => {
    await expect(
      extractAttachmentText(
        pdf,
        {
          source: source({ $pdf: makePdf([[]]) }),
          extraction: null,
          caps: NO_CAPS,
          roomId: '!room',
          logger: LOGGER,
        },
        { maxChars: 1000 },
      ),
    ).rejects.toThrow(/no helper model configured/);
  });

  it('refuses an unsupported file type without downloading it', async () => {
    await expect(
      extractAttachmentText(
        {
          filename: 'tool.exe',
          mimetype: 'application/x-msdownload',
          mxcUri: 'mxc://hs/bin',
          category: 'unknown',
        },
        {
          source: source({}),
          extraction: PROVIDER,
          caps: NO_CAPS,
          logger: LOGGER,
        },
        { maxChars: 1000 },
      ),
    ).rejects.toThrow(/not a supported file type/);
  });

  it('caches uncut text under ingest keys and serves it re-capped', async () => {
    const cache = memoryCache();
    let downloads = 0;
    const inner = source({ $pdf: makePdf([[LONG]]) });
    const deps = {
      source: {
        ...inner,
        downloadEvent: (
          ...args: Parameters<MatrixMediaSource['downloadEvent']>
        ) => {
          downloads += 1;
          return inner.downloadEvent(...args);
        },
      },
      extraction: PROVIDER,
      caps: NO_CAPS,
      roomId: '!room',
      logger: LOGGER,
      cache,
    };
    const first = await extractAttachmentText(pdf, deps, { maxChars: 10_000 });
    expect([...cache.entries.keys()]).toEqual(['$pdf|ingest:local-pdf']);
    const second = await extractAttachmentText(pdf, deps, { maxChars: 10_000 });
    expect(second).toMatchObject({ method: 'pdf', text: first.text });
    expect(downloads).toBe(1);
    const capped = await extractAttachmentText(pdf, deps, { maxChars: 10 });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.text).toHaveLength(10);
  });

  it('does not cache a cut text', async () => {
    const cache = memoryCache();
    await extractAttachmentText(
      txt,
      {
        source: source({
          'mxc://hs/txt': new TextEncoder().encode('0123456789'),
        }),
        extraction: null,
        caps: NO_CAPS,
        logger: LOGGER,
        cache,
      },
      { maxChars: 4 },
    );
    expect(cache.entries.size).toBe(0);
  });
});

describe('createAttachmentViewSurface', () => {
  const sameTurn = {
    filename: 'notes.txt',
    mimetype: 'text/plain',
    eventId: '$now',
    category: 'text' as const,
  };
  const older = { ...sameTurn, eventId: '$old', filename: 'old.txt' };

  function surfaceFor(persisted: Record<string, typeof older>) {
    const lookups: string[] = [];
    const surface = createAttachmentViewSurface({
      offloaded: false,
      turnMetas: [sameTurn],
      findPersisted: async (ref) => {
        lookups.push(ref);
        return persisted[ref];
      },
      deps: () => ({
        source: source({
          $now: new TextEncoder().encode('this turn'),
          $old: new TextEncoder().encode('earlier'),
        }),
        extraction: null,
        caps: NO_CAPS,
        roomId: '!room',
        logger: LOGGER,
      }),
    });
    return { surface, lookups };
  }

  it('resolves a ref from the running turn before anything is persisted', async () => {
    const { surface, lookups } = surfaceFor({});
    expect(await surface.extractText('$now', { maxChars: 100 })).toMatchObject({
      text: 'this turn',
      filename: 'notes.txt',
      method: 'text',
    });
    const viewed = await surface.view('$now');
    expect(viewed.meta).toEqual(sameTurn);
    expect(viewed.view).toMatchObject({ kind: 'text' });
    expect(lookups).toEqual([]);
  });

  it('falls back to the persisted session for any other ref', async () => {
    const { surface, lookups } = surfaceFor({ $old: older });
    expect(await surface.extractText('$old', { maxChars: 100 })).toMatchObject({
      text: 'earlier',
    });
    expect(lookups).toEqual(['$old']);
  });

  it('answers null (extract) or rejects (view) for an unknown ref', async () => {
    const { surface } = surfaceFor({});
    expect(await surface.extractText('$nope', { maxChars: 100 })).toBeNull();
    await expect(surface.view('$nope')).rejects.toThrow(/no attachment/);
  });
});

describe('extractAttachmentText: helper-model size limit', () => {
  const MB = 1024 * 1024;
  const pdf = {
    filename: 'file.pdf',
    mimetype: 'application/pdf',
    eventId: '$pdf',
    category: 'document' as const,
  };
  const LONG =
    'The board resolved on the first of October to approve the annual budget for the programme.';

  function deps(files: Record<string, Uint8Array>) {
    const downloads: string[] = [];
    const inner = source(files);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return Response.json({ choices: [{ message: { content: 'model' } }] });
    };
    return {
      downloads,
      calls,
      deps: {
        source: {
          ...inner,
          downloadEvent: (
            ...args: Parameters<MatrixMediaSource['downloadEvent']>
          ) => {
            downloads.push(args[1]);
            return inner.downloadEvent(...args);
          },
          downloadMxc: (
            ...args: Parameters<MatrixMediaSource['downloadMxc']>
          ) => {
            downloads.push(args[0]);
            return inner.downloadMxc(...args);
          },
        },
        extraction: PROVIDER,
        caps: NO_CAPS,
        roomId: '!room',
        fetchImpl,
        logger: LOGGER,
      },
    };
  }

  it('refuses a scanned PDF over 10 MB with a readable message and no model call', async () => {
    const big = makePdf([[], []], { padBytes: 11 * MB });
    const { deps: d, calls } = deps({ $pdf: big });
    await expect(
      extractAttachmentText(pdf, d, { maxChars: 1000 }),
    ).rejects.toThrow(
      /scanned or binary files up to 10\.0 MB can be processed; this one is 11\.\d MB/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses an image over 10 MB by its stated size, before downloading it', async () => {
    const { deps: d, downloads, calls } = deps({});
    await expect(
      extractAttachmentText(
        {
          filename: 'photo.png',
          mimetype: 'image/png',
          mxcUri: 'mxc://hs/photo',
          size: 12 * MB,
          category: 'image',
        },
        d,
        { maxChars: 1000 },
      ),
    ).rejects.toThrow(/this one is 12\.0 MB/);
    expect(downloads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('still parses a text-layer PDF over 10 MB locally', async () => {
    const big = makePdf([[LONG, LONG]], { padBytes: 11 * MB });
    const { deps: d, calls } = deps({ $pdf: big });
    const result = await extractAttachmentText(pdf, d, { maxChars: 10_000 });
    expect(result).toMatchObject({ method: 'pdf', pages: 1 });
    expect(result.text).toContain('annual budget');
    expect(calls).toEqual([]);
  });

  it('keeps accepting a scanned PDF up to the limit', async () => {
    const small = makePdf([[]]);
    const { deps: d, calls } = deps({ $pdf: small });
    const result = await extractAttachmentText(pdf, d, { maxChars: 1000 });
    expect(result).toMatchObject({ method: 'model', text: 'model' });
    expect(calls).toHaveLength(1);
  });
});

describe('extractAttachmentText: in-memory ingestion cache', () => {
  const LONG =
    'The board resolved on the first of October to approve the annual budget for the programme.';
  const pdf = {
    filename: 'resolution.pdf',
    mimetype: 'application/pdf',
    eventId: '$pdf',
    category: 'document' as const,
  };

  function countingDeps(files: Record<string, Uint8Array>) {
    let downloads = 0;
    const inner = source(files);
    const lru = new IngestTextLru();
    return {
      downloads: () => downloads,
      lru,
      deps: {
        source: {
          ...inner,
          downloadEvent: (
            ...args: Parameters<MatrixMediaSource['downloadEvent']>
          ) => {
            downloads += 1;
            return inner.downloadEvent(...args);
          },
        },
        extraction: PROVIDER,
        caps: NO_CAPS,
        roomId: '!room',
        logger: LOGGER,
        ingestCache: lru.forSession('s1'),
      },
    };
  }

  it('serves a repeat call for the same file without downloading or parsing again', async () => {
    const { deps, downloads } = countingDeps({ $pdf: makePdf([[LONG]]) });
    const first = await extractAttachmentText(pdf, deps, { maxChars: 10_000 });
    const second = await extractAttachmentText(pdf, deps, {
      maxChars: 10_000,
    });
    expect(downloads()).toBe(1);
    expect(second).toEqual(first);
    expect(second).toMatchObject({
      method: 'pdf',
      pages: 1,
      bytes: first.bytes,
    });
  });

  it('keeps a text far over the SQLite per-entry limit, and a cut one with its flag', async () => {
    const big = 'x'.repeat(200_000);
    const { deps, downloads, lru } = countingDeps({
      $txt: new TextEncoder().encode(big),
    });
    const txt = {
      filename: 'big.txt',
      mimetype: 'text/plain',
      eventId: '$txt',
      category: 'text' as const,
    };
    const first = await extractAttachmentText(txt, deps, {
      maxChars: 150_000,
    });
    expect(first).toMatchObject({ truncated: true });
    expect(first.text).toHaveLength(150_000);
    const second = await extractAttachmentText(txt, deps, {
      maxChars: 150_000,
    });
    expect(second).toEqual(first);
    expect(downloads()).toBe(1);
    expect(lru.size).toBe(1);
    // A smaller cap is served from the same entry.
    expect(
      await extractAttachmentText(txt, deps, { maxChars: 10 }),
    ).toMatchObject({ truncated: true, text: 'x'.repeat(10) });
    expect(downloads()).toBe(1);
  });

  it('is scoped to the session', async () => {
    const { deps, downloads, lru } = countingDeps({ $pdf: makePdf([[LONG]]) });
    await extractAttachmentText(pdf, deps, { maxChars: 10_000 });
    await extractAttachmentText(
      pdf,
      { ...deps, ingestCache: lru.forSession('s2') },
      { maxChars: 10_000 },
    );
    expect(downloads()).toBe(2);
  });
});

describe('findPersistedAttachmentMeta', () => {
  const meta = {
    filename: 'old.pdf',
    mimetype: 'application/pdf',
    eventId: '$old',
    category: 'document',
  };

  function store(messages: BaseMessage[]) {
    const scans: string[] = [];
    return {
      scans,
      store: {
        listThreadMessagesMatching: async (
          _id: string,
          filter: { contentContains: string },
        ) => {
          scans.push(`matching:${filter.contentContains}`);
          return messages.filter((m) =>
            String(m.content).includes(filter.contentContains),
          );
        },
        listThreadMessages: async () => {
          scans.push('all');
          return messages;
        },
      },
    };
  }

  it('finds a native-lane attachment from its hidden note without loading the whole session', async () => {
    // A native file's human message holds the bytes (blocks, no quoted ref in
    // its text); the hidden AI note quotes the ref and carries the metadata.
    const human = new HumanMessage({ content: 'please store this' });
    const note = new AIMessage({
      content:
        '[source: eventId="$old"] "old.pdf" (application/pdf) is attached to this message.',
      additional_kwargs: { attachment: meta },
    });
    const other = new AIMessage({ content: 'unrelated reply' });
    const { store: s, scans } = store([human, note, other]);
    expect(await findPersistedAttachmentMeta(s, 'sess', '$old')).toEqual(meta);
    expect(scans).toEqual(['matching:$old']);
  });

  it('finds an attachment from its human message placeholder (earlier behaviour kept)', async () => {
    const human = new HumanMessage({
      content: 'Attachments of this message: ref: $old',
      additional_kwargs: { attachments: [meta] },
    });
    const { store: s, scans } = store([human]);
    expect(await findPersistedAttachmentMeta(s, 'sess', '$old')).toEqual(meta);
    expect(scans).toEqual(['matching:$old']);
  });

  it('falls back to the whole session only when no candidate holds the metadata', async () => {
    const inline = new HumanMessage({
      content: [{ type: 'text', text: 'hi' }],
      additional_kwargs: { attachments: [meta] },
    });
    const { store: s, scans } = store([inline]);
    expect(await findPersistedAttachmentMeta(s, 'sess', '$old')).toEqual(meta);
    expect(scans).toEqual(['matching:$old', 'all']);
  });

  it('ignores a reply that merely quotes the ref and resolves undefined for an unknown one', async () => {
    const echo = new AIMessage({ content: 'you sent $old earlier' });
    const { store: s } = store([echo]);
    expect(
      await findPersistedAttachmentMeta(s, 'sess', '$old'),
    ).toBeUndefined();
  });

  it('serves a ref of an earlier turn through the surface from a hidden note', async () => {
    const note = new AIMessage({
      content: '[source: eventId="$old"] note',
      additional_kwargs: { attachment: { ...meta, mimetype: 'text/plain' } },
    });
    const { store: s, scans } = store([note]);
    const surface = createAttachmentViewSurface({
      offloaded: false,
      turnMetas: [],
      findPersisted: (ref) => findPersistedAttachmentMeta(s, 'sess', ref),
      deps: () => ({
        source: source({ $old: new TextEncoder().encode('earlier') }),
        extraction: null,
        caps: NO_CAPS,
        roomId: '!room',
        logger: LOGGER,
      }),
    });
    expect(await surface.extractText('$old', { maxChars: 100 })).toMatchObject({
      text: 'earlier',
    });
    expect(scans).toEqual(['matching:$old']);
  });
});
