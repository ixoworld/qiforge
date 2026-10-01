/**
 * `viewAttachment` — the on-demand re-fetch behind `view_attachment`: native
 * block when the model reads the modality, helper-model text otherwise,
 * local decode for plain text. Fakes only (no network).
 */
import { describe, expect, it } from 'vitest';
import type { MatrixMediaSource } from './download';
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
