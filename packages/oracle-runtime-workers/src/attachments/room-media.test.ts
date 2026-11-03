/**
 * A channel file posted to the session thread: streamed once from the
 * gateway's link to a fake homeserver, encrypted, checked against the
 * gateway's size and SHA-256 on the way; the turn's copy arrives as soon as
 * the check passes, the event content once the homeserver answers. Runs in
 * workerd: the pipeline needs `crypto.DigestStream` and `FixedLengthStream`.
 */
import { createAttachmentDecryptor } from '@ixo/matrix-bot-workers-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  channelAttachmentRef,
  ChannelFileUnavailableError,
  hex,
} from './channel';
import { MAX_FILE_SIZE } from './download';
import {
  ChannelMediaUploadError,
  channelFilesToKeep,
  channelMediaTxnId,
  roomMediaType,
  startChannelFileUploads,
  uploadChannelFile,
  type ChannelThreadFile,
  type ChannelUploadDeps,
} from './room-media';
import { NATIVE_DOCUMENT_MAX_BYTES } from './route';

const GATEWAY = 'https://channels.test';
const HOMESERVER = 'https://hs.test';
const MXC = 'mxc://hs.test/upload1';

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** `size` bytes that sniff as a JPEG. */
function plaintext(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  out.set([0xff, 0xd8, 0xff, 0xe0].slice(0, size));
  return out;
}

async function fileOf(
  bytes: Uint8Array,
  over: Partial<ChannelThreadFile> = {},
  object = 'obj-1',
): Promise<ChannelThreadFile> {
  const digest = await sha256(bytes);
  return {
    ref: channelAttachmentRef(digest),
    link: {
      url: `${GATEWAY}/media/chb_one/${object}?exp=1893456000&kid=k1&sig=c2ln`,
      sha256: digest,
      bindingId: 'chb_one',
    },
    index: 0,
    filename: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: bytes.byteLength,
    kind: 'image',
    ...over,
  };
}

/**
 * `bytes` in `chunk`-sized pieces, handed out when pulled; `stall` never
 * ends the stream. Like a real fetch body, it errors when the request's
 * signal aborts.
 */
function served(
  bytes: Uint8Array,
  opts: {
    chunk?: number;
    stall?: boolean;
    /** An empty chunk after the last one. */
    trailingEmpty?: boolean;
    onEnd?: () => void;
  } = {},
): (signal?: AbortSignal | null) => ReadableStream<Uint8Array> {
  return (signal) => {
    const chunk = opts.chunk ?? 1000;
    let offset = 0;
    let emptySent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) return undefined;
        if (offset >= bytes.byteLength) {
          if (opts.stall) return undefined;
          if (opts.trailingEmpty && !emptySent) {
            emptySent = true;
            controller.enqueue(new Uint8Array(0));
            return undefined;
          }
          controller.close();
          opts.onEnd?.();
          return undefined;
        }
        controller.enqueue(bytes.slice(offset, offset + chunk));
        offset += chunk;
        return undefined;
      },
      cancel() {
        opts.onEnd?.();
      },
    });
  };
}

interface Upload {
  url: URL;
  headers: Headers;
  body: Uint8Array;
}

/**
 * The gateway's links serve `bodies` (by URL); the homeserver reads the
 * whole upload, then answers `answer` (default 200 with `MXC`) once `hold`
 * (if any) settles. A body that errors makes the upload request fail, like
 * a real fetch; an aborted request rejects with the signal's reason.
 */
