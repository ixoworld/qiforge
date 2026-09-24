import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChannelTurnsTestDO } from './test-do';
import type { ChannelTurnInput } from './contract';
import { RUN_RETENTION_MS } from '../do/run-store';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Workers test binding augmentation.
  namespace Cloudflare {
    interface Env {
      CHANNEL_TURNS_TEST: DurableObjectNamespace<ChannelTurnsTestDO>;
    }
  }
}

const message: ChannelTurnInput = {
  provider: 'whatsapp',
  bindingId: 'chb_one',
  bindingRevision: 1,
  requestId: 'wa:one',
  remoteMessageRef: `hmac:${'a'.repeat(64)}`,
  message: 'Help me plan',
  context: { kind: 'companion' },
};

describe('durable channel requests', () => {
  it('admits simultaneous copies once and returns the stored answer after reopening SQLite', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('duplicates');
    const [first, duplicate] = await Promise.all([
      stub.submit(message),
      stub.submit(message),
    ]);
    if (!first.ok || !duplicate.ok) throw new Error('Turn rejected');
    expect(first.result.runId).toBe(duplicate.result.runId);
    expect(await stub.count()).toBe(1);
    await stub.finish(first.result.runId);
    await stub.reopen();
    expect(await stub.submit(message)).toEqual({
      ok: true,
      result: {
        ...first.result,
        status: 'finished',
        text: 'One answer',
        messageId: 'message-1',
      },
    });
    expect(await stub.count()).toBe(1);
  });

  it('keeps the same live run after reopening without a reply', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('running-reset');
    const first = await stub.submit(message);
    await stub.reopen();
    expect(await stub.submit(message)).toEqual(first);
    expect(await stub.count()).toBe(1);
  });

  it('erases expired response payloads without permitting a replay after reset', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('expired-response');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId);
    await stub.expire(RUN_RETENTION_MS - 1);
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
    await stub.expire(2);
    expect(await stub.retained()).toEqual({
      turn_runs: 0,
      turn_tool_marks: 0,
      turn_run_segments: 0,
      channel_run_tombstones: 1,
    });
    await stub.reset().catch(() => undefined);
    const recovered = env.CHANNEL_TURNS_TEST.getByName('expired-response');
    expect(await recovered.submit(message)).toEqual({
      ok: false,
      status: 410,
      message:
        'Channel response has expired; this request cannot execute again',
    });
    expect(
      await recovered.submit({ ...message, message: 'Replacement' }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await recovered.count()).toBe(1);
  });

  it('rejects a changed payload for the same binding and request ID', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('conflict');
    await stub.submit(message);
    await expect(
      stub.submit({ ...message, message: 'A replacement instruction' }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      message: 'This request ID already belongs to another message',
    });
    expect(await stub.count()).toBe(1);
  });

  it('reuses the channel session for later messages and separates bindings', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('sessions');
    const first = await stub.submit(message);
    const next = await stub.submit({ ...message, requestId: 'wa:two' });
    const other = await stub.submit({ ...message, bindingId: 'chb_other' });
    if (!first.ok || !next.ok || !other.ok) throw new Error('Turn rejected');
    expect(next.result.sessionId).toBe(first.result.sessionId);
    expect(next.result.runId).not.toBe(first.result.runId);
    expect(other.result.runId).not.toBe(first.result.runId);
    expect(other.result.sessionId).not.toBe(first.result.sessionId);
  });

  it('rejects a session that the user does not own', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('session-ownership');
    await expect(
      stub.submit({ ...message, sessionId: '$victim-session' }),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      message: 'Session not owned',
    });
    expect(await stub.count()).toBe(0);
  });
});

it('does not execute again when the object is aborted immediately after admission', async () => {
  const firstStub = env.CHANNEL_TURNS_TEST.getByName('forced-reset');
  const admitted = await firstStub.submit(message);
  await firstStub.reset().catch(() => undefined);
  const recovered = env.CHANNEL_TURNS_TEST.getByName('forced-reset');
  expect(await recovered.submit(message)).toEqual(admitted);
  expect(await recovered.count()).toBe(1);
});
