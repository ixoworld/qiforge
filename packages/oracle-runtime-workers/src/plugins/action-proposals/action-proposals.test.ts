import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  assertActionProposalUnchanged,
  digestActionProposal,
  type ActionProposalSubject,
} from '@ixo/ixo-transaction/action-proposals';
import { ActionProposalConflict } from '../../action-proposals/store';
import { makeRuntimeContext } from '../../core/test-fixtures';
import {
  TURN_TIME_NOTE_KWARG,
  withTurnTimeNote,
} from '../../core/turn-time-note';
import {
  prepareAction,
  ActionProposalsPlugin,
  ACTION_INTENT_DECISION,
} from './action-proposals.plugin';
import { OWNER, RECIPIENT } from '../../action-proposals/fixtures/proposal';
import { draftReplyPlan, materializeReplyPlan } from '../../delivery/plan';
import { resolveDeliveryProfile } from '../../delivery/profile';
import { parseReplyPlan, planText } from '../../delivery/schema';

const args = {
  action: 'transfer',
  network: 'testnet',
  recipient: RECIPIENT,
  amount: '1.5',
  unit: 'IXO',
};
const credit = {
  action: 'transfer_credit',
  network: 'testnet',
  recipient: RECIPIENT,
  amount: '10',
  tokenId: 'CARBON-1',
};
function context(message = `Send 1.5 IXO to ${RECIPIENT} on testnet`) {
  const create = vi.fn(async (subject: ActionProposalSubject) => ({
    ...subject,
    digest: await digestActionProposal(subject),
    lifecycle: { status: 'prepared' as const },
  }));
  const evaluate = vi.fn(async () => ({
    decision: { name: ACTION_INTENT_DECISION.name, version: '1.0.0' },
    provider: 'fake',
    model: 'fixture',
    answers: {
      intent: {
        kind: 'choice' as const,
        value: 'requested',
        confidence: 0.99,
        probabilities: { requested: 0.99, clarify: 0.01 },
      },
    },
    evaluatedAt: new Date().toISOString(),
    latencyMs: 1,
  }));
  const ctx = makeRuntimeContext({
    config: {
      ACTION_PROPOSALS_ENABLED: 'true',
      ACTION_PROPOSALS_PORTAL_ORIGIN: 'https://portal.test',
    },
    user: {
      did: OWNER,
      matrixUserId: '@owner:test',
      ucanDelegation: { raw: 'delegation' },
    },
    session: {
      id: 'session-1',
      runId: 'run-1',
      requestId: 'request-1',
      client: 'channel',
    },
    toolCallId: 'call-1',
    actionProposals: { create },
    decisions: { evaluate, evaluateByName: vi.fn() },
    history: {
      messages: [new HumanMessage(message)],
      recent: () => [],
      userContext: {},
      state: { messages: [] },
    },
  });
  return { ctx, create, evaluate };
}
describe('validated conversational actions', () => {
  it('is default-off and does not call a browser to prepare a frozen native transfer', async () => {
    expect(new ActionProposalsPlugin().autoDetect({})).toBe(false);
    const { ctx, create, evaluate } = context();
    const result = await prepareAction(args, ctx);
    expect(result.status).toBe('prepared');
    expect(create).toHaveBeenCalledOnce();
    const subject = create.mock.calls[0]![0];
    expect(subject.action.inputs.messages).toEqual([
      {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: OWNER.slice(8),
          toAddress: RECIPIENT,
          amount: [{ denom: 'uixo', amount: '1500000' }],
        },
      },
    ]);
    expect(subject.origin).toEqual({
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'run-1:call-1',
    });
    // The memo the owner signs is the card's id; the classifier sees the
    // user's own figures next to the atomic ones.
    expect(subject.action.inputs.memo).toBe(subject.id);
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(
      ACTION_INTENT_DECISION,
      expect.objectContaining({
        candidate: expect.objectContaining({
          requested: { amount: '1.5', unit: 'IXO' },
        }),
      }),
    );
    expect(subject.expiresAt).not.toEqual(subject.createdAt);
    const stored = await create.mock.results[0]!.value;
    expect(await assertActionProposalUnchanged(stored)).toEqual(stored);
    expect(result.status === 'prepared' && result.action.url).toBe(
      `https://portal.test/a/${subject.id}`,
    );
  });
  it.each([
    `Don't send 1.5 IXO to ${RECIPIENT} on testnet`,
    `What if I send 1.5 IXO to ${RECIPIENT} on testnet`,
    'Send some tokens',
    'Send 1.5 IXO on testnet',
    // The figure without its unit, the unit a million times off, the figure
    // inside a longer number, and a prefix of the address are not evidence.
    `Send 1.5 to ${RECIPIENT} on testnet, in IXO please`,
    `Send 1.5 uixo to ${RECIPIENT} from my IXO wallet on testnet`,
    `Send 11.5 IXO to ${RECIPIENT} on testnet`,
    `Send 1.5 IXO to ${RECIPIENT}abc on testnet`,
  ])('clarifies unsupported evidence %s', async (message) => {
    const { ctx, create, evaluate } = context(message);
    expect((await prepareAction(args, ctx)).status).toBe(
      'clarification_required',
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('never reads the turn time note as evidence', async () => {
    const note = 'Current time: Saturday, 2026-10-03 14:05 (Europe/Berlin)';
    const { ctx, create, evaluate } = context();
    ctx.history.messages = [
      new HumanMessage({
        content: withTurnTimeNote(
          `Send 14 IXO to ${RECIPIENT} on testnet`,
          note,
        ),
        additional_kwargs: { [TURN_TIME_NOTE_KWARG]: note },
      }),
    ];
    expect((await prepareAction({ ...args, amount: '14' }, ctx)).status).toBe(
      'prepared',
    );
    expect(evaluate).toHaveBeenCalledWith(
      ACTION_INTENT_DECISION,
      expect.objectContaining({
        message: `Send 14 IXO to ${RECIPIENT} on testnet`,
      }),
    );
    // A clock time is not an amount: without a unit beside it no digit
    // counts, note or no note.
    ctx.history.messages = [
      new HumanMessage({
        content: withTurnTimeNote(`Send IXO to ${RECIPIENT} on testnet`, note),
        additional_kwargs: { [TURN_TIME_NOTE_KWARG]: note },
      }),
    ];
    expect((await prepareAction({ ...args, amount: '14' }, ctx)).status).toBe(
      'clarification_required',
    );
    expect(create).toHaveBeenCalledOnce();
  });
  it.each([
    `Transfer 10 CARBON-1 credits to ${RECIPIENT} on testnet`,
    `Transfer 10 CARBON-1 to ${RECIPIENT} on testnet`,
  ])('prepares a credit transfer from %s', async (message) => {
    const { ctx, create } = context(message);
    expect((await prepareAction(credit, ctx)).status).toBe('prepared');
    expect(create.mock.calls[0]![0].action.inputs.messages[0]!.value).toEqual({
      owner: OWNER.slice(8),
      recipient: RECIPIENT,
      tokens: [{ id: 'CARBON-1', amount: '10' }],
    });
  });
  it.each([
    `Transfer 10 CARBON-10 credits to ${RECIPIENT} on testnet`,
    `Transfer 100 CARBON-1 credits to ${RECIPIENT} on testnet`,
    `Transfer ten CARBON-1 credits to ${RECIPIENT} on testnet`,
  ])(
    'clarifies credit evidence without the exact token and count %s',
    async (message) => {
      const { ctx, create, evaluate } = context(message);
      expect((await prepareAction(credit, ctx)).status).toBe(
        'clarification_required',
      );
      expect(evaluate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each([
    [`Send 1 500 IXO to ${RECIPIENT} on testnet`, '500'],
    [`Send 1'500 IXO to ${RECIPIENT} on testnet`, '500'],
    [`Send 1/5 IXO to ${RECIPIENT} on testnet`, '5'],
    [`Send 1:5 IXO to ${RECIPIENT} on testnet`, '5'],
    [`Send 1  500 IXO to ${RECIPIENT} on testnet`, '500'],
    [`Send 1 ,500 IXO to ${RECIPIENT} on testnet`, '500'],
    [
      `Send 1${String.fromCharCode(0xa0)}500 IXO to ${RECIPIENT} on testnet`,
      '500',
    ],
  ])(
    'never reads the tail of a grouped or divided number as the amount (%s)',
    async (message, amount) => {
      const { ctx, create, evaluate } = context(message);
      expect((await prepareAction({ ...args, amount }, ctx)).status).toBe(
        'clarification_required',
      );
      expect(evaluate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('tells the user the owner object policy that refused the card', async () => {
    const { ctx } = context();
    ctx.actionProposals = {
      create: vi
        .fn()
        .mockRejectedValue(
          new ActionProposalConflict(
            'Action cards are prepared in direct chats only',
          ),
        ),
    };
    expect(await prepareAction(args, ctx)).toEqual({
      status: 'clarification_required',
      reason: 'Action cards are prepared in direct chats only',
    });
  });
  it('accepts a current confirmation with exact prior user evidence in the same session', async () => {
    const { ctx, create, evaluate } = context('Yes, send it on testnet.');
    ctx.history.messages = [
      new HumanMessage(`Prepare 1.5 IXO for ${RECIPIENT} on testnet`),
      new HumanMessage('Yes, send it on testnet.'),
    ];
    expect((await prepareAction(args, ctx)).status).toBe('prepared');
    expect(create).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(
      ACTION_INTENT_DECISION,
      expect.objectContaining({ message: 'Yes, send it on testnet.' }),
    );
  });
  it('fails closed for missing, malformed, ambiguous and unavailable semantic judgment', async () => {
    for (const answer of [
      undefined,
      { kind: 'boolean', probabilityTrue: 1 },
      {
        kind: 'choice',
        value: 'clarify',
        confidence: 1,
        probabilities: { clarify: 1 },
      },
      {
        kind: 'choice',
        value: 'requested',
        confidence: 0.5,
        probabilities: { requested: 0.5 },
      },
    ]) {
      const { ctx, create } = context();
      ctx.decisions.evaluate = vi.fn(async () => ({
        decision: { name: 'companion.action-intent', version: '1' },
        provider: 'fake',
        model: 'fake',
        answers: answer ? { intent: answer } : {},
        latencyMs: 0,
        evaluatedAt: new Date().toISOString(),
      })) as typeof ctx.decisions.evaluate;
      expect((await prepareAction(args, ctx)).status).toBe(
        'clarification_required',
      );
      expect(create).not.toHaveBeenCalled();
    }
    const { ctx, create } = context();
    ctx.decisions.evaluate = vi
      .fn()
      .mockRejectedValue(new Error('provider unavailable'));
    expect((await prepareAction(args, ctx)).status).toBe(
      'clarification_required',
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('refuses unsupported topics, unknown identity resolution and disabled preparation', async () => {
    const { ctx, create } = context();
    expect(
      (await prepareAction({ action: 'create_topic', network: 'testnet' }, ctx))
        .status,
    ).toBe('clarification_required');
    ctx.user.did = 'did:ixo:entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect((await prepareAction(args, ctx)).status).toBe(
      'clarification_required',
    );
    ctx.config.ACTION_PROPOSALS_ENABLED = 'false';
    expect((await prepareAction(args, ctx)).status).toBe(
      'clarification_required',
    );
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['ixo1oooooooooooooooooooo', `${RECIPIENT.slice(0, -1)}q`])(
    'clarifies invalid signer and recipient accounts before semantic evaluation %s',
    async (address) => {
      const recipient = context(`Send 1.5 IXO to ${address} on testnet`);
      expect(
        (await prepareAction({ ...args, recipient: address }, recipient.ctx))
          .status,
      ).toBe('clarification_required');
      expect(recipient.evaluate).not.toHaveBeenCalled();
      expect(recipient.create).not.toHaveBeenCalled();
      const signer = context();
      signer.ctx.user.did = `did:ixo:${address}`;
      expect((await prepareAction(args, signer.ctx)).status).toBe(
        'clarification_required',
      );
      expect(signer.evaluate).not.toHaveBeenCalled();
      expect(signer.create).not.toHaveBeenCalled();
    },
  );
  it('preserves the action in the ordered durable channel plan and text fallback', async () => {
    const { ctx } = context();
    const result = await prepareAction(args, ctx);
    if (result.status !== 'prepared') throw new Error('expected proposal');
    const profile = resolveDeliveryProfile({
      client: 'channel',
      channel: {
        provider: 'whatsapp',
        bindingId: 'chb_x',
        remoteMessageRef: 'hmac:x',
      },
    });
    if (profile.kind !== 'chat') throw new Error('expected chat');
    const draft = draftReplyPlan({
      steps: [
        {
          text: '',
          toolCalls: [{ id: 'call-1', name: 'prepare_action', args }],
        },
        { text: 'Review and sign when ready.', toolCalls: [] },
      ],
      toolResults: new Map([['call-1', JSON.stringify(result)]]),
      limits: profile.limits,
      canSpill: false,
    });
    const plan = await materializeReplyPlan(draft, {
      limits: profile.limits,
      createSpill: vi.fn(),
    });
    expect(plan.parts.map((p) => p.kind)).toEqual(['action', 'text']);
    expect(parseReplyPlan(JSON.stringify(plan))).toEqual(plan);
    expect(planText(plan)).toContain(result.action.url);
  });
});