function network(opts: {
  bodies: Map<
    string,
    (signal?: AbortSignal | null) => ReadableStream<Uint8Array>
  >;
  answer?: () => Response;
  gatewayStatus?: number;
  hold?: Promise<void>;
}) {
  const uploads: Upload[] = [];
  const opened: string[] = [];
  /** Bytes each upload request delivered to the homeserver. */
  const received: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === GATEWAY) {
      opened.push(url.href);
      expect(init?.redirect).toBe('manual');
      if (opts.gatewayStatus)
        return new Response('gone', { status: opts.gatewayStatus });
      const body = opts.bodies.get(url.href);
      if (!body) return new Response('not found', { status: 404 });
      const res = new Response('', {
        headers: { 'content-type': 'image/jpeg' },
      });
      // The stream itself, chunk for chunk (a Response body would coalesce
      // or drop chunks, an empty one included).
      Object.defineProperty(res, 'body', { value: body(init?.signal) });
      return res;
    }
    expect(url.href.startsWith(`${HOMESERVER}/_matrix/media/v3/upload`)).toBe(
      true,
    );
    const signal = init?.signal;
    // What reached the homeserver, failed request or not: a real server
    // acts on a body once its Content-Length has arrived.
    let arrived = 0;
    received.push(0);
    const slot = received.length - 1;
    const counted =
      init?.body instanceof ReadableStream
        ? init.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                arrived += chunk.byteLength;
                received[slot] = arrived;
                controller.enqueue(chunk);
              },
            }),
          )
        : init?.body;
    const read = new Response(counted).arrayBuffer();
    const body = new Uint8Array(
      signal
        ? await new Promise<ArrayBuffer>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
            read.then(resolve, reject);
          })
        : await read,
    );
    uploads.push({ url, headers: new Headers(init?.headers), body });
    if (opts.hold)
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
        opts.hold?.then(resolve, reject);
      });
    return opts.answer?.() ?? Response.json({ content_uri: MXC });
  };
  return { fetchImpl, uploads, opened, received };
}

function deps(
  net: ReturnType<typeof network>,
  over: Partial<ChannelUploadDeps> = {},
): ChannelUploadDeps {
  return {
    origins: [GATEWAY],
    homeserver: { baseUrl: HOMESERVER, accessToken: 'plugin-token' },
    fetchImpl: net.fetchImpl,
    ...over,
  };
}

async function decrypt(cipher: Uint8Array, info: unknown): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(
      new Response(cipher).body!.pipeThrough(createAttachmentDecryptor(info)),
    ).arrayBuffer(),
  );
}

