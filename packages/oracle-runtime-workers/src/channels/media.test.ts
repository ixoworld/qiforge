/**
 * `POST /channels/media` reads in the user's object (`serveChannelMedia`):
 * ownership, both kinds, the one-read slot, the deadline, the checks on the
 * way (size, SHA-256) and the HTTP answer. Runs in workerd: the body is
 * hashed with `crypto.DigestStream` and sent through `FixedLengthStream`.
 */
import {
  createAttachmentEncryptor,
  type EncryptedFileInfo,
  createAttachmentDecryptor,
} from '@ixo/matrix-bot-workers-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hex } from '../attachments/channel';
import { HomeserverMediaError } from '../attachments/download';
import type { StoredArtifact } from '../artifacts/store';
import type { EventMediaInfo } from '../do/contracts';
import { ChannelError } from './contract';
import {
  CHANNEL_MEDIA_MAX_BYTES,
  ChannelMediaBody,
  ChannelMediaSlot,
  channelMediaErrorResponse,
  channelMediaResponse,
  serveChannelMedia,
  type ChannelMediaOutcome,
  type ChannelMediaQuery,
  type ChannelMediaSource,
} from './media';

const SESSION = '$thread-1';
const REF = 'channel:0123456789abcdef';
const ARTIFACT = 'a'.repeat(32);
const EVENT = '$file-event';
const ROOM = '!room:hs.test';
const MXC = 'mxc://hs.test/media1';

const fileQuery: ChannelMediaQuery = {
  kind: 'file',
  sessionId: SESSION,
  ref: REF,
};
const artifactQuery: ChannelMediaQuery = {
  kind: 'artifact',
  sessionId: SESSION,
  artifactId: ARTIFACT,
};

function plaintext(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `plain` encrypted as a Matrix attachment: the stored ciphertext and its `file` fields. */
async function encrypt(
  plain: Uint8Array,
): Promise<{ cipher: Uint8Array; file: EncryptedFileInfo }> {
  const encryptor = createAttachmentEncryptor();
  const cipher = readAll(
    new Response(plain).body!.pipeThrough(encryptor.transform),
  );
  return { cipher: await cipher, file: await encryptor.info };
}

/** A stored upload served in `chunk`-byte pieces on demand; `stallAfter` pieces then never another. */
function storedStream(
  bytes: Uint8Array,
  opts: { chunk?: number; stallAfter?: number } = {},
): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
} {
  const chunk = opts.chunk ?? 1024;
  let offset = 0;
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (opts.stallAfter !== undefined && pulls >= opts.stallAfter)
          return new Promise(() => undefined);
        pulls += 1;
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunk));
        offset += chunk;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

interface Fixture {
  source: ChannelMediaSource;
  calls: { eventMediaInfo: number; openMedia: number; artifact: number };
  stored?: ReturnType<typeof storedStream>;
}

async function fileFixture(
  opts: {
    size?: number;
    owned?: boolean;
    copy?: boolean;
    room?: boolean;
    info?: Partial<EventMediaInfo> | null;
    sha256?: string;
    eventMediaInfo?: () => Promise<EventMediaInfo | null>;
    openMedia?: () => Promise<ReadableStream<Uint8Array>>;
    chunk?: number;
    stallAfter?: number;
    encrypted?: boolean;
    artifact?: StoredArtifact;
    /** The row keeps the event's media info (as every copy posted now does). */
    stored?: boolean;
  } = {},
): Promise<Fixture & { plain: Uint8Array }> {
  const plain = plaintext(opts.size ?? 10_000);
  const encrypted = opts.encrypted ?? true;
  const { cipher, file } = encrypted
    ? await encrypt(plain)
    : { cipher: plain, file: undefined };
  const digest = opts.sha256 ?? (await sha256(plain));
  const calls = { eventMediaInfo: 0, openMedia: 0, artifact: 0 };
  const fixture: Fixture & { plain: Uint8Array } = {
    plain,
    calls,
    source: {
      ownsSession: async (sessionId) =>
        (opts.owned ?? true) && sessionId === SESSION,
      fileRoomCopy: async (sessionId, ref) =>
        (opts.copy ?? true) && sessionId === SESSION && ref === REF
          ? {
              eventId: EVENT,
              sha256: digest,
              ...(opts.stored
                ? {
                    media: {
                      mxc: MXC,
                      ...(file ? { file } : {}),
                      mimetype: 'image/jpeg',
                      filename: 'holiday photo é.jpg',
                      size: plain.byteLength,
                    },
                  }
                : {}),
            }
          : undefined,
      sessionRoom: async () => ((opts.room ?? true) ? ROOM : undefined),
      eventMediaInfo: async (roomId, eventId) => {
        calls.eventMediaInfo += 1;
        if (opts.eventMediaInfo) return opts.eventMediaInfo();
        expect([roomId, eventId]).toEqual([ROOM, EVENT]);
        if (opts.info === null) return null;
        return {
          mxc: MXC,
          ...(file ? { file } : {}),
          mimetype: 'image/jpeg',
          filename: 'holiday photo é.jpg',
          size: plain.byteLength,
          ...opts.info,
        };
      },
      openMedia: async () => {
        calls.openMedia += 1;
        if (opts.openMedia) return opts.openMedia();
        fixture.stored = storedStream(cipher, {
          ...(opts.chunk !== undefined ? { chunk: opts.chunk } : {}),
          ...(opts.stallAfter !== undefined
            ? { stallAfter: opts.stallAfter }
            : {}),
        });
        return fixture.stored.stream;
      },
      decryptor: (info) => createAttachmentDecryptor(info),
      artifact: async () => {
        calls.artifact += 1;
        return opts.artifact;
      },
    },
  };
  return fixture;
}

