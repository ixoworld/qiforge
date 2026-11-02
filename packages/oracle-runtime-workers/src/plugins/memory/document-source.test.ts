/**
 * `loadDocumentText` — attachment lane over a fake `AttachmentViewSurface`,
 * VFS lane over a fake `fetchImpl` (the way vfs-tools.test.ts does it).
 */
import { AIMessageChunk } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it } from 'vitest';
import { makePdf } from '../../attachments/fixtures/make-pdf';
import type { AttachmentViewSurface } from '../../attachments/view';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import { MAX_VISION_BYTES } from '../vfs/vfs-content';
import { loadDocumentText } from './document-source';

const LONG =
  'The board resolved on the first of October to approve the annual budget for the programme.';

type Extraction = NonNullable<
  Awaited<ReturnType<AttachmentViewSurface['extractText']>>
>;

function surface(
  extractText: AttachmentViewSurface['extractText'],
): AttachmentViewSurface {
  return {
    offloaded: false,
    view: async () => {
      throw new Error('unused');
    },
    extractText,
  };
}

function makeCtx(
  overrides: Partial<RuntimeContext> = {},
  signing = true,
): RuntimeContext {
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => signing,
    getServiceDelegation: async () => ({ token: 'car', with: 'wid:root' }),
    createInvocationFromDelegation: async () => ({ invocation: 'inv' }),
    resolveServiceDid: async () => 'did:web:vfs.example',
    mintInvocation: async () => 'token',
  };
  return makeRuntimeContext(
    { availablePlugins: new Set(['vfs']), ...overrides },
    { ambient: { ucan, config: { ORACLE_DID: 'did:ixo:oracle1' } } },
  );
}

describe('loadDocumentText: attachments', () => {
  const extraction: Extraction = {
    text: 'hello',
    filename: 'a.txt',
    mimetype: 'text/plain',
    bytes: 5,
    truncated: false,
    method: 'text',
  };

  it('returns what the host surface extracted and passes the cap on', async () => {
    const calls: Array<[string, { maxChars: number }]> = [];
    const ctx = makeCtx({
      attachments: surface(async (ref, opts) => {
        calls.push([ref, opts]);
        return extraction;
      }),
    });
    const loaded = await loadDocumentText(
      ctx,
      { attachment_ref: '$ev' },
      { maxChars: 1234 },
    );
    expect(loaded).toEqual(extraction);
    expect(calls).toEqual([['$ev', { maxChars: 1234 }]]);
  });

  it('says so when the ref is not in this conversation', async () => {
    const ctx = makeCtx({ attachments: surface(async () => null) });
    await expect(
      loadDocumentText(ctx, { attachment_ref: '$nope' }, { maxChars: 10 }),
    ).rejects.toThrow(
      'No attachment $nope in this conversation; ask the person to attach the file again.',
    );
  });

  it('wraps a host failure with the ref', async () => {
    const ctx = makeCtx({
      attachments: surface(async () => {
        throw new Error('File exceeds maximum size');
      }),
    });
    await expect(
      loadDocumentText(ctx, { attachment_ref: '$big' }, { maxChars: 10 }),
    ).rejects.toThrow(
      'Could not read attachment $big: File exceeds maximum size',
    );
  });

  it('errors when the host has no attachment surface', async () => {
    await expect(
      loadDocumentText(
        makeCtx({ attachments: undefined }),
        { attachment_ref: '$ev' },
        { maxChars: 10 },
      ),
    ).rejects.toThrow(/Chat attachments cannot be read/);
  });

  it('errors when the extracted text is blank', async () => {
    const ctx = makeCtx({
      attachments: surface(async () => ({ ...extraction, text: '  \n' })),
    });
    await expect(
      loadDocumentText(ctx, { attachment_ref: '$ev' }, { maxChars: 10 }),
    ).rejects.toThrow('No text could be extracted from "a.txt"');
  });
});

interface VfsFile {
  id: string;
  path: string;
  mimeType: string;
  size: number;
  body?: Uint8Array;
}

