/**
 * `POST /channels/media` across the Durable Object boundary, in workerd: the
 * room copy found in the real link store (DO SQLite), the plaintext handed
 * over RPC as a byte stream read on demand, one read per object, and a
 * caller that cancels the body freeing the object's slot.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChannelMediaTestDO } from './test-do';
import type { ChannelMediaQuery } from './media';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Workers test binding augmentation.
  namespace Cloudflare {
    interface Env {
      CHANNEL_MEDIA_TEST: DurableObjectNamespace<ChannelMediaTestDO>;
    }
  }
}

const SESSION = '$thread-1';
const REF = 'channel:0123456789abcdef';
const BINDING = 'chb_web';
const query: ChannelMediaQuery = { kind: 'file', sessionId: SESSION, ref: REF };

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function seeded(name: string, size: number, withMedia = true) {
  const stub = env.CHANNEL_MEDIA_TEST.getByName(name);
  const sha256 = await stub.storeFile(size);
  await stub.seed({
    sessionId: SESSION,
    ref: REF,
    bindingId: BINDING,
    sha256,
    eventId: '$event',
    withMedia,
  });
  return stub;
}

describe('channel media across RPC', () => {
  it('keeps the room copy of a file per session and binding, only once its event is recorded', async () => {
    const stub = env.CHANNEL_MEDIA_TEST.getByName('room-copy');
    const sha256 = 'ab'.repeat(32);
    await stub.seed({
      sessionId: SESSION,
      ref: REF,
      bindingId: BINDING,
      sha256,
    });
    expect(await stub.roomCopy(SESSION, REF, BINDING)).toBeUndefined();
    await stub.seed({
      sessionId: SESSION,
      ref: REF,
      bindingId: BINDING,
      sha256,
      eventId: '$event',
    });
    expect(await stub.roomCopy(SESSION, REF, BINDING)).toEqual({
      eventId: '$event',
      sha256,
    });
    // Posted now: the row keeps the event's media info, deleted with it.
    await stub.storeFile(100);
    await stub.seed({
      sessionId: SESSION,
      ref: REF,
      bindingId: BINDING,
      sha256,
      eventId: '$event',
      withMedia: true,
    });
    expect(await stub.roomCopy(SESSION, REF, BINDING)).toMatchObject({
      eventId: '$event',
      media: {
        mxc: 'mxc://hs.test/media1',
        size: 100,
        file: { v: 'v2', key: { alg: 'A256CTR' } },
      },
    });
    expect(await stub.roomCopy(SESSION, REF, 'chb_other')).toBeUndefined();
    expect(await stub.roomCopy('$other', REF, BINDING)).toBeUndefined();
    await stub.forgetSession(SESSION);
    expect(await stub.roomCopy(SESSION, REF, BINDING)).toBeUndefined();
  });

  it('streams the plaintext to the caller, reading the homeserver only as the caller reads', async () => {
    const stub = await seeded('stream', 200_000);
    const outcome = await stub.read(query, BINDING, SESSION);
    if (!outcome.ok || outcome.kind !== 'file') throw new Error('no file');
    expect(outcome).toMatchObject({
      size: 200_000,
      mime: 'application/pdf',
      name: 'cv.pdf',
    });
    const reader = outcome.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 49 upstream chunks in all; a reader that took one has not drained it.
    expect((await stub.state()).pulls).toBeLessThan(30);
    let total = first.value?.byteLength ?? 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(200_000);
    await until(async () => !(await stub.state()).busy);
    // The row keeps the event's media info: the gateway object is not asked.
    expect((await stub.state()).eventMediaInfoCalls).toBe(0);
  });

  it('asks the gateway object exactly once for a row written before media info was kept, or one it cannot read', async () => {
    const legacy = await seeded('legacy-row', 10_000, false);
    const first = await legacy.read(query, BINDING, SESSION);
    if (!first.ok || first.kind !== 'file') throw new Error('no file');
    expect(
      new Uint8Array(await new Response(first.body).arrayBuffer()).byteLength,
    ).toBe(10_000);
    expect((await legacy.state()).eventMediaInfoCalls).toBe(1);

    const corrupt = await seeded('corrupt-row', 10_000, true);
    await corrupt.corruptMedia(SESSION, REF);
    const second = await corrupt.read(query, BINDING, SESSION);
    if (!second.ok || second.kind !== 'file') throw new Error('no file');
    await new Response(second.body).arrayBuffer();
    expect((await corrupt.state()).eventMediaInfoCalls).toBe(1);
  });

  it('refuses a second read while one is in flight, and frees the slot when the caller cancels', async () => {
    const stub = await seeded('busy', 200_000);
    const first = await stub.read(query, BINDING, SESSION);
    if (!first.ok || first.kind !== 'file') throw new Error('no file');
    const reader = first.body.getReader();
    await reader.read();
    expect(await stub.read(query, BINDING, SESSION)).toEqual({
      ok: false,
      status: 429,
      error: 'busy',
      retryAfter: 2,
    });
    await reader.cancel();
    await until(async () => !(await stub.state()).busy);
    expect((await stub.state()).cancelled).toBe(true);
    const next = await stub.read(query, BINDING, SESSION);
    expect(next.ok).toBe(true);
    if (next.ok && next.kind === 'file') await next.body.cancel();
  });

  it('answers 404 for another binding, an unowned session or an unknown reference', async () => {
    const stub = await seeded('not-found', 1000);
    for (const [q, binding, owned] of [
      [query, 'chb_other', SESSION],
      [query, BINDING, '$other'],
      [{ ...query, ref: 'channel:fedcba9876543210' }, BINDING, SESSION],
    ] as const)
      expect(await stub.read(q, binding, owned)).toEqual({
        ok: false,
        status: 404,
        error: 'not_found',
      });
    expect((await stub.state()).busy).toBe(false);
  });
});
