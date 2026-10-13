/**
 * `viewAttachment` — the on-demand re-fetch behind `view_attachment`: native
 * block when the model reads the modality, helper-model text otherwise,
 * local decode for plain text. Fakes only (no network).
 */
import { describe, expect, it } from 'vitest';
import type { MatrixMediaSource } from './download';
import type { AttachmentTextCache } from './view-cache';
import { viewAttachment } from './view';

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
