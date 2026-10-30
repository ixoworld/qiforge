import { describe, expect, it } from 'vitest';
import {
  channelArchiveName,
  channelAttachmentRef,
  ChannelFileUnavailableError,
  channelMediaOrigins,
  createChannelMediaSource,
  downloadChannelFile,
  isGatewayMediaUrl,
  type ChannelMediaLink,
} from './channel';
import { MAX_FILE_SIZE, type MatrixMediaSource } from './download';
import type { ExtractionProvider } from './extract';
import { prepareAttachments } from './pipeline';
import type { AttachmentInput } from './types';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const LOGGER = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const NO_CAPS = { image: false, file: false, audio: false, video: false };
const ALL_CAPS = { image: true, file: true, audio: false, video: false };
const PROVIDER: ExtractionProvider = {
  baseURL: 'https://llm.test/api/v1',
  apiKey: 'k',
  headers: {},
  model: 'vision/model',
};
const ORIGINS = channelMediaOrigins(['did:web:channels.test']);
const NO_MATRIX: MatrixMediaSource = {
  downloadMxc: async () => {
    throw new Error('not a Matrix file');
  },
  downloadEvent: async () => null,
};

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}

function gatewayLink(bindingId = 'chb_one'): string {
  return `https://channels.test/media/${bindingId}/1f0e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?exp=1893456000&sig=c2lnbmF0dXJl`;
}

/** A fetch that answers the gateway link with `bytes` and records every URL. */
function gatewayFetch(
  answer: (url: string) => Response,
): typeof fetch & { urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    urls.push(url);
    if (typeof init?.body === 'string') bodies.push(init.body);
    return answer(url);
  }) as typeof fetch;
  return Object.assign(impl, { urls, bodies });
}

async function channelFile(
  bytes: Uint8Array,
  filename: string,
  mimetype: string,
): Promise<{
  input: AttachmentInput;
  link: ChannelMediaLink & { ref: string };
}> {
  const digest = await sha256(bytes);
  const ref = channelAttachmentRef(digest);
  return {
    input: { channelRef: ref, filename, mimetype, size: bytes.length },
    link: { ref, url: gatewayLink(), sha256: digest, bindingId: 'chb_one' },
  };
}

function sourceOf(links: ReadonlyArray<ChannelMediaLink & { ref: string }>) {
  return createChannelMediaSource({
    origins: ORIGINS,
    resolve: async (ref) => links.find((link) => link.ref === ref),
  });
}

describe('channel file links', () => {
  it('takes only the gateway host of a did:web service DID, under the file binding', () => {
    expect(
      channelMediaOrigins([
        'did:web:channels.test',
        'did:key:z6Mkexample',
        'did:web:channels.test',
      ]),
    ).toEqual(['https://channels.test']);
    const ok = { url: gatewayLink(), bindingId: 'chb_one' };
    expect(isGatewayMediaUrl(ok, ORIGINS)).toBe(true);
    for (const url of [
      gatewayLink().replace('https://', 'http://'),
      gatewayLink().replace('channels.test', 'evil.test'),
      gatewayLink('chb_other'),
      'https://channels.test/media/chb_one/a/b?exp=1&sig=x',
      'https://channels.test/media/chb_one/?exp=1&sig=x',
      'https://user:pw@channels.test/media/chb_one/x?exp=1&sig=x',
      'https://channels.test/other/chb_one/x',
      'not a url',
    ])
      expect(isGatewayMediaUrl({ url, bindingId: 'chb_one' }, ORIGINS)).toBe(
        false,
      );
  });

  it('keeps bytes only when their digest is the one the gateway sent, and never names the link in an error', async () => {
    const digest = await sha256(JPEG);
    const link = { url: gatewayLink(), sha256: digest, bindingId: 'chb_one' };
    const served = gatewayFetch(() => new Response(JPEG));
    expect(
      (
        await downloadChannelFile(link, {
          origins: ORIGINS,
          maxBytes: 1000,
          fetchImpl: served,
        })
      ).bytes,
    ).toEqual(JPEG);
    const errors: unknown[] = [];
    for (const [answer, words] of [
      [
        () => new Response(new Uint8Array([9, 9, 9])),
        'do not match the digest',
      ],
      [() => new Response('gone', { status: 404 }), 'answered 404'],
      [
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://channels.test/media/chb_one/z' },
          }),
        'could not be reached',
      ],
    ] as const) {
      const fetchImpl = gatewayFetch(answer);
      const error = await downloadChannelFile(link, {
        origins: ORIGINS,
        maxBytes: 1000,
        fetchImpl,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChannelFileUnavailableError);
      expect(String(error)).toContain(words);
      // One request: a redirect is never followed.
      expect(fetchImpl.urls).toHaveLength(1);
      errors.push(error);
    }
    const offHost = gatewayFetch(() => new Response(JPEG));
    errors.push(
      await downloadChannelFile(
        { ...link, url: gatewayLink().replace('channels.test', 'evil.test') },
        { origins: ORIGINS, maxBytes: 1000, fetchImpl: offHost },
      ).catch((e: unknown) => e),
    );
    expect(offHost.urls).toEqual([]);
    expect(JSON.stringify(errors.map(String))).not.toMatch(/sig=|media\//);
  });

  it('names a channel archive with its digest so files called alike do not collide', () => {
    const ref = channelAttachmentRef('0123456789abcdef'.repeat(4));
    expect(channelArchiveName('photo.jpg', ref)).toBe('photo-0123456789ab.jpg');
    expect(channelArchiveName('notes', ref)).toBe('notes-0123456789ab');
  });
});