function storedArtifact(over: Partial<StoredArtifact> = {}): StoredArtifact {
  return {
    ref: {
      artifactId: ARTIFACT,
      title: 'Your plan',
      mime: 'text/markdown',
      bytes: 12,
      expiresAt: '2026-01-01T00:00:00.000Z',
    },
    sessionId: SESSION,
    content: '# Plan\n\nhi',
    createdAt: '2025-12-01T00:00:00.000Z',
    revoked: false,
    ...over,
  };
}

const serve = (
  query: ChannelMediaQuery,
  source: ChannelMediaSource,
  slot = new ChannelMediaSlot(),
  deadlineMs?: number,
  lookupTimeoutMs?: number,
): Promise<ChannelMediaOutcome> =>
  serveChannelMedia(query, {
    slot,
    prepare: async () => source,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(lookupTimeoutMs !== undefined ? { lookupTimeoutMs } : {}),
  });

/** Settle pending stream callbacks. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

let logs: string[];
beforeEach(() => {
  logs = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The structured fields of the media read lines logged so far. */
const readLines = () =>
  logs
    .filter((line) => line.startsWith('[channels] media read '))
    .map(
      (line) =>
        JSON.parse(line.slice('[channels] media read '.length)) as {
          kind: string;
          outcome: string;
          bytes: number;
          ms: number;
        },
    );

describe('media request body', () => {
  const body = (query: unknown) => ({
    provider: 'web',
    bindingId: 'chb_web',
    bindingRevision: 2,
    requestId: 'web-media:1',
    query,
  });

  it('takes a file by its channel reference or a document by its id, in one session, and nothing else', () => {
    expect(ChannelMediaBody.safeParse(body(fileQuery)).success).toBe(true);
    expect(ChannelMediaBody.safeParse(body(artifactQuery)).success).toBe(true);
    for (const query of [
      { kind: 'file', sessionId: SESSION, ref: 'mxc://hs/x' },
      { kind: 'file', sessionId: SESSION, ref: 'channel:0123' },
      { kind: 'file', sessionId: SESSION, ref: REF, artifactId: ARTIFACT },
      { kind: 'artifact', sessionId: SESSION, artifactId: 'nope' },
      { kind: 'artifact', artifactId: ARTIFACT },
      { kind: 'file', sessionId: '', ref: REF },
      { kind: 'file', sessionId: '$a b', ref: REF },
      { kind: 'file', sessionId: '$é', ref: REF },
      { kind: 'file', sessionId: `$${'a'.repeat(255)}`, ref: REF },
      { kind: 'file', sessionId: SESSION, ref: 'channel:0123456789ABCDEF' },
      { kind: 'artifact', sessionId: SESSION, artifactId: 'A'.repeat(32) },
      { kind: 'other', sessionId: SESSION },
    ])
      expect(ChannelMediaBody.safeParse(body(query)).success).toBe(false);
    expect(
      ChannelMediaBody.safeParse({ ...body(fileQuery), extra: 1 }).success,
    ).toBe(false);
  });
});

