/**
 * A channel file posted to the session thread: streamed once from the
 * gateway's link to a fake homeserver (encrypted in a Megolm room), checked
 * against the gateway's size and SHA-256 on the way, then sent as one media
 * event through a fake gateway. Runs in workerd: the pipeline needs
 * `crypto.DigestStream` and `FixedLengthStream`.
 */
import { createAttachmentDecryptor } from '@ixo/matrix-bot-workers-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { MediaMirrorSend } from '../do/room-mirror';
import { channelAttachmentRef, hex } from './channel';
import {
  ChannelMediaUploadError,
  channelMediaTxnId,
  postChannelFilesToThread,
  uploadChannelFileToThread,
  type ChannelThreadFile,
  type ThreadMediaDeps,
  type ThreadMediaTarget,
} from './room-media';

const GATEWAY = 'https://channels.test';
const HOMESERVER = 'https://hs.test';
const MXC = 'mxc://hs.test/upload1';

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

function plaintext(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
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
  opts: { chunk?: number; stall?: boolean; onEnd?: () => void } = {},
): (signal?: AbortSignal | null) => ReadableStream<Uint8Array> {
  return (signal) => {
    const chunk = opts.chunk ?? 1000;
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) return undefined;
        if (offset >= bytes.byteLength) {
          if (opts.stall) return undefined;
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
 * whole upload, then answers `answer` (default 200 with `MXC`). A body that
 * errors makes the upload request fail, like a real fetch.
 */
function network(opts: {
  bodies: Map<
    string,
    (signal?: AbortSignal | null) => ReadableStream<Uint8Array>
  >;
  answer?: () => Response;
  gatewayStatus?: number;
}) {
  const uploads: Upload[] = [];
  const opened: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === GATEWAY) {
      opened.push(url.href);
      expect(init?.redirect).toBe('manual');
      if (opts.gatewayStatus)
        return new Response('gone', { status: opts.gatewayStatus });
      const body = opts.bodies.get(url.href);
      return body
        ? new Response(body(init?.signal), {
            headers: { 'content-type': 'image/jpeg' },
          })
        : new Response('not found', { status: 404 });
    }
    expect(url.href.startsWith(`${HOMESERVER}/_matrix/media/v3/upload`)).toBe(
      true,
    );
    const signal = init?.signal;
    const read = new Response(init?.body).arrayBuffer();
    const body = new Uint8Array(
      signal
        ? await new Promise<ArrayBuffer>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
            read.then(resolve, reject);
          })
        : await read,
    );
    uploads.push({ url, headers: new Headers(init?.headers), body });
    return opts.answer?.() ?? Response.json({ content_uri: MXC });
  };
  return { fetchImpl, uploads, opened };
}

function gateway(answer: (event: MediaMirrorSend) => Promise<string>) {
  const sent: MediaMirrorSend[] = [];
  const send = vi.fn(async (event: MediaMirrorSend) => {
    sent.push(event);
    return answer(event);
  });
  return { send, sent };
}

const TARGET: ThreadMediaTarget = {
  roomId: '!room:hs.test',
  threadId: '$session',
  origin: {
    provider: 'whatsapp',
    bindingId: 'chb_one',
    remoteMessageRef: `hmac:${'a'.repeat(64)}`,
  },
  encrypted: true,
};

