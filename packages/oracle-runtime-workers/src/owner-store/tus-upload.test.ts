/**
 * The tus client against an in-memory VFS-shaped server: parts land at
 * their offsets, a dropped response resumes from `HEAD`, a rejected part is
 * resent once the offset is confirmed, and fatal statuses abort the session.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { streamOfBytes } from './types';
import {
  TUS_MIN_PART_BYTES,
  TusUploadError,
  tusUpload,
  uploadMetadata,
} from './tus-upload';

const ENDPOINT = 'https://vfs.test/api/fs/upload';
const PART = TUS_MIN_PART_BYTES;

/** Deep-equal on multi-MB typed arrays blows the pool worker; compare digests. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return (
    a.byteLength === b.byteLength &&
    createHash('sha256').update(a).digest('hex') ===
      createHash('sha256').update(b).digest('hex')
  );
}

function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 97) out[i] = (i / 97) & 0xff;
  return out;
}

interface FakeTusOptions {
  /** Drop the response of the n-th PATCH (1-based) after committing it. */
  dropResponseOfPart?: number;
  /** Answer the n-th PATCH with 503 without committing. */
  failPart?: number;
  /** Answer the n-th PATCH with this fatal status. */
  fatalPart?: { part: number; status: number };
}

function fakeTus(total: number, opts: FakeTusOptions = {}) {
  const received = new Uint8Array(total);
  let offset = 0;
  let patches = 0;
  let partSize: number | null = null;
  let created = 0;
  let deleted = 0;
  const log: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    log.push(`${method} ${url.pathname}`);
    expect(headers.get('tus-resumable')).toBe('1.0.0');
    expect(headers.get('authorization')).toMatch(/^Bearer inv-\d+$/);
    if (method === 'POST' && url.pathname === '/api/fs/upload') {
      created += 1;
      expect(Number(headers.get('upload-length'))).toBe(total);
      expect(headers.get('upload-metadata')).toContain('path ');
      return new Response(null, {
        status: 201,
        headers: { location: '/api/fs/upload/sess-1' },
      });
    }
    if (url.pathname !== '/api/fs/upload/sess-1')
      return new Response('nope', { status: 404 });
    if (method === 'HEAD')
      return new Response(null, {
        status: 200,
        headers: { 'upload-offset': String(offset) },
      });
    if (method === 'DELETE') {
      deleted += 1;
      return new Response(null, { status: 204 });
    }
    if (method === 'PATCH') {
      patches += 1;
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const at = Number(headers.get('upload-offset'));
      if (opts.fatalPart?.part === patches)
        return new Response('fatal', { status: opts.fatalPart.status });
      if (opts.failPart === patches)
        return new Response('flaky', { status: 503 });
      if (at !== offset)
        return new Response('offset mismatch', { status: 409 });
      const final = at + body.byteLength === total;
      if (!final) {
        if (partSize === null) {
          if (body.byteLength % (64 * 1024) !== 0 || body.byteLength < PART)
            return new Response('bad part size', { status: 400 });
          partSize = body.byteLength;
        } else if (body.byteLength !== partSize) {
          return new Response('part size changed', { status: 400 });
        }
      }
      received.set(body, at);
      offset += body.byteLength;
      if (opts.dropResponseOfPart === patches)
        throw new TypeError('fetch failed: connection reset');
      return new Response(null, {
        status: final ? 200 : 204,
        headers: final
          ? {
              'upload-offset': String(offset),
              'x-vfs-file-id': 'file-new',
              'x-vfs-content-hash': 'hash-new',
              'x-vfs-cid': 'bafy',
            }
          : { 'upload-offset': String(offset) },
      });
    }
    return new Response('unexpected', { status: 500 });
  };
  return {
    fetchImpl,
    received,
    log,
    get created() {
      return created;
    },
    get deleted() {
      return deleted;
    },
    get patches() {
      return patches;
    },
  };
}

