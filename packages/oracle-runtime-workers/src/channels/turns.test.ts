import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChannelTurnsTestDO } from './test-do';
import {
  CHANNEL_DELEGATION_MIN_REMAINING_SECONDS,
  type ChannelTurnInput,
} from './contract';
import type { ReplyPlan } from '../delivery/types';
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

const delegationRequired = {
  ok: false,
  status: 428,
  code: 'delegation_required',
  message:
    'Companion delegation required: the user must authorize this oracle again',
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

  it('returns a finished chat run as its Reply Plan, with the whole reply as text', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('reply-plan');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    expect(first.result).not.toHaveProperty('plan');
    const plan: ReplyPlan = {
      v: 1,
      parts: [
        { partId: 'p1', kind: 'text', text: 'Here is the week.' },
        {
          partId: 'p2',
          kind: 'artifact',
          artifact: {
            artifactId: 'a'.repeat(32),
            title: 'Week plan',
            url: `https://oracle.test/a/${'a'.repeat(32)}#k=key`,
            mime: 'text/markdown',
            bytes: 120,
            expiresAt: '2026-10-25T09:00:00.000Z',
          },
        },
        { partId: 'p3', kind: 'text', text: 'Want me to book the slots?' },
      ],
    };
    await stub.finish(first.result.runId, plan);
    expect(await stub.submit(message)).toEqual({
      ok: true,
      result: {
        ...first.result,
        status: 'finished',
        text: `Here is the week.\n\n[Week plan](https://oracle.test/a/${'a'.repeat(32)}#k=key)\n\nWant me to book the slots?`,
        messageId: 'message-1',
        plan,
      },
    });
  });

  it('erases expired response payloads without permitting a replay after reset', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('expired-response');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId, {
      v: 1,
      parts: [{ partId: 'p1', kind: 'text', text: 'One answer' }],
    });
    await stub.expire(RUN_RETENTION_MS - 1);
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
    await stub.expire(2);
    const pruned = {
      turn_runs: 0,
      turn_tool_marks: 0,
      turn_run_segments: 0,
      turn_run_plans: 0,
      channel_run_tombstones: 1,
      channel_requests: 0,
    };
    expect(await stub.retained()).toEqual(pruned);
    await stub.reset().catch(() => undefined);
    const recovered = env.CHANNEL_TURNS_TEST.getByName('expired-response');
    const expired = {
      ok: false,
      status: 410,
      code: 'response_expired',
      message:
        'Channel response has expired; this request cannot execute again',
    };
    expect(await recovered.submit(message)).toEqual(expired);
    // The receipt (and its body hash) is gone with the run: a changed body
    // is refused by the tombstone too, and neither refusal writes a receipt.
    expect(
      await recovered.submit({ ...message, message: 'Replacement' }),
    ).toEqual(expired);
    expect(await recovered.retained()).toEqual(pruned);
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
      code: 'request_conflict',
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
      code: 'session_not_found',
      message: 'Session not owned',
    });
    expect(await stub.count()).toBe(0);
  });

  it('mirrors the reply once: the run end delivers it and later polls do not resend', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('reply-once');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId);
    await stub.deliverReply(first.result.runId);
    await stub.submit(message);
    await stub.reopen();
    await stub.submit(message);
    expect(await stub.mirrors()).toEqual({ user: 1, oracle: 1 });
  });

  it("mirrors a chat run's Reply Plan once, as the channel user received it, and keeps the model's text in the run", async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('reply-plan-once');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const plan: ReplyPlan = {
      v: 1,
      parts: [
        { partId: 'p1', kind: 'text', text: 'Short answer.' },
        { partId: 'p2', kind: 'text', text: 'Want more?' },
      ],
    };
    await stub.finish(first.result.runId, plan, '## Answer\n\nShort answer.');
    await stub.deliverReply(first.result.runId);
    expect(await stub.mirroredReply()).toBe('Short answer.\n\nWant more?');
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { text: 'Short answer.\n\nWant more?', plan },
    });
    await stub.reopen();
    await stub.submit(message);
    expect(await stub.mirrors()).toEqual({ user: 1, oracle: 1 });
    expect((await stub.run(first.result.runId))?.partialText).toBe(
      '## Answer\n\nShort answer.',
    );
  });

  it('delivers the reply on the first poll when the run end did not, then never again', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('reply-on-poll');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId);
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
    await stub.submit(message);
    await stub.deliverReply(first.result.runId);
    expect(await stub.mirrors()).toEqual({ user: 1, oracle: 1 });
  });

  it('opens a new session for the binding after its session was deleted', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('deleted-session');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    expect(await stub.deleteSession(first.result.sessionId)).toBe(true);
    const next = await stub.submit({ ...message, requestId: 'wa:two' });
    if (!next.ok) throw new Error(`Turn rejected: ${next.message}`);
    expect(next.result.sessionId).not.toBe(first.result.sessionId);
    const third = await stub.submit({ ...message, requestId: 'wa:three' });
    if (!third.ok) throw new Error('Turn rejected');
    expect(third.result.sessionId).toBe(next.result.sessionId);
    expect(await stub.deleteSession('$unrelated')).toBe(false);
  });

  it('refuses a new turn without a stored delegation but still answers an admitted one', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('no-delegation');
    const admitted = await stub.submit(message);
    if (!admitted.ok) throw new Error('Turn rejected');
    await stub.finish(admitted.result.runId);
    await stub.revokeDelegation();
    expect(await stub.submit({ ...message, requestId: 'wa:two' })).toEqual(
      delegationRequired,
    );
    expect(await stub.count()).toBe(1);
    expect((await stub.mirrors()).user).toBe(1);
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
  });

  it.each([
    { name: 'expired', left: -60 },
    {
      name: 'exactly at the margin',
      left: CHANNEL_DELEGATION_MIN_REMAINING_SECONDS,
    },
    {
      name: 'inside the margin',
      left: CHANNEL_DELEGATION_MIN_REMAINING_SECONDS - 1,
    },
  ])(
    'refuses a new turn under a delegation $name (428 delegation_required)',
    async ({ name, left }) => {
      const stub = env.CHANNEL_TURNS_TEST.getByName(`delegation-${name}`);
      await stub.setDelegation({
        raw: 'grant',
        expiration: Math.floor(Date.now() / 1000) + left,
      });
      expect(await stub.submit(message)).toEqual(delegationRequired);
      expect(await stub.count()).toBe(0);
      expect((await stub.mirrors()).user).toBe(0);
    },
  );

  it('refuses a delegation whose expiry is unknown', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('delegation-no-expiry');
    await stub.setDelegation({ raw: 'grant' });
    expect(await stub.submit(message)).toEqual(delegationRequired);
    expect(await stub.count()).toBe(0);
  });

  it('admits a turn under a delegation with more than the margin left', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('delegation-valid');
    await stub.setDelegation({
      raw: 'grant',
      expiration:
        Math.floor(Date.now() / 1000) +
        CHANNEL_DELEGATION_MIN_REMAINING_SECONDS +
        60,
    });
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'running' },
    });
    expect(await stub.count()).toBe(1);
  });

  it('refuses a second session for a bound channel (409 session_conflict)', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('session-conflict');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    expect(
      await stub.submit({
        ...message,
        requestId: 'wa:two',
        sessionId: '$channel-session-other',
      }),
    ).toEqual({
      ok: false,
      status: 409,
      code: 'session_conflict',
      message: 'This channel already has another session',
    });
    expect(await stub.count()).toBe(1);
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

describe('channel polls', () => {
  it('a poll of an admitted request writes nothing and checks the session only when it was bound', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('poll-costs');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    // Admission: the receipt, then the session binding.
    expect(await stub.hostCalls()).toEqual({ assertSession: 1, changed: 2 });
    for (let i = 0; i < 5; i += 1)
      expect(await stub.submit(message)).toEqual(first);
    expect(await stub.hostCalls()).toEqual({ assertSession: 1, changed: 2 });
    // A second request is bound to the binding's session (its receipt
    // and the binding row are written) and checked once.
    const second = await stub.submit({ ...message, requestId: 'wa:two' });
    if (!second.ok) throw new Error('Turn rejected');
    expect(second.result.sessionId).toBe(first.result.sessionId);
    expect(await stub.hostCalls()).toEqual({ assertSession: 2, changed: 4 });
    await stub.submit({ ...message, requestId: 'wa:two' });
    expect(await stub.hostCalls()).toEqual({ assertSession: 2, changed: 4 });
  });

  it('a request on a deleted session is still refused before it runs', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('poll-deleted-session');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.deleteSession(first.result.sessionId);
    // An explicit session the binding no longer holds, now deleted.
    expect(
      await stub.submit({
        ...message,
        requestId: 'wa:late',
        sessionId: first.result.sessionId,
      }),
    ).toEqual({
      ok: false,
      status: 404,
      code: 'session_not_found',
      message: 'Session deleted',
    });
    expect(await stub.count()).toBe(1);
  });

  it('admits concurrent different requests of one binding into one session, one run each', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('concurrent-requests');
    const results = await Promise.all(
      ['wa:a', 'wa:b', 'wa:c'].map((requestId) =>
        stub.submit({ ...message, requestId }),
      ),
    );
    const ok = results.map((r) => {
      if (!r.ok) throw new Error('Turn rejected');
      return r.result;
    });
    expect(new Set(ok.map((r) => r.sessionId)).size).toBe(1);
    expect(new Set(ok.map((r) => r.runId)).size).toBe(3);
    expect(await stub.count()).toBe(3);
  });
});