function deps(
  net: ReturnType<typeof network>,
  send: ThreadMediaDeps['send'],
  over: Partial<ThreadMediaDeps> = {},
): ThreadMediaDeps {
  return {
    origins: [GATEWAY],
    homeserver: { baseUrl: HOMESERVER, accessToken: 'plugin-token' },
    send,
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

describe('uploadChannelFileToThread', () => {
  it('streams an encrypted upload and posts one media event in the thread', async () => {
    const bytes = plaintext(5000);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
    });
    const gw = gateway(async () => '$file-event');
    const result = await uploadChannelFileToThread(
      file,
      TARGET,
      'media-txn',
      deps(net, gw.send),
    );

    expect(result).toEqual({
      eventId: '$file-event',
      mxc: MXC,
      bytes,
      mimetype: 'image/jpeg',
    });
    expect(net.opened).toEqual([file.link.url]);
    expect(net.uploads).toHaveLength(1);
    const upload = net.uploads[0]!;
    expect(upload.url.searchParams.get('filename')).toBe('photo.jpg');
    expect(upload.headers.get('authorization')).toBe('Bearer plugin-token');
    expect(upload.headers.get('content-type')).toBe('application/octet-stream');
    expect(upload.body.byteLength).toBe(bytes.byteLength);
    expect(upload.body).not.toEqual(bytes);

    expect(gw.sent).toHaveLength(1);
    const event = gw.sent[0]!;
    expect(event).toMatchObject({
      roomId: TARGET.roomId,
      threadId: '$session',
      txnId: 'media-txn',
      origin: TARGET.origin,
      media: {
        msgtype: 'm.image',
        body: 'photo.jpg',
        filename: 'photo.jpg',
        info: { mimetype: 'image/jpeg', size: 5000 },
        file: { url: MXC, v: 'v2' },
      },
    });
    expect(event.media.url).toBeUndefined();
    // What the room's clients download decrypts to the person's file.
    expect(await decrypt(upload.body, event.media.file)).toEqual(bytes);
  });

  it('uploads the plaintext with its type and sends `url` in a room that is not encrypted', async () => {
    const bytes = plaintext(1200);
    const file = await fileOf(bytes, {
      kind: 'document',
      filename: 'report.pdf',
      mimetype: 'application/pdf',
    });
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
    });
    const gw = gateway(async () => '$doc');
    await uploadChannelFileToThread(
      file,
      { ...TARGET, encrypted: false },
      't',
      deps(net, gw.send),
    );
    expect(net.uploads[0]!.headers.get('content-type')).toBe('application/pdf');
    expect(net.uploads[0]!.body).toEqual(bytes);
    expect(gw.sent[0]!.media).toEqual({
      msgtype: 'm.file',
      body: 'report.pdf',
      filename: 'report.pdf',
      info: { mimetype: 'application/pdf', size: 1200 },
      url: MXC,
    });
  });

  it('keeps no plaintext copy of a file above the model cap', async () => {
    const bytes = plaintext(3000);
    const file = await fileOf(bytes, { kind: 'video', mimetype: 'video/mp4' });
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
    });
    const gw = gateway(async () => '$video');
    const result = await uploadChannelFileToThread(
      file,
      TARGET,
      't',
      deps(net, gw.send, { keepMaxBytes: 2999 }),
    );
    expect(result.bytes).toBeUndefined();
    expect(result.eventId).toBe('$video');
    expect(gw.sent[0]!.media.msgtype).toBe('m.video');
  });

  it("refuses bytes whose digest is not the gateway's: the upload never completes and no event is sent", async () => {
    const bytes = plaintext(4000);
    const file = await fileOf(bytes, {
      link: {
        ...(await fileOf(bytes)).link,
        sha256: await sha256(plaintext(10)),
      },
    });
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
    });
    const gw = gateway(async () => '$never');
    await expect(
      uploadChannelFileToThread(file, TARGET, 't', deps(net, gw.send)),
    ).rejects.toThrow('its bytes do not match the digest the channel sent');
    expect(net.uploads).toHaveLength(0);
    expect(gw.send).not.toHaveBeenCalled();
  });

  it('refuses a file longer or shorter than announced', async () => {
    const bytes = plaintext(2000);
    for (const [announced, message] of [
      [1500, 'larger than the channel announced'],
      [2500, 'smaller than the channel announced'],
    ] as const) {
      const file = await fileOf(bytes, { size: announced });
      const net = network({
        bodies: new Map([[file.link.url, served(bytes)]]),
      });
      const gw = gateway(async () => '$never');
      await expect(
        uploadChannelFileToThread(file, TARGET, 't', deps(net, gw.send)),
      ).rejects.toThrow(message);
      expect(net.uploads).toHaveLength(0);
      expect(gw.send).not.toHaveBeenCalled();
    }
  });

  it('reports a refused or failed upload with the homeserver status and sends nothing', async () => {
    const bytes = plaintext(800);
    for (const status of [413, 502]) {
      const file = await fileOf(bytes);
      const net = network({
        bodies: new Map([[file.link.url, served(bytes)]]),
        answer: () => Response.json({ errcode: 'M_TOO_LARGE' }, { status }),
      });
      const gw = gateway(async () => '$never');
      const error = await uploadChannelFileToThread(
        file,
        TARGET,
        't',
        deps(net, gw.send),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChannelMediaUploadError);
      expect(error instanceof ChannelMediaUploadError && error.status).toBe(
        status,
      );
      expect(gw.send).not.toHaveBeenCalled();
    }
  });

  it('tells the caller when the homeserver rejects the device token', async () => {
    const bytes = plaintext(100);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
      answer: () =>
        Response.json({ errcode: 'M_UNKNOWN_TOKEN' }, { status: 401 }),
    });
    const onUnauthorized = vi.fn();
    await expect(
      uploadChannelFileToThread(
        file,
        TARGET,
        't',
        deps(net, gateway(async () => '$never').send, { onUnauthorized }),
      ),
    ).rejects.toThrow('401');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('rejects when the event send fails', async () => {
    const bytes = plaintext(600);
    const file = await fileOf(bytes);
    const net = network({
      bodies: new Map([[file.link.url, served(bytes)]]),
    });
    await expect(
      uploadChannelFileToThread(
        file,
        TARGET,
        't',
        deps(
          net,
          gateway(async () => {
            throw new Error('M_FORBIDDEN: not in room');
          }).send,
        ),
      ),
    ).rejects.toThrow('M_FORBIDDEN');
    expect(net.uploads).toHaveLength(1);
  });

  it('gives up at the deadline when the gateway stalls, without sending', async () => {
    const bytes = plaintext(3000);
    const file = await fileOf(bytes, { size: 6000 });
    const net = network({
      bodies: new Map([[file.link.url, served(bytes, { stall: true })]]),
    });
    const gw = gateway(async () => '$never');
    await expect(
      uploadChannelFileToThread(
        file,
        TARGET,
        't',
        deps(net, gw.send, { timeoutMs: 50 }),
      ),
    ).rejects.toThrow('Posting the file to the session thread timed out');
    expect(gw.send).not.toHaveBeenCalled();
  });

  it("never opens a link that is not the gateway's, and names no link in its errors", async () => {
    const bytes = plaintext(10);
    const file = await fileOf(bytes);
    const foreign = {
      ...file,
      link: { ...file.link, url: 'https://evil.test/media/chb_one/x?sig=s' },
    };
    const net = network({ bodies: new Map() });
    await expect(
      uploadChannelFileToThread(
        foreign,
        TARGET,
        't',
        deps(net, gateway(async () => '$never').send),
      ),
    ).rejects.toThrow('not one this channel gateway serves');
    expect(net.opened).toHaveLength(0);

    const gone = network({ bodies: new Map(), gatewayStatus: 410 });
    const error = await uploadChannelFileToThread(
      file,
      TARGET,
      't',
      deps(gone, gateway(async () => '$never').send),
    ).catch((e: unknown) => e);
    expect(String(error)).toContain('the channel gateway answered 410');
    expect(String(error)).not.toContain('sig=');
  });
});