describe('serveChannelMedia: a file the person sent', () => {
  it('streams the decrypted room copy with its length, type, name and SHA-256, then frees the slot', async () => {
    const fixture = await fileFixture({ size: 70_000, chunk: 8192 });
    const slot = new ChannelMediaSlot();
    const outcome = await serve(fileQuery, fixture.source, slot);
    expect(outcome.ok).toBe(true);
    expect(slot.busy).toBe(true);
    const response = channelMediaResponse(outcome);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-length')).toBe('70000');
    expect(response.headers.get('x-ixo-file-name')).toBe(
      encodeURIComponent('holiday photo é.jpg'),
    );
    expect(response.headers.get('x-ixo-sha256')).toBe(
      await sha256(fixture.plain),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await readAll(response.body!)).toEqual(fixture.plain);
    await tick();
    expect(slot.busy).toBe(false);
    expect(fixture.calls.eventMediaInfo).toBe(1);
    expect(readLines()).toEqual([
      { kind: 'file', outcome: 'ok', bytes: 70_000, ms: expect.any(Number) },
    ]);
    // Never a name, a reference, a session, a room or an event in the log.
    for (const secret of ['holiday', REF, SESSION, ROOM, EVENT, MXC])
      expect(logs.join('\n')).not.toContain(secret);
  });

  it('reads a copy posted with its media info straight from the homeserver: no call on the gateway object', async () => {
    const fixture = await fileFixture({ size: 20_000, stored: true });
    const outcome = await serve(fileQuery, fixture.source);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    expect(await readAll(outcome.body)).toEqual(fixture.plain);
    expect(fixture.calls.eventMediaInfo).toBe(0);
    expect(fixture.calls.openMedia).toBe(1);
  });

  it('reads a copy recorded before its media info was kept through exactly one gateway lookup', async () => {
    const fixture = await fileFixture({ size: 20_000 });
    const outcome = await serve(fileQuery, fixture.source);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    expect(await readAll(outcome.body)).toEqual(fixture.plain);
    expect(fixture.calls.eventMediaInfo).toBe(1);
  });

  it('never answers a slow or failing legacy lookup as not found: 504 past its cap, 502 on a failure', async () => {
    const slow = await fileFixture({
      eventMediaInfo: () => new Promise(() => undefined),
    });
    const slot = new ChannelMediaSlot();
    expect(await serve(fileQuery, slow.source, slot, 5000, 50)).toEqual({
      ok: false,
      status: 504,
      error: 'timeout',
    });
    expect(slot.busy).toBe(false);
    const failing = await fileFixture({
      eventMediaInfo: () => Promise.reject(new Error('decrypt failed')),
    });
    expect(await serve(fileQuery, failing.source)).toEqual({
      ok: false,
      status: 502,
      error: 'upstream',
    });
  });

  it('reads upstream only as fast as the caller reads (no buffering of the file)', async () => {
    const fixture = await fileFixture({ size: 64 * 1024, chunk: 1024 });
    const outcome = await serve(fileQuery, fixture.source);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    const reader = outcome.body.getReader();
    await reader.read();
    await tick();
    // One chunk out, one held back for the check, a few in the pipe: far
    // from the 65 chunks of the file.
    expect(fixture.stored!.pulls()).toBeLessThan(10);
    await reader.cancel();
  });

  it('serves an unencrypted room copy as stored', async () => {
    const fixture = await fileFixture({ encrypted: false, size: 3000 });
    const outcome = await serve(fileQuery, fixture.source);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    expect(await readAll(outcome.body)).toEqual(fixture.plain);
  });

  it('answers the same 404 for an unowned session, an unknown reference, no room copy, no room and a missing event', async () => {
    const cases = [
      await fileFixture({ owned: false }),
      await fileFixture({ copy: false }),
      await fileFixture({ room: false }),
      await fileFixture({ info: null }),
    ];
    for (const fixture of cases) {
      const outcome = await serve(fileQuery, fixture.source);
      expect(outcome).toEqual({ ok: false, status: 404, error: 'not_found' });
      expect(fixture.calls.openMedia).toBe(0);
    }
    // Nothing reached the shared gateway object for the first three.
    expect(cases.map((fixture) => fixture.calls.eventMediaInfo)).toEqual([
      0, 0, 0, 1,
    ]);
    const other = await fileFixture();
    expect(
      await serve({ ...fileQuery, sessionId: '$other' }, other.source),
    ).toEqual({ ok: false, status: 404, error: 'not_found' });
    expect(
      await serve(
        { ...fileQuery, ref: 'channel:fedcba9876543210' },
        other.source,
      ),
    ).toEqual({ ok: false, status: 404, error: 'not_found' });
  });

  it('asks the Matrix gateway object once, and a failure there is 502 upstream (no retry)', async () => {
    const fixture = await fileFixture({
      eventMediaInfo: () => Promise.reject(new Error('gateway restarted')),
    });
    const slot = new ChannelMediaSlot();
    expect(await serve(fileQuery, fixture.source, slot)).toEqual({
      ok: false,
      status: 502,
      error: 'upstream',
    });
    expect(fixture.calls.eventMediaInfo).toBe(1);
    expect(slot.busy).toBe(false);
    expect(logs.join('\n')).not.toContain('gateway restarted');
  });

  it('maps a homeserver 404 to not_found and any other homeserver failure to upstream', async () => {
    const gone = await fileFixture({
      openMedia: () => Promise.reject(new HomeserverMediaError(404)),
    });
    expect(await serve(fileQuery, gone.source)).toEqual({
      ok: false,
      status: 404,
      error: 'not_found',
    });
    const broken = await fileFixture({
      openMedia: () => Promise.reject(new HomeserverMediaError(500)),
    });
    expect(await serve(fileQuery, broken.source)).toEqual({
      ok: false,
      status: 502,
      error: 'upstream',
    });
  });

  it('refuses a file above 25 MiB before reading it, and an event without a size', async () => {
    const big = await fileFixture({
      info: { size: CHANNEL_MEDIA_MAX_BYTES + 1 },
    });
    expect(await serve(fileQuery, big.source)).toEqual({
      ok: false,
      status: 413,
      error: 'too_large',
    });
    expect(big.calls.openMedia).toBe(0);
    const unsized = await fileFixture({ info: { size: undefined } });
    expect(await serve(fileQuery, unsized.source)).toEqual({
      ok: false,
      status: 502,
      error: 'upstream',
    });
  });

  it('fails the body, never delivering it whole, when the bytes are not the SHA-256 the gateway announced', async () => {
    const fixture = await fileFixture({ size: 5000, sha256: 'f'.repeat(64) });
    const slot = new ChannelMediaSlot();
    const outcome = await serve(fileQuery, fixture.source, slot);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    const reader = outcome.body.getReader();
    let received = 0;
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          received += value.byteLength;
        }
      })(),
    ).rejects.toThrow(/SHA-256/);
    expect(received).toBeLessThan(5000);
    expect(slot.busy).toBe(false);
    expect(readLines().at(-1)?.outcome).toBe('hash_mismatch');
  });

  it('fails the body when the file is shorter or longer than its event says', async () => {
    for (const size of [6000, 4000]) {
      const fixture = await fileFixture({ size: 5000, info: { size } });
      const slot = new ChannelMediaSlot();
      const outcome = await serve(fileQuery, fixture.source, slot);
      if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
      await expect(readAll(outcome.body)).rejects.toThrow();
      expect(slot.busy).toBe(false);
      expect(readLines().at(-1)?.outcome).toBe('size_mismatch');
    }
  });

  it('fails the HTTP body too when the stream fails (the caller sees a broken body)', async () => {
    const fixture = await fileFixture({ size: 5000, sha256: 'f'.repeat(64) });
    const response = channelMediaResponse(
      await serve(fileQuery, fixture.source),
    );
    expect(response.status).toBe(200);
    await expect(readAll(response.body!)).rejects.toThrow();
  });

  it('releases the slot and cancels the homeserver read when the caller abandons the body', async () => {
    const fixture = await fileFixture({ size: 50_000, chunk: 1024 });
    const slot = new ChannelMediaSlot();
    const outcome = await serve(fileQuery, fixture.source, slot);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    const reader = outcome.body.getReader();
    await reader.read();
    expect(slot.busy).toBe(true);
    await reader.cancel('caller went away');
    await tick();
    expect(slot.busy).toBe(false);
    expect(fixture.stored!.cancelled()).toBe(true);
    expect(readLines().at(-1)?.outcome).toBe('aborted');
  });

  it('answers 504 timeout when the event lookup outlives the deadline', async () => {
    const fixture = await fileFixture({
      eventMediaInfo: () => new Promise(() => undefined),
    });
    const slot = new ChannelMediaSlot();
    expect(await serve(fileQuery, fixture.source, slot, 50)).toEqual({
      ok: false,
      status: 504,
      error: 'timeout',
    });
    expect(slot.busy).toBe(false);
  });

  it('fails the body and cancels upstream when the homeserver stalls past the deadline', async () => {
    const fixture = await fileFixture({
      size: 50_000,
      chunk: 1024,
      stallAfter: 3,
    });
    const slot = new ChannelMediaSlot();
    const outcome = await serve(fileQuery, fixture.source, slot, 200);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    await expect(readAll(outcome.body)).rejects.toThrow(/timed out/);
    await tick();
    expect(slot.busy).toBe(false);
    expect(fixture.stored!.cancelled()).toBe(true);
    expect(readLines().at(-1)?.outcome).toBe('timeout');
  });
});