describe('channel files in the attachment pipeline', () => {
  it('sends a photo natively as its bytes and shows the model only its reference', async () => {
    const { input, link } = await channelFile(JPEG, 'photo.jpg', 'image/jpeg');
    const fetchImpl = gatewayFetch(() => new Response(JPEG));
    const out = await prepareAttachments(
      { text: '[photo]', attachments: [input], model: 'm', caps: ALL_CAPS },
      {
        source: NO_MATRIX,
        channel: sourceOf([link]),
        extraction: PROVIDER,
        sandbox: null,
        fetchImpl,
        logger: LOGGER,
      },
    );
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.nativeNotes.map((n) => n.text)).toEqual([
      `[source: ref="${link.ref}"] "photo.jpg" (image/jpeg) is attached to this message.`,
    ]);
    expect(out.metas).toEqual([
      {
        filename: 'photo.jpg',
        mimetype: 'image/jpeg',
        size: JPEG.length,
        channelRef: link.ref,
        category: 'image',
      },
    ]);
    // Model content, hidden notes and stored metadata: no link anywhere.
    const seen = JSON.stringify(out);
    expect(seen).not.toContain('channels.test');
    expect(seen).not.toContain('sig=');
    expect(fetchImpl.urls).toEqual([link.url]);
  });

  it('describes a photo through the helper model from its bytes, never its URL, and archives it under a unique name', async () => {
    const { input, link } = await channelFile(JPEG, 'photo.jpg', 'image/jpeg');
    const uploads: string[] = [];
    const fetchImpl = gatewayFetch((url) => {
      if (url.endsWith('/chat/completions'))
        return Response.json({
          choices: [{ message: { content: 'A shop front.' } }],
        });
      if (url.endsWith('/artifacts/upload')) {
        const path = `/workspace/output/stored-${uploads.length}`;
        uploads.push(path);
        return Response.json({ path });
      }
      return new Response(JPEG);
    });
    const recorded: unknown[] = [];
    const recording = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.body instanceof FormData) recorded.push(init.body.get('path'));
      return fetchImpl(input, init);
    }) as typeof fetch;
    const out = await prepareAttachments(
      { text: '[photo]', attachments: [input], model: 'm', caps: NO_CAPS },
      {
        source: NO_MATRIX,
        channel: sourceOf([link]),
        extraction: PROVIDER,
        sandbox: { sandboxMcpUrl: 'https://sb.test/mcp', authHeaders: {} },
        fetchImpl: recording,
        logger: LOGGER,
      },
    );
    const text = out.extracted[0]?.text ?? '';
    expect(text).toContain('[Description of photo.jpg]:\nA shop front.');
    // The paths the sandbox answered with, not the ones asked for.
    expect(text).toContain('/workspace/output/stored-0');
    expect(text).toContain('/workspace/output/stored-1');
    expect(recorded[0]).toBe(
      `/workspace/output/photo-${link.ref.slice('channel:'.length, 'channel:'.length + 12)}.jpg`,
    );
    // The helper model got a data URI, not the gateway link.
    expect(fetchImpl.bodies).toHaveLength(1);
    expect(fetchImpl.bodies[0]).toContain('data:image/jpeg;base64,');
    expect(fetchImpl.bodies[0]).not.toContain('channels.test');
    expect(JSON.stringify(out)).not.toContain('channels.test');
  });

  it('notes a file the gateway no longer serves, without its link, and the turn goes on', async () => {
    const { input, link } = await channelFile(JPEG, 'photo.jpg', 'image/jpeg');
    const fetchImpl = gatewayFetch(() => new Response('gone', { status: 404 }));
    const out = await prepareAttachments(
      { text: 'here it is', attachments: [input], model: 'm', caps: ALL_CAPS },
      {
        source: NO_MATRIX,
        channel: sourceOf([link]),
        extraction: PROVIDER,
        sandbox: null,
        fetchImpl,
        logger: LOGGER,
      },
    );
    expect(out.content).toBe('here it is');
    expect(out.extracted.map((e) => e.text)).toEqual([
      `[source: ref="${link.ref}"]\n[File "photo.jpg" (image/jpeg) could not be downloaded: the channel gateway answered 404]`,
    ]);
    // Refused once, not downloaded again by the extract lane.
    expect(fetchImpl.urls).toEqual([link.url]);
    expect(JSON.stringify(out)).not.toContain('channels.test');
    // A reference the owner object does not know is noted the same way.
    const unknown = await prepareAttachments(
      { text: 'x', attachments: [input], model: 'm', caps: ALL_CAPS },
      {
        source: NO_MATRIX,
        channel: sourceOf([]),
        extraction: PROVIDER,
        sandbox: null,
        fetchImpl,
        logger: LOGGER,
      },
    );
    expect(unknown.extracted[0]?.text).toContain(
      'could not be downloaded: it is no longer available here',
    );
  });

  it('keeps whole characters of a long multi-byte name in the notes, and strips its quotes', async () => {
    const name = `${'\u{1f4f7}'.repeat(150)}".pdf`;
    const { input, link } = await channelFile(
      new TextEncoder().encode('%PDF-1.4 x'),
      name,
      'application/pdf',
    );
    const fetchImpl = gatewayFetch(
      () => new Response(new TextEncoder().encode('%PDF-1.4 x')),
    );
    const out = await prepareAttachments(
      { text: '[document]', attachments: [input], model: 'm', caps: ALL_CAPS },
      {
        source: NO_MATRIX,
        channel: sourceOf([link]),
        extraction: PROVIDER,
        sandbox: null,
        fetchImpl,
        logger: LOGGER,
      },
    );
    const note = out.nativeNotes[0]?.text ?? '';
    const quoted = /"([^"]*)" \(application\/pdf\)/.exec(note)?.[1] ?? '';
    expect(quoted.length).toBeLessThanOrEqual(255);
    // No lone surrogate: every code unit pairs up.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(quoted)).toBe(false);
    expect(quoted).not.toContain('"');
    expect(quoted.startsWith('\u{1f4f7}')).toBe(true);
  });

  it('archives a document larger than any model is handed here, and only notes it', async () => {
    const big = new Uint8Array(MAX_FILE_SIZE + 1024).fill(0x61);
    big.set(new TextEncoder().encode('%PDF-1.4 '));
    const { input, link } = await channelFile(
      big,
      'manual.pdf',
      'application/pdf',
    );
    const fetchImpl = gatewayFetch((url) =>
      url.endsWith('/artifacts/upload')
        ? Response.json({ path: '/workspace/output/manual.pdf' })
        : new Response(big),
    );
    const out = await prepareAttachments(
      {
        text: '[document: manual.pdf]',
        attachments: [input],
        model: 'm',
        caps: ALL_CAPS,
      },
      {
        source: NO_MATRIX,
        channel: sourceOf([link]),
        extraction: PROVIDER,
        sandbox: { sandboxMcpUrl: 'https://sb.test/mcp', authHeaders: {} },
        fetchImpl,
        logger: LOGGER,
      },
    );
    expect(out.content).toBe('[document: manual.pdf]');
    expect(out.extracted[0]?.text).toContain(
      'is larger than the 25 MB a model reads here, so its content was not read',
    );
    expect(out.extracted[0]?.text).toContain('/workspace/output/manual.pdf');
    expect(fetchImpl.urls.some((u) => u.endsWith('/chat/completions'))).toBe(
      false,
    );
  });
});