describe('postChannelFilesToThread', () => {
  it("posts a turn's files a few at a time, each with its own transaction id, and logs a failure without its link", async () => {
    const files = await Promise.all(
      [1, 2, 3, 4].map((n) => fileOf(plaintext(500 + n), {}, `obj-${n}`)),
    );
    const broken = {
      ...files[2]!,
      link: { ...files[2]!.link, sha256: '0'.repeat(64) },
    };
    const turnFiles = [files[0]!, files[1]!, broken, files[3]!, files[0]!];
    // Links being read at the same time.
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
    const gw = gateway(async (event) => `$${event.txnId}`);
    const log = { log: vi.fn(), warn: vi.fn() };
    const posted = await postChannelFilesToThread({
      files: turnFiles,
      target: TARGET,
      sessionId: '$session',
      requestId: 'req-1',
      deps: { ...deps(net, gw.send), concurrency: 2, log },
    });

    expect([...posted.keys()]).toEqual(
      expect.arrayContaining([files[0]!.ref, files[1]!.ref, files[3]!.ref]),
    );
    expect(posted.size).toBe(3);
    expect(posted.get(files[3]!.ref)?.eventId).toBe(
      `$${channelMediaTxnId('$session', 'req-1', 3)}`,
    );
    expect(mostOpen).toBe(2);
    // The file sent twice in the message is posted once.
    expect(gw.sent).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledOnce();
    const line = String(log.warn.mock.calls[0]?.[0]);
    expect(line).toContain(broken.ref);
    expect(line).toContain('do not match the digest');
    expect(line).not.toContain('sig=');
    expect(String(log.log.mock.calls[0]?.[0])).toContain(
      'posted 3/4 channel file(s) to thread $session',
    );
  });

  it('keeps plaintext copies in turn order only while they fit the turn budget', async () => {
    const files = await Promise.all(
      [400, 500, 300].map((size, n) => fileOf(plaintext(size), {}, `b-${n}`)),
    );
    const net = network({
      bodies: new Map(
        files.map((f) => [f.link.url, served(plaintext(f.size))]),
      ),
    });
    const posted = await postChannelFilesToThread({
      files,
      target: TARGET,
      sessionId: '$session',
      requestId: 'req-3',
      deps: {
        ...deps(net, gateway(async (event) => `$${event.txnId}`).send),
        keepTotalBytes: 750,
        log: { log: vi.fn(), warn: vi.fn() },
      },
    });
    expect(files.map((f) => posted.get(f.ref)?.bytes?.byteLength)).toEqual([
      400,
      undefined,
      300,
    ]);
  });

  it('stops at the turn deadline and leaves the rest to the gateway download', async () => {
    const stalled = await fileOf(plaintext(100), { size: 200 }, 'slow');
    const queued = await fileOf(plaintext(50), {}, 'later');
    const net = network({
      bodies: new Map([
        [stalled.link.url, served(plaintext(100), { stall: true })],
        [queued.link.url, served(plaintext(50))],
      ]),
    });
    const gw = gateway(async () => '$never');
    const log = { log: vi.fn(), warn: vi.fn() };
    const posted = await postChannelFilesToThread({
      files: [stalled, queued],
      target: TARGET,
      sessionId: '$session',
      requestId: 'req-2',
      deps: { ...deps(net, gw.send), concurrency: 1, turnTimeoutMs: 50, log },
    });
    expect(posted.size).toBe(0);
    expect(gw.send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(String(log.warn.mock.calls[1]?.[0])).toContain('timed out');
  });
});
