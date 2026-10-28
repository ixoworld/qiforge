import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChannelTurnsTestDO } from './test-do';
import {
  CHANNEL_DELEGATION_MIN_REMAINING_SECONDS,
  ChannelControlBody,
  ChannelControlResult,
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
    // Admission: the receipt, the session binding with the owed mirror,
    // the session noted as this binding's; then, in the background, the
    // user message mirrored.
    const admitted = {
      assertSession: 1,
      changed: 4,
      createSession: 1,
      stopRuns: 0,
    };
    expect(await stub.hostCalls()).toEqual(admitted);
    for (let i = 0; i < 5; i += 1)
      expect(await stub.submit(message)).toEqual(first);
    await stub.settle();
    expect(await stub.hostCalls()).toEqual(admitted);
    // A second request is bound to the binding's session (its receipt
    // and the binding row are written; the session is already noted) and
    // checked once.
    const second = await stub.submit({ ...message, requestId: 'wa:two' });
    if (!second.ok) throw new Error('Turn rejected');
    expect(second.result.sessionId).toBe(first.result.sessionId);
    await stub.settle();
    const twice = { ...admitted, assertSession: 2, changed: 7 };
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
    ).toEqual({ kind: 'unavailable', reason: 'unknown' });
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
    ).toEqual({ kind: 'unavailable', reason: 'other_conversation' });
  });

  it('still answers a finished reply after a stop that named it arrived late', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('stop-after-finish');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId);
    expect(await stub.control(stop)).toMatchObject({ ok: true });
    expect(await stub.submit(message)).toMatchObject({
      ok: true,
      result: { status: 'finished', text: 'One answer' },
    });
    expect((await stub.run(first.result.runId))?.status).toBe('finished');
    // A request the stop named that never ran stays cancelled.
    expect(
      await stub.control({
        ...stop,
        requestId: 'wa:stop-two',
        cancelRequestIds: ['wa:two'],
      }),
    ).toMatchObject({ ok: true });
    expect(
      await stub.submit({ ...message, requestId: 'wa:two' }),
    ).toMatchObject({ ok: false, code: 'request_cancelled' });
  });

  it('stops every named run in one call and acknowledges the stop', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('stop-many');
    const runs: string[] = [];
    for (const requestId of ['wa:a', 'wa:b', 'wa:c']) {
      const turn = await stub.submit({ ...message, requestId });
      if (!turn.ok) throw new Error('Turn rejected');
      runs.push(turn.result.runId);
    }
    expect(
      await stub.control({
        ...stop,
        cancelRequestIds: ['wa:a', 'wa:b', 'wa:c', 'wa:never-sent'],
      }),
    ).toMatchObject({ ok: true, result: { command: 'stop' } });
    expect((await stub.hostCalls()).stopRuns).toBe(1);
    for (const runId of runs)
      expect((await stub.run(runId))?.status).toBe('aborted');
  });

  it('resumes only a conversation this binding used at its current consent revision', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('resume-boundary');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const other = await stub.submit({
      ...message,
      bindingId: 'chb_other',
      requestId: 'wa:other',
    });
    if (!other.ok) throw new Error('Turn rejected');
    const resume = (
      requestId: string,
      sessionId: string,
      bindingRevision = 1,
    ) =>
      stub.control({
        ...stop,
        requestId,
        bindingRevision,
        cancelRequestIds: [],
        command: { kind: 'resume', sessionId },
      });
    const refused = { ok: false, code: 'session_not_found' };
    // Another binding's conversation, and a Portal one the user owns.
    expect(await resume('wa:r1', other.result.sessionId)).toMatchObject(
      refused,
    );
    expect(await resume('wa:r2', '$portal-session')).toMatchObject(refused);
    // This binding's conversation, under a later consent revision.
    expect(await resume('wa:r3', first.result.sessionId, 2)).toMatchObject(
      refused,
    );
    expect(await stub.boundSession(message.bindingId)).toBe(
      first.result.sessionId,
    );
    const fresh = await stub.control({
      ...stop,
      requestId: 'wa:new',
      cancelRequestIds: [],
      command: { kind: 'new' },
    });
    if (!fresh.ok) throw new Error('Control rejected');
    expect(await resume('wa:r4', first.result.sessionId)).toMatchObject({
      ok: true,
      result: { sessionId: first.result.sessionId },
    });
    // A session bound before the binding table existed is recognised by
    // the revision its latest request was sent under.
    await stub.forgetSessionBindings();
    expect(await resume('wa:r5', first.result.sessionId)).toMatchObject({
      ok: true,
    });
    expect(await resume('wa:r6', fresh.result.sessionId!)).toMatchObject(
      refused,
    );
    expect(await resume('wa:r7', first.result.sessionId, 2)).toMatchObject(
      refused,
    );
  });

  it('forgets a refused control, so a corrected body under its id is accepted', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('refused-control');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const control = {
      ...stop,
      requestId: 'wa:resume',
      cancelRequestIds: [],
    };
    expect(
      await stub.control({
        ...control,
        command: { kind: 'resume', sessionId: '$victim' },
      }),
    ).toMatchObject({ ok: false, code: 'session_not_found' });
    expect(
      await stub.control({
        ...control,
        command: { kind: 'resume', sessionId: first.result.sessionId },
      }),
    ).toMatchObject({ ok: true, result: { command: 'resume' } });
    await stub.revokeDelegation();
    expect(
      await stub.control({
        ...control,
        requestId: 'wa:new',
        command: { kind: 'new' },
      }),
    ).toMatchObject({ ok: false, code: 'delegation_required' });
    await stub.setDelegation({
      raw: 'grant',
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(
      await stub.control({
        ...control,
        requestId: 'wa:new',
        command: { kind: 'stop' },
      }),
    ).toMatchObject({ ok: true, result: { command: 'stop' } });
  });

  it('reuses the session a new-session control created when it is retried', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('new-retry');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const command: ChannelControlInput = {
      ...stop,
      requestId: 'wa:new',
      cancelRequestIds: [],
      command: { kind: 'new' },
    };
    await stub.failAssertSessionOnce();
    expect(await stub.control(command)).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
    expect((await stub.hostCalls()).createSession).toBe(2);
    const retried = await stub.control(command);
    if (!retried.ok) throw new Error('Control rejected');
    expect(retried.result.sessionId).not.toBe(first.result.sessionId);
    expect((await stub.hostCalls()).createSession).toBe(2);
    expect(await stub.boundSession(message.bindingId)).toBe(
      retried.result.sessionId,
    );
  });

  it('ignores an unreadable stored control result and completes the control again', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('unreadable-control');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const status: ChannelControlInput = {
      ...stop,
      cancelRequestIds: [],
      command: { kind: 'status' },
    };
    expect(await stub.control(status)).toMatchObject({ ok: true });
    await stub.corruptStored('channel_controls', status.requestId);
    expect(await stub.control(status)).toMatchObject({
      ok: true,
      result: { sessionId: first.result.sessionId, command: 'status' },
    });
  });
});

