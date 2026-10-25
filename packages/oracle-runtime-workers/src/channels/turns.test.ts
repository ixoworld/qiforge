import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChannelTurnsTestDO } from './test-do';
import {
  CHANNEL_DELEGATION_MIN_REMAINING_SECONDS,
  type ChannelTurnInput,
  type ChannelControlInput,
} from './contract';
import type { ReplyPlan } from '../delivery/types';
import { RUN_RETENTION_MS } from '../do/run-store';
import { CHANNEL_RECORD_RETENTION_MS } from './turns';

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
  message: 'Delegation required: the user must authorize this oracle again',
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
    await stub.deliverReply();
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
    await stub.deliverReply();
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
    await stub.deliverReply();
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
    await stub.settle();
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
    await stub.settle();
    // Admission: the receipt, the session binding with the owed mirror;
    // then, in the background, the user message mirrored.
    const admitted = { assertSession: 1, changed: 3, createSession: 1 };
    expect(await stub.hostCalls()).toEqual(admitted);
    for (let i = 0; i < 5; i += 1)
      expect(await stub.submit(message)).toEqual(first);
    await stub.settle();
    expect(await stub.hostCalls()).toEqual(admitted);
    // A second request is bound to the binding's session (its receipt
    // and the binding row are written) and checked once.
    const second = await stub.submit({ ...message, requestId: 'wa:two' });
    if (!second.ok) throw new Error('Turn rejected');
    expect(second.result.sessionId).toBe(first.result.sessionId);
    await stub.settle();
    const twice = { assertSession: 2, changed: 6, createSession: 1 };
    expect(await stub.hostCalls()).toEqual(twice);
    await stub.submit({ ...message, requestId: 'wa:two' });
    await stub.settle();
    expect(await stub.hostCalls()).toEqual(twice);
  });

  it('answers a poll of an existing run without the admission path, and nothing else', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('poll-path');
    expect(await stub.poll(message)).toBeNull();
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.settle();
    const calls = await stub.hostCalls();
    expect(await stub.poll(message)).toEqual(first);
    // Another body under the same request id is left to admission (409).
    expect(await stub.poll({ ...message, message: 'Changed' })).toBeNull();
    expect(await stub.poll({ ...message, requestId: 'wa:none' })).toBeNull();
    expect(await stub.hostCalls()).toEqual(calls);
    await stub.finish(first.result.runId);
    expect(await stub.poll(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
  });

  it('a request naming a deleted session drops its receipt and answers 409 session_conflict; resent without sessionId it opens a new session', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('poll-deleted-session');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.deleteSession(first.result.sessionId);
    // The gateway still names the session it was given last.
    const late = {
      ...message,
      requestId: 'wa:late',
      sessionId: first.result.sessionId,
    };
    expect(await stub.submit(late)).toEqual({
      ok: false,
      status: 409,
      code: 'session_conflict',
      message:
        'The oracle session of this channel no longer exists; send the request again without sessionId',
    });
    expect(await stub.receipt('wa:late')).toBeNull();
    expect(await stub.count()).toBe(1);
    // The same request id, without the session: admitted into a new one.
    const { sessionId: _dropped, ...resent } = late;
    const admitted = await stub.submit(resent);
    if (!admitted.ok) throw new Error(`Turn rejected: ${admitted.message}`);
    expect(admitted.result.sessionId).not.toBe(first.result.sessionId);
    expect(admitted.result.status).toBe('running');
    expect(await stub.boundSession(message.bindingId)).toBe(
      admitted.result.sessionId,
    );
    expect(await stub.count()).toBe(2);
  });

  it('a binding still bound to a deleted session opens a new one at once when the request names none', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('stale-binding');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    // Deleted without the binding being released (an object that missed
    // the release, or a binding row from before it existed).
    await stub.markSessionDeleted(first.result.sessionId);
    const next = await stub.submit({ ...message, requestId: 'wa:two' });
    if (!next.ok) throw new Error(`Turn rejected: ${next.message}`);
    expect(next.result.sessionId).not.toBe(first.result.sessionId);
    expect(await stub.boundSession(message.bindingId)).toBe(
      next.result.sessionId,
    );
    expect(await stub.count()).toBe(2);
  });

  it('a refused request leaves no receipt, so the same request id can be sent again', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('refused-receipt');
    await stub.setDelegation({ raw: 'grant' });
    expect(await stub.submit(message)).toEqual(delegationRequired);
    expect(await stub.receipt(message.requestId)).toBeNull();
    expect(await stub.hostCalls()).toMatchObject({ createSession: 0 });
    await stub.setDelegation({
      raw: 'grant',
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'running' },
    });
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
    expect(await stub.hostCalls()).toMatchObject({ createSession: 1 });
  });
});