/** A promise and its resolve. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('uploadChannelFile', () => {
  it('streams an encrypted upload with no name or type, and hands the copy over before the homeserver answers', async () => {
    const bytes = plaintext(5000);
    const file = await fileOf(bytes, {
      filename: 'Report\u202Egpj.exe/../photo.jpg',
    });
    const answer = gate();
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
      hold: answer.promise,
    });
    const upload = uploadChannelFile(file, { ...deps(net), keep: true });
    // The copy comes while the homeserver has not answered yet.
    expect(await upload.copy).toEqual({ bytes, mimetype: 'image/jpeg' });
    answer.open();
    const media = await upload.uploaded;

    expect(net.opened).toEqual([file.link.url]);
    expect(net.uploads).toHaveLength(1);
    const sent = net.uploads[0]!;
    expect(sent.url.pathname).toBe('/_matrix/media/v3/upload');
    expect(sent.url.search).toBe('');
    expect(sent.headers.get('authorization')).toBe('Bearer plugin-token');
    expect(sent.headers.get('content-type')).toBe('application/octet-stream');
    expect(sent.body.byteLength).toBe(bytes.byteLength);
    expect(sent.body).not.toEqual(bytes);
    expect(media).toMatchObject({
      msgtype: 'm.image',
      // Cleaned: no bidi override, no path.
      body: 'photo.jpg',
      filename: 'photo.jpg',
      info: { mimetype: 'image/jpeg', size: 5000 },
      file: { url: MXC, v: 'v2' },
    });
    // What the room's clients download decrypts to the person's file.
    expect(await decrypt(sent.body, media.file)).toEqual(bytes);
  });

  it('names the type from the bytes, not the claim', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 pretending to be a photo');
    const file = await fileOf(pdf, { mimetype: 'image/jpeg' });
    const net = network({ bodies: new Map([[file.link.url, served(pdf)]]) });
    const media = await uploadChannelFile(file, { ...deps(net), keep: false })
      .uploaded;
    expect(media.msgtype).toBe('m.file');
    expect(media.info.mimetype).toBe('application/pdf');
  });

  it('keeps no copy when not asked to', async () => {
    const bytes = plaintext(300);
    const file = await fileOf(bytes);
    const net = network({ bodies: new Map([[file.link.url, served(bytes)]]) });
    const upload = uploadChannelFile(file, { ...deps(net), keep: false });
    expect(await upload.copy).toBeNull();
    await expect(upload.uploaded).resolves.toMatchObject({
      msgtype: 'm.image',
    });
  });

  it("refuses bytes whose digest is not the gateway's, even after an empty last chunk: the upload never completes", async () => {
    // A whole number of AES blocks: the cipher holds nothing back itself.
    const bytes = plaintext(3200);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([
        [file.link.url, served(bytes, { trailingEmpty: true })],
      ]),
    });
    const upload = uploadChannelFile(
      { ...file, link: { ...file.link, sha256: '0'.repeat(64) } },
      { ...deps(net), keep: true },
    );
    await expect(upload.uploaded).rejects.toThrow(
      'its bytes do not match the digest the channel sent',
    );
    expect(await upload.copy).toBeNull();
    // The homeserver never received the whole file: the last chunk was held.
    expect(net.uploads).toEqual([]);
    expect(net.received).toHaveLength(1);
    expect(net.received[0]).toBeLessThan(bytes.byteLength);
  });

  it('verifies a file whose stream ends with an empty chunk', async () => {
    const bytes = plaintext(2500);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([
        [file.link.url, served(bytes, { trailingEmpty: true })],
      ]),
    });
    const upload = uploadChannelFile(file, { ...deps(net), keep: true });
    expect((await upload.copy)?.bytes).toEqual(bytes);
    await expect(upload.uploaded).resolves.toMatchObject({
      msgtype: 'm.image',
    });
  });

  it('refuses a file longer or shorter than announced', async () => {
    const bytes = plaintext(1000);
    for (const size of [999, 1001]) {
      const file = await fileOf(bytes, { size });
      const net = network({
        bodies: new Map([[file.link.url, served(bytes)]]),
      });
      const upload = uploadChannelFile(file, { ...deps(net), keep: true });
      await expect(upload.uploaded).rejects.toBeInstanceOf(
        ChannelFileUnavailableError,
      );
      expect(await upload.copy).toBeNull();
    }
  });

  it('keeps the verified copy when the homeserver then refuses the upload, with its status', async () => {
    const bytes = plaintext(800);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
      answer: () => new Response('{"errcode":"M_UNKNOWN"}', { status: 500 }),
    });
    const upload = uploadChannelFile(file, { ...deps(net), keep: true });
    const error = await upload.uploaded.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelMediaUploadError);
    expect(error).toMatchObject({ status: 500 });
    expect((await upload.copy)?.bytes).toEqual(bytes);
  });

  it('tells the caller which token the homeserver rejected', async () => {
    const bytes = plaintext(200);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
      answer: () =>
        new Response('{"errcode":"M_UNKNOWN_TOKEN"}', { status: 401 }),
    });
    const onUnauthorized = vi.fn();
    await expect(
      uploadChannelFile(file, { ...deps(net, { onUnauthorized }), keep: false })
        .uploaded,
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledWith('plugin-token');
  });

  it('gives up at the read deadline when the gateway stalls: no copy, no upload', async () => {
    const file = await fileOf(plaintext(100), { size: 200 });
    const net = network({
      bodies: new Map([
        [file.link.url, served(plaintext(100), { stall: true })],
      ]),
    });
    const upload = uploadChannelFile(file, {
      ...deps(net, { readTimeoutMs: 50 }),
      keep: true,
    });
    await expect(upload.uploaded).rejects.toThrow('timed out');
    expect(await upload.copy).toBeNull();
    expect(net.uploads).toEqual([]);
  });

  it('when the homeserver, not the gateway, stalls: the copy comes on time and only the upload hits its own deadline', async () => {
    const bytes = plaintext(1500);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
      // Reads the whole body, then never answers.
      hold: new Promise<void>(() => undefined),
    });
    const startedAt = Date.now();
    const upload = uploadChannelFile(file, {
      ...deps(net, { readTimeoutMs: 5_000, uploadTimeoutMs: 80 }),
      keep: true,
    });
    expect((await upload.copy)?.bytes).toEqual(bytes);
    await expect(upload.uploaded).rejects.toThrow(
      'Uploading the file to the homeserver timed out',
    );
    // Well before the read deadline.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("never opens a link that is not the gateway's, and names no link in its errors", async () => {
    const bytes = plaintext(100);
    const file = await fileOf(bytes);
    const net = network({ bodies: new Map() });
    const offHost = {
      ...file,
      link: {
        ...file.link,
        url: file.link.url.replace(GATEWAY, 'https://evil.test'),
      },
    };
    const error = await uploadChannelFile(offHost, {
      ...deps(net),
      keep: true,
    }).uploaded.catch((e: unknown) => e);
    expect(String(error)).toContain('not one this channel gateway serves');
    expect(String(error)).not.toContain('sig=');
    expect(net.opened).toEqual([]);
    const gone = network({ bodies: new Map(), gatewayStatus: 410 });
    const refused = await uploadChannelFile(file, {
      ...deps(gone),
      keep: true,
    }).uploaded.catch((e: unknown) => e);
    expect(String(refused)).toContain('the channel gateway answered 410');
    expect(String(refused)).not.toContain('sig=');
  });
});

describe('roomMediaType', () => {
  const head = (...bytes: number[]) => new Uint8Array(bytes);
  it('m.image only for a raster image the bytes prove', () => {
    expect(roomMediaType(head(0x89, 0x50, 0x4e, 0x47), 'image/png')).toEqual({
      mimetype: 'image/png',
      msgtype: 'm.image',
    });
    // A claim the bytes do not back is not trusted.
    expect(roomMediaType(head(1, 2, 3, 4, 5), 'image/png')).toEqual({
      mimetype: 'application/octet-stream',
      msgtype: 'm.file',
    });
    // A raster type outside the allowlist.
    expect(roomMediaType(head(0x42, 0x4d, 0, 0), 'image/bmp')).toEqual({
      mimetype: 'application/octet-stream',
      msgtype: 'm.file',
    });
  });

  it('keeps a more precise claim of the sniffed container, and names audio and video', () => {
    const ftyp = head(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70);
    expect(roomMediaType(ftyp, 'audio/mp4')).toEqual({
      mimetype: 'audio/mp4',
      msgtype: 'm.audio',
    });
    expect(roomMediaType(ftyp, 'video/mp4')).toEqual({
      mimetype: 'video/mp4',
      msgtype: 'm.video',
    });
    expect(
      roomMediaType(head(0x4f, 0x67, 0x67, 0x53), 'audio/ogg; codecs=opus'),
    ).toEqual({
      mimetype: 'audio/ogg',
      msgtype: 'm.audio',
    });
    expect(roomMediaType(head(0x25, 0x50, 0x44, 0x46), 'text/html')).toEqual({
      mimetype: 'application/pdf',
      msgtype: 'm.file',
    });
  });
});

describe('the turn-level rules', () => {
  it('keeps copies only of files the model may read directly, in order, within the total', async () => {
    const image = await fileOf(plaintext(400), {}, 'a');
    const bigDoc = await fileOf(
      plaintext(NATIVE_DOCUMENT_MAX_BYTES + 1),
      {
        kind: 'document',
        mimetype: 'application/pdf',
      },
      'b',
    );
    const smallDoc = await fileOf(
      plaintext(500),
      {
        kind: 'document',
        mimetype: 'application/pdf',
      },
      'c',
    );
    const video = await fileOf(plaintext(100), { kind: 'video' }, 'd');
    const late = await fileOf(plaintext(300), {}, 'e');
    expect(
      channelFilesToKeep([image, bigDoc, smallDoc, video, late], 950),
    ).toEqual(new Set([image.ref, smallDoc.ref]));
    const huge = await fileOf(plaintext(10), { size: MAX_FILE_SIZE + 1 }, 'f');
    expect(channelFilesToKeep([huge])).toEqual(new Set());
  });

  it('hashes the request into the transaction id, one per file', async () => {
    const id = {
      userDid: 'did:ixo:ixo1user',
      bindingId: 'chb_one',
      requestId: 'req-secret',
      index: 0,
    };
    const first = await channelMediaTxnId(id);
    expect(first).toMatch(/^channel-[0-9a-f]{64}$/);
    expect(first).not.toContain('req-secret');
    expect(await channelMediaTxnId(id)).toBe(first);
    expect(await channelMediaTxnId({ ...id, index: 1 })).not.toBe(first);
  });
});

describe('startChannelFileUploads', () => {
  it("uploads a turn's files a few at a time, in message order, and logs a failure without its link", async () => {
    const files = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        fileOf(plaintext(500 + n), { index: n - 1 }, `obj-${n}`),
      ),
    );
    const broken = {
      ...files[2]!,
      link: { ...files[2]!.link, sha256: '0'.repeat(64) },
    };
    let open = 0;
    let mostOpen = 0;
    const bodies = new Map(
      files.map((f, i) => [
        f.link.url,
        (signal?: AbortSignal | null) => {
          open += 1;
          mostOpen = Math.max(mostOpen, open);
          return served(plaintext(500 + i + 1), {
            chunk: 100,
            onEnd: () => {
              open -= 1;
            },
          })(signal);
        },
      ]),
    );
    const net = network({ bodies });
    const log = { log: vi.fn(), warn: vi.fn() };
    const run = startChannelFileUploads({
      files: [files[0]!, files[1]!, broken, files[3]!],
      sessionId: '$session',
      deps: {
        ...deps(net),
        keep: new Set([files[0]!.ref]),
        concurrency: 2,
        log,
      },
    });
    expect(run.uploads.map((u) => u.file.ref)).toEqual([
      files[0]!.ref,
      files[1]!.ref,
      broken.ref,
      files[3]!.ref,
    ]);
    await run.done;
    expect(mostOpen).toBe(2);
    expect((await run.uploads[0]!.copy)?.bytes.byteLength).toBe(501);
    expect(await run.uploads[1]!.copy).toBeNull();
    await expect(run.uploads[2]!.uploaded).rejects.toThrow('digest');
    await expect(run.uploads[3]!.uploaded).resolves.toMatchObject({
      msgtype: 'm.image',
    });
    expect(log.warn).toHaveBeenCalledOnce();
    const line = String(log.warn.mock.calls[0]?.[0]);
    expect(line).toContain(broken.ref);
    expect(line).not.toContain('sig=');
    expect(String(log.log.mock.calls[0]?.[0])).toContain(
      'uploaded 3/4 channel file(s) of thread $session',
    );
  });

  it("skips the turn's remaining files once the homeserver rate-limits it", async () => {
    const files = await Promise.all(
      [1, 2, 3].map((n) => fileOf(plaintext(100 + n), {}, `r-${n}`)),
    );
    const net = network({
      bodies: new Map(
        files.map((f) => [f.link.url, served(plaintext(f.size))]),
      ),
      answer: () =>
        new Response('{"errcode":"M_LIMIT_EXCEEDED"}', { status: 429 }),
    });
    const log = { log: vi.fn(), warn: vi.fn() };
    const run = startChannelFileUploads({
      files,
      sessionId: '$session',
      deps: { ...deps(net), keep: new Set(), concurrency: 1, log },
    });
    await run.done;
    expect(net.uploads).toHaveLength(1);
    for (const upload of run.uploads)
      await expect(upload.uploaded).rejects.toBeInstanceOf(
        ChannelMediaUploadError,
      );
    expect(String(log.warn.mock.calls[2]?.[0])).toContain('rate-limited');
  });

  it('stops reading at the turn deadline and resolves the copies it never got', async () => {
    const stalled = await fileOf(plaintext(100), { size: 200 }, 'slow');
    const queued = await fileOf(plaintext(50), {}, 'later');
    const net = network({
      bodies: new Map([
        [stalled.link.url, served(plaintext(100), { stall: true })],
        [queued.link.url, served(plaintext(50))],
      ]),
    });
    const log = { log: vi.fn(), warn: vi.fn() };
    const run = startChannelFileUploads({
      files: [stalled, queued],
      sessionId: '$session',
      deps: {
        ...deps(net),
        keep: new Set([stalled.ref, queued.ref]),
        concurrency: 1,
        turnTimeoutMs: 50,
        log,
      },
    });
    expect(await run.uploads[0]!.copy).toBeNull();
    expect(await run.uploads[1]!.copy).toBeNull();
    await run.done;
    expect(net.uploads).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(String(log.warn.mock.calls[1]?.[0])).toContain('timed out');
  });
});
