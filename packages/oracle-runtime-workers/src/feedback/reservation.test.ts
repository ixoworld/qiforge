import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { MessageDto } from '../do/transcript';
import {
  FEEDBACK_PENDING_STALE_MS,
  FEEDBACK_USER_LIMIT,
  FEEDBACK_WINDOW_MS,
  isCompletedAgentMessage,
} from './reservation';
import type { FeedbackTestDO, SeedMessage } from './test-do';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      FEEDBACK_TEST: DurableObjectNamespace<FeedbackTestDO>;
    }
  }
}

const identity = { userDid: 'did:ixo:user' };
const AI_1 = '0b6f7c5e-4a63-4d6e-9d55-111111111111';
const HUMAN_1 = '0b6f7c5e-4a63-4d6e-9d55-333333333333';
const transcript: SeedMessage[] = [
  { id: HUMAN_1, type: 'human', content: 'What is a DAO?' },
  { id: AI_1, type: 'ai', content: 'A DAO is…' },
];
const sub = (n: number) =>
  `8103aeac-96e5-441b-9f87-63${String(n).padStart(10, '0')}`;

async function seeded(name: string) {
  const stub = env.FEEDBACK_TEST.get(env.FEEDBACK_TEST.idFromName(name));
  await stub.seed('s-1', transcript);
  return stub;
}

describe('isCompletedAgentMessage', () => {
  const dto = (id: string, type: 'ai' | 'human'): MessageDto => ({
    id,
    type,
    content: id,
    isComplete: true,
  });
  const messages = [
    dto('h1', 'human'),
    dto('a1', 'ai'),
    dto('h2', 'human'),
    dto('a2', 'ai'),
  ];

  it('accepts an Agent reply and rejects user messages and unknown ids', () => {
    expect(isCompletedAgentMessage(messages, 'a1', false)).toBe(true);
    expect(isCompletedAgentMessage(messages, 'h1', false)).toBe(false);
    expect(isCompletedAgentMessage(messages, 'missing', false)).toBe(false);
  });

  it('rejects a reply flagged incomplete', () => {
    expect(
      isCompletedAgentMessage(
        [{ ...dto('a1', 'ai'), isComplete: false }],
        'a1',
        false,
      ),
    ).toBe(false);
  });

  it('while a run is active, rejects the replies of its turn but not earlier ones', () => {
    expect(isCompletedAgentMessage(messages, 'a2', true)).toBe(false);
    expect(isCompletedAgentMessage(messages, 'a1', true)).toBe(true);
  });
});