function makeVfs(
  files: VfsFile[],
  overrides?: (url: URL) => Response | undefined,
) {
  const paths: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const pathname = url.pathname.replace('/api/fs', '');
    paths.push(pathname);
    const custom = overrides?.(url);
    if (custom) return custom;
    if (pathname === '/glob') {
      const pattern = url.searchParams.get('pattern');
      return Response.json({
        files: files
          .filter((f) => f.path === pattern)
          .map(({ body: _body, ...f }) => ({ ...f, name: f.path.slice(1) })),
      });
    }
    const content = /^\/files\/([^/]+)\/content$/.exec(pathname);
    const file = files.find((f) => f.id === content?.[1]);
    if (file?.body) {
      return new Response(file.body, {
        headers: { 'content-type': file.mimeType },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, paths };
}

const enc = (text: string) => new TextEncoder().encode(text);

describe('loadDocumentText: VFS', () => {
  const deps = { maxChars: 100_000, retryDelayMs: 0 };

  it('decodes a text file from its content bytes', async () => {
    const body = enc('# Policy\nCafé résumé');
    const vfs = makeVfs([
      {
        id: 't',
        path: '/policy.md',
        mimeType: 'text/markdown',
        size: body.length,
        body,
      },
    ]);
    const loaded = await loadDocumentText(
      makeCtx(),
      { vfs_path: '/policy.md' },
      { ...deps, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded).toEqual({
      text: '# Policy\nCafé résumé',
      filename: 'policy.md',
      mimetype: 'text/markdown',
      bytes: body.length,
      method: 'text',
      truncated: false,
    });
    expect(vfs.paths).toEqual(['/glob', '/files/t/content']);
  });

  it('caps a long text file and reports truncation', async () => {
    const body = enc('0123456789');
    const vfs = makeVfs([
      { id: 't', path: '/n.txt', mimeType: 'text/plain', size: 10, body },
    ]);
    const loaded = await loadDocumentText(
      makeCtx(),
      { vfs_path: '/n.txt' },
      { ...deps, maxChars: 4, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded).toMatchObject({ text: '0123', truncated: true });
  });

  it('parses a PDF with a text layer locally', async () => {
    const body = makePdf([[LONG], [LONG]]);
    const vfs = makeVfs([
      {
        id: 'p',
        path: '/r.pdf',
        mimeType: 'application/pdf',
        size: body.length,
        body,
      },
    ]);
    const loaded = await loadDocumentText(
      makeCtx(),
      { vfs_path: '/r.pdf' },
      { ...deps, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded).toMatchObject({ method: 'pdf', pages: 2, truncated: false });
    expect(loaded.text).toContain('--- page 2 ---');
    expect(loaded.text).toContain('annual budget');
  });

  it('sends a scanned PDF through the vision model', async () => {
    const body = makePdf([[], []]);
    const vfs = makeVfs([
      {
        id: 'p',
        path: '/scan.pdf',
        mimeType: 'application/pdf',
        size: body.length,
        body,
      },
    ]);
    const ctx = makeCtx({
      llm: {
        get: () => new FakeListChatModel({ responses: ['transcribed scan'] }),
      },
    });
    const loaded = await loadDocumentText(
      ctx,
      { vfs_path: '/scan.pdf' },
      { ...deps, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded).toMatchObject({
      method: 'model',
      text: 'transcribed scan',
      bytes: body.length,
    });
    // The bytes read for the PDF parse go to the vision step: one download.
    expect(vfs.paths).toEqual(['/glob', '/files/p/content']);
  });

  it('reads only the head of a long text file but still reports truncation', async () => {
    // 3 UTF-8 bytes per unit: 40 000 units = 120 000 bytes, cap at 100.
    const body = enc('€'.repeat(40_000));
    const vfs = makeVfs([
      {
        id: 't',
        path: '/long.txt',
        mimeType: 'text/plain',
        size: body.length,
        body,
      },
    ]);
    const loaded = await loadDocumentText(
      makeCtx(),
      { vfs_path: '/long.txt' },
      { ...deps, maxChars: 100, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded.text).toBe('€'.repeat(100));
    expect(loaded).toMatchObject({ truncated: true, bytes: body.length });
  });

  it('marks a model reply cut at the provider limit as truncated', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const vfs = makeVfs([
      { id: 'i', path: '/c.png', mimeType: 'image/png', size: 4, body },
    ]);
    const ctx = makeCtx({
      llm: {
        get: () => {
          const model = new FakeListChatModel({ responses: ['part'] });
          const invoke = model.invoke.bind(model);
          model.invoke = async (...args: Parameters<typeof invoke>) => {
            const reply = await invoke(...args);
            reply.response_metadata = { finish_reason: 'length' };
            return reply;
          };
          return model;
        },
      },
    });
    const loaded = await loadDocumentText(
      ctx,
      { vfs_path: '/c.png' },
      { ...deps, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded).toMatchObject({ text: 'part', truncated: true });
  });

  it('takes only the text blocks of a block-array reply', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const vfs = makeVfs([
      { id: 'i', path: '/c.png', mimeType: 'image/png', size: 4, body },
    ]);
    const ctx = makeCtx({
      llm: {
        get: () => {
          const model = new FakeListChatModel({ responses: ['x'] });
          model.invoke = async () =>
            new AIMessageChunk({
              content: [
                { type: 'text', text: 'first ' },
                { type: 'image_url', image_url: { url: 'data:x' } },
                { type: 'text', text: 'second' },
              ],
            });
          return model;
        },
      },
    });
    const loaded = await loadDocumentText(
      ctx,
      { vfs_path: '/c.png' },
      { ...deps, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded.text).toBe('first second');
    expect(loaded.text).not.toContain('object');
  });

  it('transcribes an image and caps the transcription', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const vfs = makeVfs([
      { id: 'i', path: '/c.png', mimeType: 'image/png', size: 4, body },
    ]);
    const ctx = makeCtx({
      llm: {
        get: () => new FakeListChatModel({ responses: ['a long description'] }),
      },
    });
    const loaded = await loadDocumentText(
      ctx,
      { vfs_path: '/c.png' },
      { ...deps, maxChars: 6, fetchImpl: vfs.fetchImpl },
    );
    expect(loaded).toMatchObject({
      method: 'model',
      text: 'a long',
      truncated: true,
    });
  });

  it('throws, not a stub, when the vision model fails', async () => {
    const body = new Uint8Array([1, 2, 3]);
    const vfs = makeVfs([
      { id: 'i', path: '/c.png', mimeType: 'image/png', size: 3, body },
    ]);
    const ctx = makeCtx({
      llm: {
        get: () => {
          throw new Error('vision down');
        },
      },
    });
    await expect(
      loadDocumentText(
        ctx,
        { vfs_path: '/c.png' },
        { ...deps, fetchImpl: vfs.fetchImpl },
      ),
    ).rejects.toThrow(/could not be rendered/);
  });

  it('refuses a file over the size limit without downloading it', async () => {
    const vfs = makeVfs([
      {
        id: 'b',
        path: '/big.pdf',
        mimeType: 'application/pdf',
        size: MAX_VISION_BYTES + 1,
      },
    ]);
    await expect(
      loadDocumentText(
        makeCtx(),
        { vfs_path: '/big.pdf' },
        { ...deps, fetchImpl: vfs.fetchImpl },
      ),
    ).rejects.toThrow(/over the 10485760 byte limit/);
    expect(vfs.paths).toEqual(['/glob']);
  });

  it('refuses a binary type nothing can read, without downloading it', async () => {
    const vfs = makeVfs([
      { id: 'z', path: '/a.zip', mimeType: 'application/zip', size: 10 },
    ]);
    await expect(
      loadDocumentText(
        makeCtx(),
        { vfs_path: '/a.zip' },
        { ...deps, fetchImpl: vfs.fetchImpl },
      ),
    ).rejects.toThrow(/not rendered/);
    expect(vfs.paths).toEqual(['/glob']);
  });

  it('says so when the path does not exist', async () => {
    const vfs = makeVfs([]);
    await expect(
      loadDocumentText(
        makeCtx(),
        { vfs_path: '/missing.md' },
        { ...deps, fetchImpl: vfs.fetchImpl },
      ),
    ).rejects.toThrow('No file at /missing.md in your files.');
  });

  it('maps a VFS access error to its agent-facing sentence', async () => {
    const vfs = makeVfs([], () => new Response('forbidden', { status: 403 }));
    await expect(
      loadDocumentText(
        makeCtx(),
        { vfs_path: '/x.md' },
        { ...deps, fetchImpl: vfs.fetchImpl },
      ),
    ).rejects.toThrow(/outside what you shared with me/);
  });

  it('says Library files are not enabled when the Files plugin is not loaded', async () => {
    const vfs = makeVfs([]);
    await expect(
      loadDocumentText(
        makeCtx({ availablePlugins: new Set(['memory']) }),
        { vfs_path: '/x.md' },
        { ...deps, fetchImpl: vfs.fetchImpl },
      ),
    ).rejects.toThrow('Library files are not enabled on this oracle');
    expect(vfs.paths).toEqual([]);
  });

  it('errors without a signing key', async () => {
    await expect(
      loadDocumentText(makeCtx({}, false), { vfs_path: '/x.md' }, deps),
    ).rejects.toThrow(/no UCAN signing key/);
  });
});