function run(
  data: Uint8Array,
  server: ReturnType<typeof fakeTus>,
  extra: Partial<Parameters<typeof tusUpload>[0]> = {},
) {
  let minted = 0;
  return tusUpload({
    endpoint: ENDPOINT,
    path: '/.oracles/did/state.db.gz.uploading-1',
    contentType: 'application/gzip',
    totalLength: data.byteLength,
    partSize: PART,
    source: () => streamOfBytes(data),
    authHeaders: async () => ({
      authorization: `Bearer inv-${++minted}`,
      'x-auth-type': 'ucan',
    }),
    fetchImpl: server.fetchImpl,
    retryDelaysMs: [0, 0, 0],
    sleep: async () => undefined,
    ...extra,
  });
}

describe('tusUpload', () => {
  it('encodes Upload-Metadata as base64 pairs', () => {
    expect(uploadMetadata({ path: '/a b', contentType: 'x/y' })).toBe(
      `path ${btoa('/a b')},contentType ${btoa('x/y')}`,
    );
  });

  it('uploads in fixed parts and returns the file id from the final PATCH', async () => {
    const data = bytes(2 * PART + 12_345);
    const server = fakeTus(data.byteLength);
    const result = await run(data, server);
    expect(result).toMatchObject({
      fileId: 'file-new',
      contentHash: 'hash-new',
      parts: 3,
    });
    expect(sameBytes(server.received, data)).toBe(true);
    expect(server.log.filter((l) => l.startsWith('PATCH'))).toHaveLength(3);
  });

  it('resumes from HEAD when a committed part loses its response (no double send)', async () => {
    const data = bytes(2 * PART + 100);
    const server = fakeTus(data.byteLength, { dropResponseOfPart: 2 });
    const result = await run(data, server);
    expect(result.parts).toBe(3);
    expect(sameBytes(server.received, data)).toBe(true);
    // Part 2 was committed once; the probe saw it and moved on.
    expect(server.patches).toBe(3);
    expect(server.log).toContain('HEAD /api/fs/upload/sess-1');
  });

  it('resends a part the server rejected transiently', async () => {
    const data = bytes(PART + 1);
    const server = fakeTus(data.byteLength, { failPart: 1 });
    const result = await run(data, server);
    expect(result.fileId).toBe('file-new');
    expect(server.patches).toBe(3); // 503, resend, final
    expect(sameBytes(server.received, data)).toBe(true);
  });

  it('returns a null file id when the FINAL part committed but its response was lost', async () => {
    const data = bytes(PART + 5);
    const server = fakeTus(data.byteLength, { dropResponseOfPart: 2 });
    const result = await run(data, server);
    expect(result.fileId).toBeNull();
    expect(sameBytes(server.received, data)).toBe(true);
  });

  it('aborts the session on a fatal status instead of retrying', async () => {
    const data = bytes(PART + 5);
    const server = fakeTus(data.byteLength, {
      fatalPart: { part: 1, status: 413 },
    });
    const err = await run(data, server).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TusUploadError);
    expect((err as TusUploadError).retryable).toBe(false);
    expect(server.patches).toBe(1);
    expect(server.deleted).toBe(1);
  });

  it('refuses a declared length the source does not produce', async () => {
    // Two full parts, but six more bytes declared: the server accepts both
    // parts as non-final, the source ends early, the client must notice.
    const data = bytes(2 * PART);
    const server = fakeTus(2 * PART + 6);
    const err = await run(data, server, { totalLength: 2 * PART + 6 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TusUploadError);
    expect((err as TusUploadError).message).toMatch(/declared/);
    expect(server.deleted).toBe(1);
  });

  it('sends a single part of any size when the whole file fits', async () => {
    const data = bytes(1000);
    const server = fakeTus(1000);
    const result = await run(data, server);
    expect(result.parts).toBe(1);
    expect(sameBytes(server.received, data)).toBe(true);
  });
});