/** Rejects when `work` takes longer than `ms`: proves it did not wait. */
async function within<T>(work: () => Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`waited over ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('oracle room mirrors stay off the channel path', () => {
  it('admits and answers a finished run while the mirrors hang, then mirrors both once, in order', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('mirror-hangs');
    await stub.setMirror('hang');
    const first = await within(async () => stub.submit(message));
    if (!first.ok) throw new Error('Turn rejected');
    expect(first.result.status).toBe('running');
    expect(await stub.count()).toBe(1);
    await stub.finish(first.result.runId);
    expect(await within(async () => stub.submit(message))).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
    expect(await stub.mirrors()).toEqual({ user: 0, oracle: 0 });
    await stub.setMirror('ok');
    await stub.deliverReply();
    expect(await stub.mirrorLog()).toEqual([
      'user:Help me plan',
      'oracle:One answer',
    ]);
    expect(await stub.receipt(message.requestId)).toMatchObject({
      user_mirrored: 1,
      reply_mirrored: 1,
      mirror_pending: 0,
    });
    await stub.submit(message);
    await stub.settle();
    expect(await stub.mirrors()).toEqual({ user: 1, oracle: 1 });
  });

  it('a hanging mirror does not hold the admission lock: other requests and polls answer at once', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('mirror-lock');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.settle();
    await stub.setMirror('hang');
    await stub.finish(first.result.runId);
    // The run end starts the reply mirror, which hangs.
    const delivering = stub.deliverReply();
    expect(await within(async () => stub.submit(message))).toMatchObject({
      ok: true,
      result: { status: 'finished' },
    });
    expect(
      await within(async () =>
        stub.submit({ ...message, requestId: 'wa:two' }),
      ),
    ).toMatchObject({ ok: true, result: { status: 'running' } });
    await stub.setMirror('ok');
    await delivering;
    await stub.settle();
    expect(await stub.mirrorLog()).toEqual([
      'user:Help me plan',
      'oracle:One answer',
      'user:Help me plan',
    ]);
  });

  it('answers finished while the mirror fails, retries it with backoff from the alarm, and keeps the room order', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('mirror-fails');
    await stub.setMirror('transient');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    // The user mirror failed; the run started anyway.
    expect(first.result.status).toBe('running');
    await stub.settle();
    const failed = await stub.receipt(message.requestId);
    expect(failed).toMatchObject({
      user_mirrored: 0,
      mirror_pending: 1,
      mirror_failures: 1,
    });
    const retryAt = Number(failed?.mirror_retry_at);
    expect(await stub.retryWakes()).toContain(retryAt);
    await stub.finish(first.result.runId);
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
    await stub.setMirror('ok');
    // Not due yet: the alarm leaves it and asks to come back at its time.
    expect(await stub.housekeeping()).toBe(retryAt);
    await stub.settle();
    expect(await stub.mirrors()).toEqual({ user: 0, oracle: 0 });
    await stub.advance(60_000);
    expect(await stub.housekeeping()).toBeNull();
    await stub.settle();
    expect(await stub.mirrorLog()).toEqual([
      'user:Help me plan',
      'oracle:One answer',
    ]);
    expect(await stub.receipt(message.requestId)).toMatchObject({
      mirror_pending: 0,
      mirror_failures: 0,
      mirror_retry_at: null,
    });
  });

  it('abandons the mirrors of a room that refuses the oracle (M_FORBIDDEN) and still answers the turn', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('mirror-forbidden');
    await stub.setMirror('forbidden');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.settle();
    expect(await stub.receipt(message.requestId)).toMatchObject({
      mirror_pending: 0,
      mirror_failures: 1,
    });
    await stub.finish(first.result.runId);
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
    await stub.settle();
    expect(await stub.housekeeping()).toBeNull();
    expect(await stub.mirrors()).toEqual({ user: 0, oracle: 0 });
  });

  it('a run that ends without a reply owes the room nothing more', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('mirror-failed-run');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.fail(first.result.runId);
    await stub.deliverReply();
    expect(await stub.receipt(message.requestId)).toMatchObject({
      user_mirrored: 1,
      reply_mirrored: 2,
      mirror_pending: 0,
    });
    expect(await stub.mirrors()).toEqual({ user: 1, oracle: 0 });
  });
});

describe('channel record pruning', () => {
  it('removes, from the alarm, receipts that never started a run and run tombstones once 7 days old', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('pruning');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId);
    await stub.orphanReceipt('wa:orphan-old');
    // The run is pruned to a tombstone (boot pruning, run retention).
    await stub.expire(RUN_RETENTION_MS + 1);
    await stub.orphanReceipt('wa:orphan-new');
    expect(await stub.retained()).toMatchObject({
      channel_run_tombstones: 1,
      channel_requests: 2,
    });
    expect(await stub.housekeeping()).toBeNull();
    // The old orphan is past 7 days; the tombstone and the new orphan not.
    expect(await stub.retained()).toMatchObject({
      channel_run_tombstones: 1,
      channel_requests: 1,
    });
    expect(await stub.receipt('wa:orphan-new')).not.toBeNull();
    expect(await stub.submit(message)).toMatchObject({
      ok: false,
      code: 'response_expired',
    });
    await stub.advance(CHANNEL_RECORD_RETENTION_MS + 1);
    expect(await stub.housekeeping()).toBeNull();
    expect(await stub.retained()).toMatchObject({
      channel_run_tombstones: 0,
      channel_requests: 0,
    });
    // Past the replay horizon the request id is a new request.
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'running' },
    });
    expect(await stub.count()).toBe(2);
  });
});

describe('channel quotes and controls', () => {
  const stop: ChannelControlInput = {
    provider: 'whatsapp',
    bindingId: message.bindingId,
    bindingRevision: 1,
    requestId: 'wa:stop',
    cancelRequestIds: [message.requestId],
    command: { kind: 'stop' },
  };
  it('cancels before a delayed turn arrives and never runs that request', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('cancel-before-turn');
    expect((await stub.control(stop)).ok).toBe(true);
    expect(await stub.submit(message)).toMatchObject({
      ok: false,
      code: 'request_cancelled',
    });
    expect(await stub.count()).toBe(0);
    await stub.reopen();
    expect(await stub.submit(message)).toMatchObject({
      ok: false,
      code: 'request_cancelled',
    });
  });
  it('stops the named run and replays a new-session control without switching again', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('cancel-and-new');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const command: ChannelControlInput = { ...stop, command: { kind: 'new' } };
    const fresh = await stub.control(command);
    if (!fresh.ok) throw new Error('Control rejected');
    expect(fresh.result.sessionId).not.toBe(first.result.sessionId);
    expect((await stub.run(first.result.runId))?.status).toBe('aborted');
    const next = await stub.submit({ ...message, requestId: 'wa:after-new' });
    expect(next).toMatchObject({
      ok: true,
      result: { sessionId: fresh.result.sessionId },
    });
    await stub.reopen();
    expect(await stub.control(command)).toEqual(fresh);
    expect(
      await stub.control({ ...command, command: { kind: 'stop' } }),
    ).toMatchObject({ ok: false, code: 'request_conflict' });
    expect(
      await stub.submit({ ...message, bindingId: 'chb_other' }),
    ).toMatchObject({ ok: true });
  });
  it('allows a later stop to cancel a session switch while Matrix is unavailable', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName(
      'stop-hanging-session-switch',
    );
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.blockSessionCreation(true);
    const changing = stub.control({
      ...stop,
      requestId: 'wa:new-pending',
      cancelRequestIds: [],
      command: { kind: 'new' },
    });
    try {
      await expect
        .poll(async () => (await stub.hostCalls()).createSession)
        .toBe(2);
      const stopped = await stub.control({
        ...stop,
        requestId: 'wa:stop-switch',
        cancelRequestIds: ['wa:new-pending'],
      });
      expect(stopped).toMatchObject({
        ok: true,
        result: { sessionId: first.result.sessionId },
      });
    } finally {
      await stub.blockSessionCreation(false);
    }
    expect(await changing).toMatchObject({
      ok: false,
      code: 'request_cancelled',
    });
    expect(await stub.boundSession(message.bindingId)).toBe(
      first.result.sessionId,
    );
  });

  it('resumes an owned conversation and leaves the current session unchanged on refusal', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('resume-conversation');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const fresh = await stub.control({
      ...stop,
      requestId: 'wa:new',
      command: { kind: 'new' },
    });
    if (!fresh.ok) throw new Error('Control rejected');
    expect(
      await stub.control({
        ...stop,
        requestId: 'wa:bad-resume',
        command: { kind: 'resume', sessionId: '$victim' },
      }),
    ).toMatchObject({ ok: false, code: 'session_not_found' });
    expect(await stub.boundSession(message.bindingId)).toBe(
      fresh.result.sessionId,
    );
    expect(
      await stub.control({
        ...stop,
        requestId: 'wa:resume',
        command: { kind: 'resume', sessionId: first.result.sessionId },
      }),
    ).toMatchObject({
      ok: true,
      result: { sessionId: first.result.sessionId },
    });
  });
  it('resolves the selected canonical reply part and refuses a quote from another binding or session', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('canonical-quote');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId, {
      v: 1,
      parts: [
        { partId: 'p1', kind: 'text', text: 'Use Friday.' },
        { partId: 'p2', kind: 'text', text: 'Should I draft it?' },
      ],
    });
    const quoted = await stub.submit({
      ...message,
      requestId: 'wa:quote',
      message: 'Yes',
      replyTo: {
        kind: 'known',
        requestId: message.requestId,
        author: 'oracle',
        partId: 'p2',
      },
    });
    if (!quoted.ok) throw new Error('Turn rejected');
    const req = JSON.parse((await stub.run(quoted.result.runId))!.request);
    expect(req.channel.replyContext).toEqual({
      kind: 'resolved',
      requestId: message.requestId,
      author: 'oracle',
      text: 'Should I draft it?',
    });
    const foreign = await stub.submit({
      ...message,
      bindingId: 'chb_other',
      requestId: 'wa:foreign',
      replyTo: {
        kind: 'known',
        requestId: message.requestId,
        author: 'oracle',
      },
    });
    if (!foreign.ok) throw new Error('Turn rejected');
    expect(
      JSON.parse((await stub.run(foreign.result.runId))!.request).channel
        .replyContext,
    ).toEqual({ kind: 'unavailable' });
    await stub.control({
      ...stop,
      requestId: 'wa:new',
      cancelRequestIds: [],
      command: { kind: 'new' },
    });
    const old = await stub.submit({
      ...message,
      requestId: 'wa:old-quote',
      replyTo: { kind: 'known', requestId: message.requestId, author: 'user' },
    });
    if (!old.ok) throw new Error('Turn rejected');
    expect(
      JSON.parse((await stub.run(old.result.runId))!.request).channel
        .replyContext,
    ).toEqual({ kind: 'unavailable' });
  });
});