describe('channel topics, rename and titles', () => {
  const control: ChannelControlInput = {
    provider: 'whatsapp',
    bindingId: message.bindingId,
    bindingRevision: 1,
    requestId: 'wa:control',
    cancelRequestIds: [],
    command: { kind: 'status' },
  };
  const topics = (id: string, bindingRevision = 1): ChannelControlInput => ({
    ...control,
    requestId: id,
    bindingRevision,
    command: { kind: 'topics' },
  });
  const rename = (id: string, title: string): ChannelControlInput => ({
    ...control,
    requestId: id,
    command: { kind: 'rename', title },
  });
  const listed = async (
    stub: ReturnType<typeof env.CHANNEL_TURNS_TEST.getByName>,
    input: ChannelControlInput,
  ) => {
    const outcome = await stub.control(input);
    if (!outcome.ok) throw new Error(`Control refused: ${outcome.code}`);
    return outcome.result;
  };
  /** A fresh topic for the binding: `new`, then one message in it. */
  const newTopic = async (
    stub: ReturnType<typeof env.CHANNEL_TURNS_TEST.getByName>,
    n: number,
    text = `Question ${n}`,
  ) => {
    const result = await listed(stub, {
      ...control,
      requestId: `wa:new-${n}`,
      command: { kind: 'new' },
    });
    const turn = await stub.submit({
      ...message,
      requestId: `wa:q-${n}`,
      message: text,
    });
    if (!turn.ok || !result.sessionId) throw new Error('Turn rejected');
    return { sessionId: result.sessionId, runId: turn.result.runId };
  };

  it('lists this binding and revision only, newest activity first, the bound one included', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-list');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const second = await newTopic(stub, 2);
    const other = await stub.submit({
      ...message,
      bindingId: 'chb_other',
      requestId: 'wa:other',
    });
    if (!other.ok) throw new Error('Turn rejected');
    await stub.setSessionInfo(first.result.sessionId, {
      title: 'Plan',
      createdAt: 1_000,
      updatedAt: 3_000,
    });
    await stub.setSessionInfo(second.sessionId, {
      title: null,
      createdAt: 2_000,
      updatedAt: 2_000,
    });
    const result = await listed(stub, topics('wa:topics'));
    expect(result).toMatchObject({
      command: 'topics',
      sessionId: second.sessionId,
      title: null,
    });
    expect(result.topics?.map((topic) => topic.sessionId)).toEqual([
      first.result.sessionId,
      second.sessionId,
    ]);
    expect(result.topics?.[0]).toMatchObject({
      title: 'Plan',
      createdAt: 1_000,
      updatedAt: 3_000,
    });
    // Another consent revision has used none of them; only the bound one is listed.
    const later = await listed(stub, topics('wa:topics-r2', 2));
    expect(later.topics?.map((topic) => topic.sessionId)).toEqual([
      second.sessionId,
    ]);
  });

  it('does not quote text sent under an earlier consent revision', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-revision');
    const first = await stub.submit({
      ...message,
      message: 'Old consent text',
    });
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId, undefined, 'Old consent reply');
    const same = await listed(stub, topics('wa:topics'));
    expect(same.topics?.[0]).toMatchObject({
      lastUser: 'Old consent text',
      lastReply: 'Old consent reply',
    });
    // The bound session is listed under the new revision, without its lines.
    const later = await listed(stub, topics('wa:topics-r2', 2));
    expect(later.sessionId).toBe(first.result.sessionId);
    expect(later.topics).toHaveLength(1);
    expect(later.topics?.[0]).toMatchObject({
      sessionId: first.result.sessionId,
      lastUser: null,
      lastReply: null,
    });
  });

  it('skips a routing clarification for the last lines', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-clarification');
    await stub.configureRouting('on');
    const first = await stub.submit({ ...message, message: 'Real question' });
    if (!first.ok) throw new Error('Turn rejected');
    await stub.finish(first.result.runId, undefined, 'Real answer');
    const clarified = await stub.submit({
      ...message,
      requestId: 'wa:clarify',
      message: 'Which one?',
      replyTo: { kind: 'known', author: 'user', requestId: 'wa:unknown' },
    });
    if (!clarified.ok) throw new Error('Turn rejected');
    expect(
      JSON.parse((await stub.run(clarified.result.runId))!.request).channel
        .routingClarification,
    ).toEqual(expect.any(String));
    expect(clarified.result.sessionId).toBe(first.result.sessionId);
    await stub.finish(clarified.result.runId, undefined, 'Please say which');
    const result = await listed(stub, topics('wa:topics'));
    expect(result.topics?.[0]).toMatchObject({
      lastUser: 'Real question',
      lastReply: 'Real answer',
    });
  });

  it('keeps a topic whose stored request cannot be read, with null lines', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-corrupt-request');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.corruptRunRequest(first.result.runId);
    const result = await listed(stub, topics('wa:topics'));
    expect(result.topics).toHaveLength(1);
    expect(result.topics?.[0]).toMatchObject({
      sessionId: first.result.sessionId,
      lastUser: null,
      lastReply: null,
    });
  });

  it('reads the sessions in a bounded number of statements', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-batched');
    for (let n = 1; n <= 5; n += 1) await newTopic(stub, n);
    const before = await stub.sessionReads();
    await listed(stub, topics('wa:topics'));
    // One batched read for the list, one for the title of the result.
    expect((await stub.sessionReads()) - before).toBe(2);
  });

  it('lists a long-ago-bound session again once it is bound again', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-rebound');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.advance(5_000);
    const second = await newTopic(stub, 2);
    await stub.advance(5_000);
    const back = await listed(stub, {
      ...control,
      requestId: 'wa:back',
      command: { kind: 'resume', sessionId: first.result.sessionId },
    });
    expect(back.sessionId).toBe(first.result.sessionId);
    expect(await stub.bindingRowsNewestFirst(message.bindingId)).toEqual([
      first.result.sessionId,
      second.sessionId,
    ]);
  });

  it('is read-only: it cancels nothing and leaves the bound session alone', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-read-only');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const before = await stub.boundSession(message.bindingId);
    const result = await listed(stub, topics('wa:topics'));
    expect(result.sessionId).toBe(first.result.sessionId);
    expect(await stub.boundSession(message.bindingId)).toBe(before);
    expect((await stub.hostCalls()).stopRuns).toBe(0);
    expect((await stub.run(first.result.runId))?.status).toBe('running');
  });

  it('skips a deleted session and removes its binding row', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-deleted');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const second = await newTopic(stub, 2);
    await stub.markSessionDeleted(first.result.sessionId);
    expect(await stub.bindingRows(message.bindingId)).toContain(
      first.result.sessionId,
    );
    const result = await listed(stub, topics('wa:topics'));
    expect(result.topics?.map((topic) => topic.sessionId)).toEqual([
      second.sessionId,
    ]);
    expect(await stub.bindingRows(message.bindingId)).toEqual([
      second.sessionId,
    ]);
  });

  it('lists at most 20 sessions, the most recently active', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-cap');
    const ids: string[] = [];
    for (let n = 1; n <= 23; n += 1) {
      const topic = await newTopic(stub, n);
      await stub.setSessionInfo(topic.sessionId, { updatedAt: n * 1_000 });
      ids.push(topic.sessionId);
    }
    const result = await listed(stub, topics('wa:topics'));
    expect(result.topics).toHaveLength(20);
    expect(result.topics?.map((topic) => topic.sessionId)).toEqual(
      ids.slice(3).reverse(),
    );
  });

  it('fills the last lines from the newest request, and nulls what is not there', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-lines');
    const done = await newTopic(stub, 1, 'What is the rent?');
    await stub.finish(done.runId, undefined, 'R'.repeat(300));
    const running = await newTopic(stub, 2, 'Still thinking');
    const failed = await newTopic(stub, 3, 'Broken');
    await stub.fail(failed.runId);
    const idle = await listed(stub, {
      ...control,
      requestId: 'wa:new-4',
      command: { kind: 'new' },
    });
    for (const [n, sessionId] of [
      [1, done.sessionId],
      [2, running.sessionId],
      [3, failed.sessionId],
      [4, idle.sessionId],
    ] as const)
      await stub.setSessionInfo(sessionId!, { updatedAt: n * 1_000 });
    const result = await listed(stub, topics('wa:topics'));
    const byId = new Map(
      result.topics?.map((topic) => [topic.sessionId, topic]),
    );
    expect(byId.get(done.sessionId)).toMatchObject({
      lastUser: 'What is the rent?',
      lastReply: 'R'.repeat(200),
    });
    expect(byId.get(running.sessionId)).toMatchObject({
      lastUser: 'Still thinking',
      lastReply: null,
    });
    expect(byId.get(failed.sessionId)).toMatchObject({
      lastUser: 'Broken',
      lastReply: null,
    });
    expect(byId.get(idle.sessionId!)).toMatchObject({
      lastUser: null,
      lastReply: null,
    });
  });

  it('clips the lines to 200 code points, never splitting one', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-clip');
    const topic = await newTopic(stub, 1, '\u{1F600}'.repeat(250));
    await stub.finish(topic.runId, undefined, '\u{1F680}'.repeat(250));
    const result = await listed(stub, topics('wa:topics'));
    expect(result.topics?.[0]?.lastUser).toBe('\u{1F600}'.repeat(200));
    expect(result.topics?.[0]?.lastReply).toBe('\u{1F680}'.repeat(200));
    // 200 emoji are 400 UTF-16 units: the schema counts code points, and the
    // receipt reads back, so a retry replays it.
    expect(ChannelControlResult.safeParse(result).success).toBe(true);
    expect(await listed(stub, topics('wa:topics'))).toEqual(result);
  });

  it('counts titles and lines in code points in the schemas', async () => {
    const emoji = '\u{1F600}';
    const rename41 = {
      ...control,
      command: { kind: 'rename', title: emoji.repeat(41) },
    };
    expect(ChannelControlBody.safeParse(rename41).success).toBe(true);
    expect(
      ChannelControlBody.safeParse({
        ...control,
        command: { kind: 'rename', title: emoji.repeat(80) },
      }).success,
    ).toBe(true);
    expect(
      ChannelControlBody.safeParse({
        ...control,
        command: { kind: 'rename', title: emoji.repeat(81) },
      }).success,
    ).toBe(false);
    expect(
      ChannelControlBody.safeParse({
        ...control,
        command: { kind: 'rename', title: '' },
      }).success,
    ).toBe(false);
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-emoji-title');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.setSessionInfo(first.result.sessionId, {
      title: emoji.repeat(150),
    });
    const result = await listed(stub, topics('wa:topics'));
    expect(result.title).toBe(emoji.repeat(150));
    expect(result.topics?.[0]?.title).toBe(emoji.repeat(150));
    expect(ChannelControlResult.safeParse(result).success).toBe(true);
    const renamed = await listed(stub, rename('wa:rename', emoji.repeat(41)));
    expect(renamed.title).toBe(emoji.repeat(41));
  });

  it('normalises titles and lines: one plain line, no invisible characters', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-normalise');
    const topic = await newTopic(
      stub,
      1,
      'Line one\n\n  line\ttwo\u202Eevil\u200Bzero\u2028end',
    );
    await stub.finish(topic.runId, undefined, 'A\r\nB   C\u0007D');
    await stub.setSessionInfo(topic.sessionId, {
      title: '  Rent\u200B \n plan\u202E  ',
    });
    const result = await listed(stub, topics('wa:topics'));
    expect(result.title).toBe('Rent plan');
    expect(result.topics?.[0]).toMatchObject({
      title: 'Rent plan',
      lastUser: 'Line one line twoevilzero end',
      lastReply: 'A B CD',
    });
    const named = await listed(
      stub,
      rename('wa:rename', ' \u200B Big \t\n  plan\u202E '),
    );
    expect(named.title).toBe('Big plan');
  });

  it('shows what the person typed, without the reply or time notes', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-notes');
    const topic = await newTopic(stub, 1, 'Is it still on?');
    await stub.finish(topic.runId, undefined, 'It is on.');
    const quoted = await stub.submit({
      ...message,
      requestId: 'wa:quote',
      message: 'Great, thanks',
      replyTo: { kind: 'known', requestId: 'wa:q-1', author: 'user' },
    });
    if (!quoted.ok) throw new Error('Turn rejected');
    // The quote reached the run as context (the note the model sees)...
    expect(
      JSON.parse((await stub.run(quoted.result.runId))!.request).channel
        .replyContext,
    ).toMatchObject({ kind: 'resolved', text: 'Is it still on?' });
    // ...and the topic shows only what the person typed.
    const result = await listed(stub, topics('wa:topics'));
    expect(result.topics?.[0]?.sessionId).toBe(topic.sessionId);
    expect(result.topics?.[0]?.lastUser).toBe('Great, thanks');
    expect(JSON.stringify(result)).not.toContain('Is it still on?');
  });

  it('renames the bound session, replacing a generated title', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('rename');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.setSessionInfo(first.result.sessionId, {
      title: 'Generated title',
    });
    const result = await listed(
      stub,
      rename('wa:rename', '  Rent \u0007plan\n2027  '),
    );
    expect(result).toEqual({
      requestId: 'wa:rename',
      sessionId: first.result.sessionId,
      command: 'rename',
      title: 'Rent plan 2027',
    });
    expect(await stub.titleOf(first.result.sessionId)).toBe('Rent plan 2027');
    const listing = await listed(stub, topics('wa:topics'));
    expect(listing.topics?.[0]?.title).toBe('Rent plan 2027');
  });

  it('refuses a rename without a bound session, and one that leaves no title', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('rename-unbound');
    expect(await stub.control(rename('wa:rename', 'Rent'))).toMatchObject({
      ok: false,
      status: 404,
      code: 'session_not_found',
    });
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    expect(await stub.control(rename('wa:blank', ' \u0007 '))).toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_request',
    });
    expect(await stub.titleOf(first.result.sessionId)).toBeNull();
    // The refusal took its receipt with it: the same id works once bound.
    expect(await stub.control(rename('wa:rename', 'Rent'))).toMatchObject({
      ok: true,
      result: { title: 'Rent' },
    });
  });

  it('refuses the placeholder as a name, in any case', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('rename-placeholder');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    for (const title of ['Untitled', ' uNtItLeD ', 'UNTITLED'])
      expect(await stub.control(rename('wa:rename', title))).toMatchObject({
        ok: false,
        status: 400,
        code: 'invalid_request',
      });
    expect(await stub.titleOf(first.result.sessionId)).toBeNull();
    expect(await stub.controlReceipts(message.bindingId)).toEqual([]);
    expect(
      await stub.control(rename('wa:rename', 'Untitled plan')),
    ).toMatchObject({ ok: true, result: { title: 'Untitled plan' } });
  });

  it('drops the receipt of a rename the session store refuses after the checks', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('rename-refused-late');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.refuseRenameOnce();
    expect(await stub.control(rename('wa:rename', 'Rent'))).toMatchObject({
      ok: false,
      status: 404,
      code: 'session_not_found',
    });
    expect(await stub.controlReceipts(message.bindingId)).toEqual([]);
    // A corrected retry under the same id is accepted, not a conflict.
    expect(await stub.control(rename('wa:rename', 'Rent plan'))).toMatchObject({
      ok: true,
      result: { title: 'Rent plan' },
    });
    expect(await stub.titleOf(first.result.sessionId)).toBe('Rent plan');
  });

  it('replays a receipt stored before results carried a title', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('receipt-without-title');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    expect(
      await listed(stub, { ...control, requestId: 'wa:old' }),
    ).toMatchObject({ command: 'status' });
    await stub.storeControlResult(
      message.bindingId,
      'wa:old',
      JSON.stringify({
        requestId: 'wa:old',
        sessionId: first.result.sessionId,
        command: 'status',
      }),
    );
    await stub.setSessionInfo(first.result.sessionId, { title: 'Now titled' });
    expect(await listed(stub, { ...control, requestId: 'wa:old' })).toEqual({
      requestId: 'wa:old',
      sessionId: first.result.sessionId,
      command: 'status',
      title: null,
    });
  });

  it('refuses topics and rename that name requests to cancel', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-cancel');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    for (const command of [
      topics('wa:t'),
      rename('wa:r', 'Rent'),
    ] satisfies ChannelControlInput[])
      expect(
        await stub.control({
          ...command,
          cancelRequestIds: [message.requestId],
        }),
      ).toMatchObject({ ok: false, status: 400, code: 'invalid_request' });
    expect((await stub.hostCalls()).stopRuns).toBe(0);
    expect((await stub.run(first.result.runId))?.status).toBe('running');
  });

  it('answers a retried topics or rename from its receipt', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('topics-retry');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    const renamed = await listed(stub, rename('wa:rename', 'Rent'));
    const listing = await listed(stub, topics('wa:topics'));
    await stub.setSessionInfo(first.result.sessionId, { title: 'Changed' });
    await newTopic(stub, 2);
    expect(await listed(stub, rename('wa:rename', 'Rent'))).toEqual(renamed);
    expect(await listed(stub, topics('wa:topics'))).toEqual(listing);
    expect(await stub.titleOf(first.result.sessionId)).toBe('Changed');
    expect(
      await stub.control({ ...rename('wa:rename', 'Other') }),
    ).toMatchObject({ ok: false, code: 'request_conflict' });
  });

  it('carries the session title on every control result', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('titles');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    await stub.setSessionInfo(first.result.sessionId, { title: 'Plan' });
    expect(
      await listed(stub, { ...control, requestId: 'wa:status' }),
    ).toMatchObject({ command: 'status', title: 'Plan' });
    const fresh = await listed(stub, {
      ...control,
      requestId: 'wa:new',
      command: { kind: 'new' },
    });
    expect(fresh).toMatchObject({ command: 'new', title: null });
    await stub.setSessionInfo(fresh.sessionId!, { title: 'Untitled' });
    expect(
      await listed(stub, { ...control, requestId: 'wa:status-2' }),
    ).toMatchObject({ title: null });
    expect(
      await listed(stub, {
        ...control,
        requestId: 'wa:resume',
        command: { kind: 'resume', sessionId: first.result.sessionId },
      }),
    ).toMatchObject({ command: 'resume', title: 'Plan' });
    expect(
      await listed(stub, {
        ...control,
        requestId: 'wa:stop',
        command: { kind: 'stop' },
      }),
    ).toMatchObject({ command: 'stop', title: 'Plan' });
  });

  it('carries the session title on turn responses, null while untitled', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('session-title');
    const first = await stub.submit(message);
    if (!first.ok) throw new Error('Turn rejected');
    expect(first.result.sessionTitle).toBeNull();
    await stub.setSessionInfo(first.result.sessionId, { title: 'Plan' });
    const polled = await stub.submit(message);
    if (!polled.ok) throw new Error('Turn rejected');
    expect(polled.result.sessionTitle).toBe('Plan');
    await stub.finish(first.result.runId);
    const finished = await stub.submit(message);
    expect(finished).toMatchObject({
      ok: true,
      result: { status: 'finished', sessionTitle: 'Plan' },
    });
  });
});
