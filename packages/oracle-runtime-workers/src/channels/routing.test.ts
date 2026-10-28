import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChannelTurnInput, ChannelTurnOutcome } from './contract';
import {
  ambiguousThreadText,
  multipleIntentsText,
  channelRoutingConfig,
} from './routing';
import type { TurnRequest } from '../do/contracts';
import type { ChannelTurnsTestDO } from './test-do';

const input: ChannelTurnInput = {
  provider: 'whatsapp',
  bindingId: 'chb_one',
  bindingRevision: 1,
  requestId: 'wa:first',
  remoteMessageRef: `hmac:${'a'.repeat(64)}`,
  message: 'Help me complete my school application',
  context: { kind: 'companion' },
};
function accepted(outcome: ChannelTurnOutcome) {
  if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
  return outcome.result;
}
async function runningRequest(
  stub: DurableObjectStub<ChannelTurnsTestDO>,
  runId: string,
): Promise<TurnRequest> {
  const run = await stub.run(runId);
  if (!run) throw new Error('Missing run');
  return JSON.parse(run.request);
}
async function waitForRouting(stub: DurableObjectStub<ChannelTurnsTestDO>) {
  for (let i = 0; i < 100; i++) {
    if ((await stub.routingInputs()).length) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Router never evaluated');
}

describe('channel-only semantic sessions', () => {
  it('validates flags, binding IDs, and experimental thresholds at configuration', () => {
    expect(channelRoutingConfig.parse({})).toMatchObject({
      CHANNEL_SEMANTIC_ROUTING: 'off',
      CHANNEL_SEMANTIC_ROUTING_MIN_PROBABILITY: 0.9,
    });
    for (const invalid of [
      { CHANNEL_SEMANTIC_ROUTING: 'enabled' },
      { CHANNEL_SEMANTIC_ROUTING_MIN_PROBABILITY: '0.2' },
      { CHANNEL_SEMANTIC_ROUTING_BINDINGS: 'a-phone-number' },
    ])
      expect(channelRoutingConfig.safeParse(invalid).success).toBe(false);
  });
  it('defaults off and allows test-binding opt-in without evaluating other bindings', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-off');
    const first = accepted(await stub.submit(input));
    await stub.routeAs('new_thread');
    expect(
      accepted(await stub.submit({ ...input, requestId: 'wa:second' }))
        .sessionId,
    ).toBe(first.sessionId);
    await stub.configureRouting('on', ['chb_test_only']);
    expect(
      accepted(await stub.submit({ ...input, requestId: 'wa:third' }))
        .sessionId,
    ).toBe(first.sessionId);
    expect(await stub.routingInputs()).toEqual([]);
  });

  it('continues, starts an independent thread, and returns to an older thread without cancelling work', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-goals');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.setSessionInfo(first.sessionId, {
      title: '  Grant *application*_\n`2027`\u200B ',
    });
    await stub.routeAs('thread_0');
    const followup = accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:followup',
        message: 'Now submit it',
      }),
    );
    expect(followup.sessionId).toBe(first.sessionId);
    await stub.routeAs('new_thread');
    const trip = accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:trip',
        sessionId: first.sessionId,
        message: 'Separate question: plan my trip',
      }),
    );
    expect(trip.sessionId).not.toBe(first.sessionId);
    expect((await stub.run(first.runId))?.status).toBe('running');
    await stub.routeAs('thread_1');
    const back = accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:back',
        sessionId: trip.sessionId,
        message: 'Back to the application',
      }),
    );
    expect(back.sessionId).toBe(first.sessionId);
    expect((await stub.run(trip.runId))?.status).toBe('running');
    await stub.finish(back.runId);
    expect(
      accepted(
        await stub.submit({
          ...input,
          requestId: 'wa:back',
          sessionId: trip.sessionId,
          message: 'Back to the application',
        }),
      ).text,
    ).toBe(
      'Back to *Grant application 2027*. Send /resume to pick another topic.\n\nOne answer',
    );
  });

  it('names the topic being left in the fresh-topic notice, and says so when it is untitled', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-fresh-notice');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.routeAs('new_thread');
    const trip = accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:trip',
        sessionId: first.sessionId,
        message: 'Separate question: plan my trip',
      }),
    );
    await stub.finish(trip.runId);
    const again = {
      ...input,
      requestId: 'wa:trip',
      sessionId: first.sessionId,
      message: 'Separate question: plan my trip',
    };
    expect(accepted(await stub.submit(again)).text).toBe(
      'Starting a fresh topic for this. Send /resume to go back to an earlier topic.\n\nOne answer',
    );
    await stub.setSessionInfo(first.sessionId, {
      title: '  Grant *application*_\n`2027`\u200B ',
    });
    expect(accepted(await stub.submit(again)).text).toBe(
      'Starting a fresh topic for this. Send /resume and pick *Grant application 2027* to go back.\n\nOne answer',
    );
  });

  it('records shadow verdicts without changing the thread or waiting for the provider', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-shadow');
    await stub.configureRouting('shadow');
    const first = accepted(await stub.submit(input));
    await stub.routeAs('new_thread');
    await stub.blockRouting(true);
    const shadowInput = { ...input, requestId: 'wa:shadow' };
    const next = accepted(await stub.submit(shadowInput));
    expect(next.sessionId).toBe(first.sessionId);
    await waitForRouting(stub);
    await stub.blockRouting(false);
    for (let i = 0; i < 100; i++) {
      if ((await stub.receipt(shadowInput.requestId))?.routing_observation)
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      (await stub.receipt(shadowInput.requestId))?.routing_observation,
    ).toContain('new-goal');
    expect((await stub.receipt(shadowInput.requestId))?.routing_json).toContain(
      first.sessionId,
    );
  });

  it.each([
    ['ambiguous', 0.99, ambiguousThreadText],
    ['new_thread', 0.6, ambiguousThreadText],
    ['multiple_intents', 0.99, multipleIntentsText],
  ])(
    'clarifies %s instead of creating a thread or executing the requested action',
    async (choice, probability, text) => {
      const stub = env.CHANNEL_TURNS_TEST.getByName(
        `routing-clarify-${choice}`,
      );
      await stub.configureRouting('on');
      const first = accepted(await stub.submit(input));
      await stub.routeAs(choice, probability);
      const next = accepted(
        await stub.submit({ ...input, requestId: 'wa:yes', message: 'Yes' }),
      );
      expect(next.sessionId).toBe(first.sessionId);
      expect(
        (await runningRequest(stub, next.runId)).channel?.routingClarification,
      ).toContain(text);
      expect((await stub.hostCalls()).createSession).toBe(1);
    },
  );

  it('keeps the message in the current conversation when the classifier fails', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-provider-down');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.routeAs('error');
    const next = accepted(
      await stub.submit({ ...input, requestId: 'wa:down', message: 'Yes' }),
    );
    expect(next.sessionId).toBe(first.sessionId);
    expect(
      (await runningRequest(stub, next.runId)).channel?.routingClarification,
    ).toBeUndefined();
    expect((await stub.receipt('wa:down'))?.routing_observation).toContain(
      'provider-unavailable',
    );
    expect((await stub.hostCalls()).createSession).toBe(1);
  });

  it('resumes an owned quoted thread before inference, including a split reply bubble', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-quote');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.finish(first.runId, {
      v: 1,
      parts: [{ partId: 'p1', kind: 'text', text: 'Which school?' }],
    });
    await stub.routeAs('new_thread');
    const other = accepted(
      await stub.submit({ ...input, requestId: 'wa:other' }),
    );
    const before = (await stub.routingInputs()).length;
    const quoted = accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:quote',
        sessionId: other.sessionId,
        replyTo: {
          kind: 'known',
          author: 'oracle',
          requestId: input.requestId,
          partId: 'p1.2',
        },
        message: 'The local school',
      }),
    );
    expect(quoted.sessionId).toBe(first.sessionId);
    expect(
      (await runningRequest(stub, quoted.runId)).channel?.replyContext,
    ).toMatchObject({ kind: 'resolved', text: 'Which school?' });
    expect((await stub.routingInputs()).length).toBe(before);
  });

  it('does not route a quote across bindings or consent revisions', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-isolation');
    await stub.configureRouting('on');
    accepted(await stub.submit(input));
    const other = accepted(
      await stub.submit({
        ...input,
        bindingId: 'chb_other',
        requestId: 'wa:other',
        replyTo: { kind: 'known', author: 'user', requestId: input.requestId },
      }),
    );
    expect(
      (await runningRequest(stub, other.runId)).channel?.routingClarification,
    ).toBe(ambiguousThreadText);
    const revision = accepted(
      await stub.submit({
        ...input,
        bindingRevision: 2,
        requestId: 'wa:revision',
        replyTo: { kind: 'known', author: 'user', requestId: input.requestId },
      }),
    );
    expect(
      (await runningRequest(stub, revision.runId)).channel
        ?.routingClarification,
    ).toBe(ambiguousThreadText);
    expect(await stub.routingInputs()).toEqual([]);
  });

  it('honors explicit new/resume and interrupt corrections before semantic routing', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-controls');
    await stub.configureRouting('on');
    accepted(await stub.submit(input));
    await stub.routeAs('new_thread');
    const control = await stub.control({
      provider: 'whatsapp',
      bindingId: input.bindingId,
      bindingRevision: 1,
      requestId: 'wa:new',
      command: { kind: 'new' },
      cancelRequestIds: [],
    });
    if (!control.ok) throw new Error('Control refused');
    const next = accepted(
      await stub.submit({ ...input, requestId: 'wa:after-new' }),
    );
    expect(next.sessionId).toBe(control.result.sessionId);
    const correction = accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:correction',
        sessionPolicy: 'continue',
        message: 'Use Friday instead',
      }),
    );
    expect(correction.sessionId).toBe(next.sessionId);
    expect(await stub.routingInputs()).toEqual([]);
  });

  it('persists assignment before begin and reuses it after SQLite reopen and switching the flag off', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-durable');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.routeAs('new_thread');
    await stub.failBeginOnce();
    const nextInput = {
      ...input,
      requestId: 'wa:durable',
      sessionId: first.sessionId,
    };
    expect(await stub.submit(nextInput)).toMatchObject({
      ok: false,
      status: 503,
    });
    const receipt = await stub.receipt(nextInput.requestId);
    expect(receipt?.routing_json).toContain('new-goal');
    await stub.configureRouting('off');
    const recovered = accepted(await stub.submit(nextInput));
    expect(recovered.sessionId).toBe(receipt?.session_id);
    expect(recovered.sessionId).not.toBe(first.sessionId);
    expect(await stub.routingInputs()).toHaveLength(1);
    expect(accepted(await stub.submit(nextInput)).runId).toBe(recovered.runId);
  });

  it('allows a stop while inference waits and prevents the delayed decision from starting work', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-stop-race');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.blockRouting(true);
    const pendingInput = { ...input, requestId: 'wa:pending' };
    const pending = stub.submit(pendingInput);
    await waitForRouting(stub);
    expect(
      await stub.control({
        provider: 'whatsapp',
        bindingId: input.bindingId,
        bindingRevision: 1,
        requestId: 'wa:stop',
        command: { kind: 'stop' },
        cancelRequestIds: [pendingInput.requestId],
      }),
    ).toMatchObject({ ok: true });
    await stub.blockRouting(false);
    expect(await pending).toMatchObject({
      ok: false,
      code: 'request_cancelled',
    });
    expect(await stub.count()).toBe(1);
    expect(await stub.boundSession(input.bindingId)).toBe(first.sessionId);
  });

  it('classifies simultaneous duplicates once and gives both the durable destination', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-duplicates');
    await stub.configureRouting('on');
    accepted(await stub.submit(input));
    await stub.routeAs('new_thread');
    const next = { ...input, requestId: 'wa:duplicate' };
    const [left, right] = await Promise.all([
      stub.submit(next),
      stub.submit(next),
    ]);
    expect(accepted(left)).toEqual(accepted(right));
    expect(await stub.routingInputs()).toHaveLength(1);
    expect(await stub.count()).toBe(2);
  });

  it('runs a message in the new session when an explicit session switch completes during its inference', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-session-race');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.blockRouting(true);
    const pending = stub.submit({ ...input, requestId: 'wa:before-new' });
    await waitForRouting(stub);
    const control = await stub.control({
      provider: 'whatsapp',
      bindingId: input.bindingId,
      bindingRevision: 1,
      requestId: 'wa:new',
      command: { kind: 'new' },
      cancelRequestIds: [],
    });
    if (!control.ok) throw new Error('Control refused');
    await stub.blockRouting(false);
    const ran = accepted(await pending);
    expect(ran.sessionId).toBe(control.result.sessionId);
    expect(await stub.boundSession(input.bindingId)).toBe(
      control.result.sessionId,
    );
    // Nothing was cancelled, and the stale assignment is gone.
    expect((await stub.receipt('wa:before-new'))?.routing_json).toBeNull();
    expect(await stub.count()).toBe(2);
    expect((await stub.run(first.runId))?.status).toBe('running');
  });

  it('bounds candidate state, excludes other bindings, and can quote a thread outside the recency pool', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-bounds');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.submit({
      ...input,
      bindingId: 'chb_other',
      message: 'PRIVATE_OTHER_BINDING',
    });
    await stub.routeAs('new_thread');
    for (let i = 0; i < 25; i++)
      accepted(
        await stub.submit({
          ...input,
          requestId: `wa:topic-${i}`,
          message: `Independent goal ${i}`,
        }),
      );
    expect(await stub.indexedSessions()).toHaveLength(25); // 24 in chb_one, one in chb_other.
    expect(await stub.indexedSessions()).not.toContain(first.sessionId);
    for (const evidence of await stub.routingInputs()) {
      expect(evidence).not.toContain('PRIVATE_OTHER_BINDING');
      expect(JSON.parse(evidence).threads.length).toBeLessThanOrEqual(8);
    }
    const quoted = accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:old-quote',
        replyTo: { kind: 'known', author: 'user', requestId: input.requestId },
      }),
    );
    expect(quoted.sessionId).toBe(first.sessionId);
  });

  it('reconciles messages received while off when routing is enabled again', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-reenable');
    await stub.configureRouting('on');
    accepted(await stub.submit(input));
    await stub.configureRouting('off');
    accepted(
      await stub.submit({
        ...input,
        requestId: 'wa:while-off',
        message: 'Updated application details while routing was off',
      }),
    );
    await stub.configureRouting('on');
    accepted(await stub.submit({ ...input, requestId: 'wa:reenable' }));
    expect((await stub.routingInputs()).at(-1)).toContain(
      'Updated application details while routing was off',
    );
  });

  it('treats an unreadable stored assignment as no routing', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-unreadable');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.routeAs('new_thread');
    await stub.failBeginOnce();
    const nextInput = { ...input, requestId: 'wa:unreadable' };
    expect(await stub.submit(nextInput)).toMatchObject({ ok: false });
    await stub.corruptStored('channel_requests', nextInput.requestId);
    const recovered = accepted(await stub.submit(nextInput));
    expect(recovered.sessionId).toBe(
      (await stub.receipt(nextInput.requestId))?.session_id,
    );
    expect(recovered.sessionId).not.toBe(first.sessionId);
    // A readable new-goal assignment would add the fresh-topic cue.
    await stub.finish(recovered.runId);
    expect(accepted(await stub.submit(nextInput)).text).toBe('One answer');
  });

  it('removes deleted sessions from the routing index even with routing disabled', async () => {
    const stub = env.CHANNEL_TURNS_TEST.getByName('routing-delete-off');
    await stub.configureRouting('on');
    const first = accepted(await stub.submit(input));
    await stub.configureRouting('off');
    await stub.deleteSession(first.sessionId);
    expect(await stub.indexedSessions()).toEqual([]);
  });
});
