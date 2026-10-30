/**
 * A turn's attachments in the owner object: what a channel turn reads, how a
 * `channel:` reference resolves (the turn's files, then the session's kept
 * links in SQLite), and a resumed attempt that downloads nothing.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
  ChannelAttachmentLinkStore,
  channelAttachmentRef,
  type PreparedAttachments,
} from '../attachments';
import { ChannelAttachment } from '../channels/contract';
import { DoSqliteDatabase } from '../sqlite/database';
import {
  channelTurnLinks,
  prepareTurnAttachments,
  turnAttachmentInputs,
  turnChannelMediaSource,
} from './turn-attachments';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}

function link(bindingId: string, exp = 1893456000): string {
  return `https://channels.test/media/${bindingId}/1f0e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?exp=${exp}&kid=k1&sig=c2ln`;
}

async function photo(bindingId = 'chb_one') {
  return ChannelAttachment.parse({
    url: link(bindingId),
    filename: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: JPEG.length,
    sha256: await sha256(JPEG),
    kind: 'image',
  });
}

describe('turn attachments', () => {
  it('reads a channel turn by reference only, and never takes a reference from a body', async () => {
    const file = await photo();
    const req = {
      client: 'channel',
      channel: { bindingId: 'chb_one', attachments: [file] },
    };
    const inputs = turnAttachmentInputs(req, undefined);
    expect(inputs).toEqual([
      {
        channelRef: channelAttachmentRef(file.sha256),
        filename: 'photo.jpg',
        mimetype: 'image/jpeg',
        size: JPEG.length,
      },
    ]);
    expect(JSON.stringify(inputs)).not.toContain('channels.test');
    expect(channelTurnLinks(req)).toEqual([
      {
        ref: channelAttachmentRef(file.sha256),
        url: file.url,
        sha256: file.sha256,
        bindingId: 'chb_one',
      },
    ]);
    // A Portal body naming a channel reference names nothing it can read.
    expect(() =>
      turnAttachmentInputs({ client: 'portal' }, [
        {
          channelRef: 'channel:0123456789abcdef',
          filename: 'x',
          mimetype: 'image/png',
        },
      ]),
    ).toThrow('either mxcUri or eventId must be provided');
    expect(channelTurnLinks({ client: 'portal' })).toEqual([]);
  });

  it('downloads nothing again on a resumed attempt, and still knows the files', async () => {
    const file = await photo();
    const inputs = turnAttachmentInputs(
      {
        client: 'channel',
        channel: { bindingId: 'chb_one', attachments: [file] },
      },
      undefined,
    );
    const prepare = vi.fn(
      async (): Promise<PreparedAttachments> => ({
        content: 'x',
        metas: [],
        extracted: [],
        nativeNotes: [],
        usage: { cost: 0, promptTokens: 0, completionTokens: 0 },
      }),
    );
    const resumed = await prepareTurnAttachments({
      inputs,
      resumed: true,
      prepare,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(resumed).toEqual({
      prepared: null,
      metas: [
        {
          filename: 'photo.jpg',
          mimetype: 'image/jpeg',
          size: JPEG.length,
          channelRef: channelAttachmentRef(file.sha256),
          category: 'image',
        },
      ],
    });
    await prepareTurnAttachments({ inputs, resumed: false, prepare });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(
      await prepareTurnAttachments({ inputs: [], resumed: false, prepare }),
    ).toEqual({ prepared: null, metas: [] });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('resolves a reference from the turn, then from the links kept for the session, until they expire', async () => {
    const stub = env.TASKS_TEST.get(env.TASKS_TEST.idFromName('channel-links'));
    await runInDurableObject(stub, async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'channel-links-test.db');
      let now = 1_800_000_000_000;
      const store = new ChannelAttachmentLinkStore(db, console, () => now);
      const file = await photo();
      const [kept] = channelTurnLinks({
        client: 'channel',
        channel: { bindingId: 'chb_one', attachments: [file] },
      });
      await store.put('session-a', [kept!]);
      const fetched: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        fetched.push(String(input));
        return new Response(JPEG);
      }) as typeof fetch;
      // A later turn of the same session: the file is not in its own list.
      const later = turnChannelMediaSource({
        sessionId: 'session-a',
        turnLinks: [],
        store,
        channelServiceDid: 'did:web:channels.test',
      });
      expect(
        (await later.load(kept!.ref, { maxBytes: 1000, fetchImpl })).bytes,
      ).toEqual(JPEG);
      expect(fetched).toEqual([file.url]);
      // Another session never resolves it.
      const other = turnChannelMediaSource({
        sessionId: 'session-b',
        turnLinks: [],
        store,
        channelServiceDid: 'did:web:channels.test',
      });
      await expect(
        other.load(kept!.ref, { maxBytes: 1000, fetchImpl }),
      ).rejects.toThrow('no longer available here');
      // A gateway that is not this deployment's is never fetched from.
      const elsewhere = turnChannelMediaSource({
        sessionId: 'session-a',
        turnLinks: [],
        store,
        channelServiceDid: 'did:web:other.test',
      });
      await expect(
        elsewhere.load(kept!.ref, { maxBytes: 1000, fetchImpl }),
      ).rejects.toThrow('not one this channel gateway serves');
      expect(fetched).toHaveLength(1);
      // The link's own expiry ends it; a deleted session takes it along.
      now = 1893456000 * 1000 + 1;
      expect(await store.get('session-a', kept!.ref)).toBeUndefined();
      now = 1_800_000_000_000;
      expect(await store.get('session-a', kept!.ref)).toEqual({
        url: file.url,
        sha256: file.sha256,
        bindingId: 'chb_one',
      });
      await store.forgetSession('session-a');
      expect(await store.get('session-a', kept!.ref)).toBeUndefined();
    });
  });
});