describe('serveChannelMedia: the headers deadline', () => {
  it('answers 504 at the headers deadline when the homeserver never answers, frees the slot at once and cuts the download', async () => {
    let downloadSignal: AbortSignal | undefined;
    const stalled = await fileFixture({ stored: true });
    const source: ChannelMediaSource = {
      ...stalled.source,
      openMedia: (_mxc, signal) => {
        downloadSignal = signal;
        return new Promise(() => undefined);
      },
    };
    const slot = new ChannelMediaSlot();
    const started = Date.now();
    const outcome = await serveChannelMedia(fileQuery, {
      slot,
      prepare: async () => source,
      deadlineMs: 5000,
      headersDeadlineMs: 100,
    });
    expect(outcome).toEqual({ ok: false, status: 504, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slot.busy).toBe(false);
    expect(downloadSignal?.aborted).toBe(true);
    expect(readLines().at(-1)?.outcome).toBe('timeout');
    // The next read is served.
    const healthy = await fileFixture({ stored: true });
    const next = await serveChannelMedia(fileQuery, {
      slot,
      prepare: async () => healthy.source,
      deadlineMs: 5000,
      headersDeadlineMs: 100,
    });
    if (!next.ok || next.kind !== 'file') throw new Error('no file');
    expect(await readAll(next.body)).toEqual(healthy.plain);
  });

  it('answers 504 at the headers deadline while the object boots', async () => {
    const slot = new ChannelMediaSlot();
    expect(
      await serveChannelMedia(fileQuery, {
        slot,
        prepare: () => new Promise(() => undefined),
        deadlineMs: 5000,
        headersDeadlineMs: 50,
      }),
    ).toEqual({ ok: false, status: 504, error: 'timeout' });
    expect(slot.busy).toBe(false);
  });

  it('holds only the whole-read deadline once the body is handed on', async () => {
    const fixture = await fileFixture({
      size: 30_000,
      chunk: 1024,
      stored: true,
    });
    const slot = new ChannelMediaSlot();
    const outcome = await serveChannelMedia(fileQuery, {
      slot,
      prepare: async () => fixture.source,
      deadlineMs: 5000,
      headersDeadlineMs: 50,
    });
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    // Read slowly, past the headers deadline: the body still completes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readAll(outcome.body)).toEqual(fixture.plain);
    await tick();
    expect(slot.busy).toBe(false);
  });
});

describe('serveChannelMedia: one read per object', () => {
  it('answers 429 busy at once while a read is in flight, the same reference included, before preparing anything', async () => {
    const fixture = await fileFixture({ size: 20_000 });
    const slot = new ChannelMediaSlot();
    const first = await serve(fileQuery, fixture.source, slot);
    if (!first.ok || first.kind !== 'file') throw new Error('no file');
    const prepare = vi.fn(async () => fixture.source);
    const second = await serveChannelMedia(fileQuery, { slot, prepare });
    expect(second).toEqual({
      ok: false,
      status: 429,
      error: 'busy',
      retryAfter: 2,
    });
    expect(prepare).not.toHaveBeenCalled();
    const response = channelMediaErrorResponse(
      second as Extract<ChannelMediaOutcome, { ok: false }>,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({ error: 'busy' });
    // The first read ends; the next one is served.
    await readAll(first.body);
    await tick();
    const third = await serve(fileQuery, fixture.source, slot);
    expect(third.ok).toBe(true);
    if (third.ok && third.kind === 'file') await third.body.cancel();
  });

  it("returns a refusal of the object's own (a ChannelError from prepare) and frees the slot", async () => {
    const slot = new ChannelMediaSlot();
    const outcome = await serveChannelMedia(fileQuery, {
      slot,
      prepare: () =>
        Promise.reject(
          new ChannelError(428, 'Authorize again', 'delegation_required'),
        ),
    });
    expect(outcome).toEqual({
      ok: false,
      status: 428,
      error: 'delegation_required',
    });
    expect(slot.busy).toBe(false);
  });

  it('frees the slot and rethrows an unexpected failure', async () => {
    const slot = new ChannelMediaSlot();
    await expect(
      serveChannelMedia(fileQuery, {
        slot,
        prepare: () => Promise.reject(new Error('sqlite closed')),
      }),
    ).rejects.toThrow('sqlite closed');
    expect(slot.busy).toBe(false);
  });
});

describe('serveChannelMedia: a document the oracle made', () => {
  it('answers the envelope the share link opens to, from the row, also once the link expired or was revoked', async () => {
    for (const artifact of [
      storedArtifact(),
      storedArtifact({ revoked: true }),
    ]) {
      const fixture = await fileFixture({ artifact });
      const slot = new ChannelMediaSlot();
      const outcome = await serve(artifactQuery, fixture.source, slot);
      expect(slot.busy).toBe(false);
      const response = channelMediaResponse(outcome);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(await response.json()).toEqual({
        v: 1,
        title: 'Your plan',
        mime: 'text/markdown',
        content: '# Plan\n\nhi',
        createdAt: '2025-12-01T00:00:00.000Z',
      });
      // No Matrix hop for a document.
      expect(fixture.calls.eventMediaInfo).toBe(0);
    }
  });

  it('answers 404 for an unknown document, one of another session, or an unowned session', async () => {
    for (const fixture of [
      await fileFixture(),
      await fileFixture({ artifact: storedArtifact({ sessionId: '$other' }) }),
      await fileFixture({ owned: false, artifact: storedArtifact() }),
    ])
      expect(await serve(artifactQuery, fixture.source)).toEqual({
        ok: false,
        status: 404,
        error: 'not_found',
      });
  });

  it('refuses a document above 25 MiB', async () => {
    const fixture = await fileFixture({
      artifact: storedArtifact({
        ref: {
          ...storedArtifact().ref,
          bytes: CHANNEL_MEDIA_MAX_BYTES + 1,
        },
      }),
    });
    expect(await serve(artifactQuery, fixture.source)).toEqual({
      ok: false,
      status: 413,
      error: 'too_large',
    });
  });
});

describe('channelMediaResponse', () => {
  const body = () => {
    let cancelled = false;
    return {
      stream: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      cancelled: () => cancelled,
    };
  };

  it('cancels the object body (freeing its slot) and answers 502 when the answer cannot be built', async () => {
    const source = body();
    const response = channelMediaResponse({
      ok: true,
      kind: 'file',
      body: source.stream,
      size: -1,
      mime: 'application/pdf',
      name: 'x.pdf',
      sha256: 'ab'.repeat(32),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'upstream' });
    await tick();
    expect(source.cancelled()).toBe(true);
  });

  it('never throws on a name or type a header cannot carry', async () => {
    const source = body();
    const response = channelMediaResponse({
      ok: true,
      kind: 'file',
      body: source.stream,
      size: 0,
      mime: 'text/html\r\nx-evil: 1',
      name: 'bad\uD800name.pdf',
      sha256: 'ab'.repeat(32),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('x-ixo-file-name')).toBe(
      'bad%EF%BF%BDname.pdf',
    );
    expect(response.headers.get('x-evil')).toBeNull();
    await response.body?.cancel();
  });

  it('answers a 503 with Retry-After 5', () => {
    const response = channelMediaErrorResponse({
      status: 503,
      error: 'binding_check_unavailable',
    });
    expect(response.headers.get('retry-after')).toBe('5');
  });
});
