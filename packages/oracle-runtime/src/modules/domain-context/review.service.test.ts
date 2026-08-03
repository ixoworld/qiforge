/**
 * @fileoverview Tests for the human-review loop.
 *
 * Two properties matter here above the mechanics. An approval covers exactly
 * the request a person was shown and nothing adjacent to it. And the entity
 * cannot approve its own escalation — the one direction a compromised model
 * would push hardest on, and the reason `manual_review_required` is worth
 * more than a warning.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../plugin-api/types.js';
import { mockDomain } from '../../testing/mocks.js';
import {
  APPROVAL_EVENT_TYPE,
  ConstitutionReviewService,
  ESCALATION_EVENT_TYPE,
  type RoomStateEvent,
} from './review.service.js';

const ROOM = '!review:ixo.world';
const SELF = '@oracle:ixo.world';
const REVIEWER = '@steward:ixo.world';
const DIGEST = 'a'.repeat(64);

function silentLogger(): Logger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function approval(overrides: Partial<RoomStateEvent> = {}): RoomStateEvent {
  return {
    type: APPROVAL_EVENT_TYPE,
    state_key: DIGEST,
    sender: REVIEWER,
    content: { request_digest: DIGEST },
    ...overrides,
  };
}

function service(
  options: { state?: RoomStateEvent[]; room?: string | null } = {},
) {
  const sent: Array<{ room: string; type: string; content: object }> = [];
  const logger = silentLogger();
  const review = new ConstitutionReviewService({
    domain: mockDomain({
      agents: [
        {
          id: 'did:ixo:entity:test',
          forbidden_outputs: [],
          escalation: {
            human_role: 'steward',
            matrix_room: options.room === undefined ? ROOM : options.room,
          },
        },
      ],
    }),
    transport: {
      sendEvent: async (room, type, content) => {
        sent.push({ room, type, content });
        return '$event';
      },
      getRoomState: async () => options.state ?? [],
    },
    logger,
    selfMatrixUserId: SELF,
    // No caching between assertions unless a test asks for it.
    cacheTtlMs: 0,
  });
  return { review, sent, logger };
}

function subject(overrides: Record<string, unknown> = {}) {
  return {
    toolName: 'settle_invoice',
    action: 'pay',
    operation: 'settle_invoice',
    object: 'ixo:vendor:garage',
    value: { amount: '100', denom: 'uixo' },
    reasonCodes: ['human_review_required'],
    ruleRefs: ['right:test:pay'],
    sessionId: 'sess-1',
    requestDigest: DIGEST,
    ...overrides,
  };
}

describe('raising an escalation', () => {
  it('posts to the room the constitution names, carrying the digest', async () => {
    const { review, sent } = service();
    await review.escalate(subject());

    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe(ROOM);
    expect(sent[0].type).toBe(ESCALATION_EVENT_TYPE);
    expect(sent[0].content).toMatchObject({
      request_digest: DIGEST,
      tool: 'settle_invoice',
      object: 'ixo:vendor:garage',
      value: { amount: '100', denom: 'uixo' },
      reviewer_role: 'steward',
    });
  });

  // A reviewer facing forty identical requests reads none of them, and the
  // model is explicitly told that raising this is the right next step.
  it('raises the same request once', async () => {
    const { review, sent } = service();
    await review.escalate(subject());
    await review.escalate(subject());
    await review.escalate(subject());
    expect(sent).toHaveLength(1);
  });

  it('raises a different request separately', async () => {
    const { review, sent } = service();
    await review.escalate(subject());
    await review.escalate(subject({ requestDigest: 'b'.repeat(64) }));
    expect(sent).toHaveLength(2);
  });

  // Suppressing the repeat would lose it entirely: the reviewer never saw it.
  it('allows a retry after a send that failed', async () => {
    const { review } = service();
    const attempts: string[] = [];
    Reflect.set(Reflect.get(review, 'transport') as object, 'sendEvent', () => {
      attempts.push('try');
      return Promise.reject(new Error('room gone'));
    });
    await review.escalate(subject());
    await review.escalate(subject());
    expect(attempts).toHaveLength(2);
  });

  it('says so loudly when the constitution declares nowhere to escalate to', async () => {
    const { review, sent, logger } = service({ room: null });
    await review.escalate(subject());
    expect(sent).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('constitution.escalation.undeliverable'),
    );
  });
});

describe('finding an approval', () => {
  it('returns the reviewer who approved this exact request', async () => {
    const { review } = service({ state: [approval()] });
    expect(await review.findApproval(DIGEST)).toBe(REVIEWER);
  });

  it('returns nothing for a request nobody approved', async () => {
    const { review } = service({ state: [approval()] });
    expect(await review.findApproval('c'.repeat(64))).toBeNull();
  });

  it('returns nothing when there are no approvals at all', async () => {
    const { review } = service();
    expect(await review.findApproval(DIGEST)).toBeNull();
  });

  // Withdrawing an approval is redacting the state event, which leaves empty
  // content behind rather than removing the key.
  it('treats a withdrawn approval as absent', async () => {
    const { review } = service({ state: [approval({ content: {} })] });
    expect(await review.findApproval(DIGEST)).toBeNull();
  });

  // Otherwise an approval for one action could be filed under the key of
  // another, and the key is what the lookup trusts.
  it('rejects an approval whose content names a different request', async () => {
    const { review, logger } = service({
      state: [approval({ content: { request_digest: 'd'.repeat(64) } })],
    });
    expect(await review.findApproval(DIGEST)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('ignores unrelated state events in the room', async () => {
    const { review } = service({
      state: [
        { type: 'm.room.topic', state_key: '', sender: REVIEWER, content: {} },
        approval(),
      ],
    });
    expect(await review.findApproval(DIGEST)).toBe(REVIEWER);
  });

  // An unreadable room is not an approving one.
  it('treats a room it cannot read as having no approvals', async () => {
    const { review, logger } = service();
    Reflect.set(
      Reflect.get(review, 'transport') as object,
      'getRoomState',
      () => Promise.reject(new Error('forbidden')),
    );
    expect(await review.findApproval(DIGEST)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// The property the whole review step exists to have. Generation and
// determination stay separate principals.
describe('the entity cannot approve itself', () => {
  it('refuses an approval sent by the oracle', async () => {
    const { review, logger } = service({
      state: [approval({ sender: SELF })],
    });
    expect(await review.findApproval(DIGEST)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('constitution.approval.self_issued'),
    );
  });

  it('still honours a real reviewer alongside a self-issued one', async () => {
    const { review } = service({
      state: [
        approval({ sender: SELF }),
        approval({
          state_key: 'e'.repeat(64),
          sender: REVIEWER,
          content: { request_digest: 'e'.repeat(64) },
        }),
      ],
    });
    expect(await review.findApproval(DIGEST)).toBeNull();
    expect(await review.findApproval('e'.repeat(64))).toBe(REVIEWER);
  });
});

describe('verifying a proof reference', () => {
  it('accepts the reviewer who actually approved', async () => {
    const { review } = service({ state: [approval()] });
    expect(await review.verifyProof(REVIEWER, DIGEST)).toBe(true);
  });

  // The reference travels through `AuthorizationRequest`, so a verifier that
  // took it at face value would approve anything able to set that field.
  it('rejects a reference naming someone who did not approve', async () => {
    const { review } = service({ state: [approval()] });
    expect(await review.verifyProof('@someone-else:ixo.world', DIGEST)).toBe(
      false,
    );
  });

  it('rejects a reference for a different request', async () => {
    const { review } = service({ state: [approval()] });
    expect(await review.verifyProof(REVIEWER, 'f'.repeat(64))).toBe(false);
  });

  it('rejects a reference with no request bound to it', async () => {
    const { review } = service({ state: [approval()] });
    expect(await review.verifyProof(REVIEWER)).toBe(false);
  });
});

describe('caching', () => {
  it('re-reads the room only after the window passes', async () => {
    let reads = 0;
    let clock = 1000;
    const review = new ConstitutionReviewService({
      domain: mockDomain({
        agents: [
          {
            id: 'did:ixo:entity:test',
            forbidden_outputs: [],
            escalation: { human_role: 'steward', matrix_room: ROOM },
          },
        ],
      }),
      transport: {
        sendEvent: async () => '$e',
        getRoomState: async () => {
          reads += 1;
          return [approval()];
        },
      },
      logger: silentLogger(),
      selfMatrixUserId: SELF,
      now: () => clock,
      cacheTtlMs: 5000,
    });

    await review.findApproval(DIGEST);
    await review.findApproval(DIGEST);
    expect(reads).toBe(1);

    clock += 6000;
    await review.findApproval(DIGEST);
    expect(reads).toBe(2);
  });

  it('re-reads immediately when invalidated', async () => {
    let reads = 0;
    const review = new ConstitutionReviewService({
      domain: mockDomain({
        agents: [
          {
            id: 'did:ixo:entity:test',
            forbidden_outputs: [],
            escalation: { human_role: 'steward', matrix_room: ROOM },
          },
        ],
      }),
      transport: {
        sendEvent: async () => '$e',
        getRoomState: async () => {
          reads += 1;
          return [approval()];
        },
      },
      logger: silentLogger(),
      selfMatrixUserId: SELF,
      cacheTtlMs: 60_000,
    });

    await review.findApproval(DIGEST);
    review.invalidate();
    await review.findApproval(DIGEST);
    expect(reads).toBe(2);
  });
});