describe('FeedbackMarkers over the user database', () => {
  it('reserves a completed Agent reply once and replays the delivered submission', async () => {
    const stub = await seeded('reserve-replay');
    const target = { sessionId: 's-1', messageId: AI_1, submissionId: sub(1) };
    const first = await stub.reserveMessageFeedback(identity, target);
    expect(first).toEqual({
      kind: 'reserved',
      submittedAt: '2026-10-05T09:00:00.000Z',
      replacesOtherSubmission: false,
    });
    expect(await stub.markerStatus('s-1', AI_1)).toBe('pending');
    // The same submission retried while it is being delivered: in flight.
    expect(await stub.reserveMessageFeedback(identity, target)).toEqual({
      kind: 'in_flight',
    });
    // Different feedback for the message meanwhile: a conflict.
    expect(
      await stub.reserveMessageFeedback(identity, {
        ...target,
        submissionId: sub(2),
      }),
    ).toEqual({ kind: 'conflict' });
    await stub.settleMessageFeedback(identity, target, 'delivered');
    expect(await stub.markerStatus('s-1', AI_1)).toBe('delivered');
    expect(await stub.reserveMessageFeedback(identity, target)).toEqual({
      kind: 'delivered',
      submittedAt: '2026-10-05T09:00:00.000Z',
    });
    expect(
      await stub.reserveMessageFeedback(identity, {
        ...target,
        submissionId: sub(2),
      }),
    ).toEqual({ kind: 'conflict' });
  });

  it('answers not_found for an unknown session, an unknown message, a user message and the reply of a running turn', async () => {
    const stub = await seeded('not-found');
    for (const target of [
      { sessionId: 'nope', messageId: AI_1 },
      { sessionId: 's-1', messageId: 'missing' },
      { sessionId: 's-1', messageId: HUMAN_1 },
    ])
      expect(
        await stub.reserveMessageFeedback(identity, {
          ...target,
          submissionId: sub(1),
        }),
      ).toEqual({ kind: 'not_found' });
    await stub.setRunning('s-1', true);
    expect(
      await stub.reserveMessageFeedback(identity, {
        sessionId: 's-1',
        messageId: AI_1,
        submissionId: sub(1),
      }),
    ).toEqual({ kind: 'not_found' });
    expect((await stub.dump()).text).not.toContain(sub(1));
  });

  it('releases a failed delivery so the user can try again', async () => {
    const stub = await seeded('release');
    const target = { sessionId: 's-1', messageId: AI_1, submissionId: sub(1) };
    await stub.reserveMessageFeedback(identity, target);
    await stub.settleMessageFeedback(identity, target, 'released');
    expect(await stub.markerStatus('s-1', AI_1)).toBeNull();
    expect((await stub.reserveMessageFeedback(identity, target)).kind).toBe(
      'reserved',
    );
  });

  it('reclaims a stale reservation of the same submission as its own', async () => {
    const stub = await seeded('stale-same');
    const target = { sessionId: 's-1', messageId: AI_1, submissionId: sub(1) };
    await stub.reserveMessageFeedback(identity, target);
    await stub.advance(FEEDBACK_PENDING_STALE_MS);
    expect(await stub.reserveMessageFeedback(identity, target)).toEqual({
      kind: 'reserved',
      submittedAt: '2026-10-05T09:02:00.000Z',
      replacesOtherSubmission: false,
    });
  });

  it('reports when it took over a stale reservation of another submission, and can settle it under that one', async () => {
    const stub = await seeded('stale-other');
    const first = { sessionId: 's-1', messageId: AI_1, submissionId: sub(1) };
    const second = { ...first, submissionId: sub(2) };
    await stub.reserveMessageFeedback(identity, first);
    await stub.advance(FEEDBACK_PENDING_STALE_MS);
    expect(await stub.reserveMessageFeedback(identity, second)).toMatchObject({
      kind: 'reserved',
      replacesOtherSubmission: true,
    });
    // The sink found the first submission's issue: the marker is its.
    await stub.settleMessageFeedback(identity, second, 'superseded');
    expect(await stub.markerStatus('s-1', AI_1)).toBe('delivered');
    expect(await stub.reserveMessageFeedback(identity, second)).toEqual({
      kind: 'conflict',
    });
    expect((await stub.reserveMessageFeedback(identity, first)).kind).toBe(
      'delivered',
    );
  });

  it('keeps the earlier submission across a second stale takeover by the same submission', async () => {
    const stub = await seeded('stale-twice');
    const first = { sessionId: 's-1', messageId: AI_1, submissionId: sub(1) };
    const second = { ...first, submissionId: sub(2) };
    await stub.reserveMessageFeedback(identity, first);
    await stub.advance(FEEDBACK_PENDING_STALE_MS);
    await stub.reserveMessageFeedback(identity, second);
    await stub.advance(FEEDBACK_PENDING_STALE_MS);
    expect(await stub.reserveMessageFeedback(identity, second)).toMatchObject({
      kind: 'reserved',
      replacesOtherSubmission: true,
    });
  });

  it(`limits a user to ${FEEDBACK_USER_LIMIT} new submissions per window; replays do not count`, async () => {
    const stub = await seeded('user-limit');
    const ids = Array.from(
      { length: FEEDBACK_USER_LIMIT + 1 },
      (_, i) => `0b6f7c5e-4a63-4d6e-9d55-${String(500 + i).padStart(12, '0')}`,
    );
    await stub.seed(
      's-1',
      ids.flatMap((id, i) => [
        {
          id: `${HUMAN_1.slice(0, -3)}${900 + i}`,
          type: 'human' as const,
          content: `q${i}`,
        },
        { id, type: 'ai' as const, content: `a${i}` },
      ]),
    );
    for (let i = 0; i < FEEDBACK_USER_LIMIT; i += 1) {
      const target = {
        sessionId: 's-1',
        messageId: ids[i]!,
        submissionId: sub(i),
      };
      expect((await stub.reserveMessageFeedback(identity, target)).kind).toBe(
        'reserved',
      );
      await stub.settleMessageFeedback(identity, target, 'delivered');
    }
    // A replay of a delivered submission is answered, not limited.
    expect(
      (
        await stub.reserveMessageFeedback(identity, {
          sessionId: 's-1',
          messageId: ids[0]!,
          submissionId: sub(0),
        })
      ).kind,
    ).toBe('delivered');
    const last = {
      sessionId: 's-1',
      messageId: ids[FEEDBACK_USER_LIMIT]!,
      submissionId: sub(99),
    };
    expect(await stub.reserveMessageFeedback(identity, last)).toEqual({
      kind: 'rate_limited',
    });
    await stub.advance(FEEDBACK_WINDOW_MS);
    expect((await stub.reserveMessageFeedback(identity, last)).kind).toBe(
      'reserved',
    );
  });

  it('drops a deleted session’s markers', async () => {
    const stub = await seeded('forget');
    const target = { sessionId: 's-1', messageId: AI_1, submissionId: sub(1) };
    await stub.reserveMessageFeedback(identity, target);
    await stub.settleMessageFeedback(identity, target, 'delivered');
    await stub.forgetSession('s-1');
    expect(await stub.markerStatus('s-1', AI_1)).toBeNull();
  });

  it('stores ids, a status and timestamps only', async () => {
    const stub = await seeded('columns');
    await stub.reserveMessageFeedback(identity, {
      sessionId: 's-1',
      messageId: AI_1,
      submissionId: sub(1),
    });
    const { tables, text } = await stub.dump();
    expect(tables).toEqual(
      expect.arrayContaining([
        'message_feedback_attempts',
        'message_feedback_markers',
      ]),
    );
    expect(JSON.parse(text).message_feedback_markers).toEqual([
      {
        session_id: 's-1',
        message_id: AI_1,
        submission_id: sub(1),
        previous_submission_id: null,
        status: 'pending',
        reserved_at: Date.parse('2026-10-05T09:00:00.000Z'),
        submitted_at: '2026-10-05T09:00:00.000Z',
      },
    ]);
  });
});
