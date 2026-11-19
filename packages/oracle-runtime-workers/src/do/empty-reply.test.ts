import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import {
  CHANNEL_EMPTY_REPLY_DEFAULT,
  EMPTY_REPLY_KIND,
  EMPTY_REPLY_NUDGE,
} from '../channels/busy-reply';
import { CHANNEL_DELIVERY_NOTICE_KWARG } from '../channels/replies';
import { resolveDeliveryProfile } from '../delivery/profile';
import type { DeliveryProfile } from '../delivery/types';
import type { ChannelFailureInfo } from '../plugin-api/oracle-plugin';
import type { TurnRequest } from './contracts';
import { storedRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

const channelRequest: TurnRequest = {
  identity: { userDid: 'did:ixo:owner', matrixUserId: '@owner:example.org' },
  sessionId: 'session',
  message: 'Done',
  client: 'channel',
  requestId: 'request',
  channel: {
    provider: 'whatsapp',
    bindingId: 'chb_x',
    bindingRevision: 1,
    remoteMessageRef: 'x',
  },
};

const chat = resolveDeliveryProfile({
  client: 'channel',
  channel: { provider: 'whatsapp', bindingId: 'chb_x', remoteMessageRef: 'x' },
});

/** The graph's end: the thread's messages, as `tapMessages` reads them. */
function graphEnd(messages: BaseMessage[]) {
  return { event: 'on_chain_end', data: { output: { messages } } };
}

/**
 * The real `runAttempt` over a prepared channel turn whose model answers
 * with `replies` in turn (one per graph invocation: the turn, then the
 * retry). An empty string is the empty message that leaves the turn silent.
 */
function channelRun(input: {
  replies: string[];
  request?: TurnRequest;
  delivery?: DeliveryProfile;
  env?: Record<string, unknown>;
  failureReply?: (failure: ChannelFailureInfo) => string | undefined;
}) {
  const core = createRuntimeCore({
    config: { name: 'Test', org: 'Test', description: 'Test' },
    plugins: [],
    env: makeEnv(input.env),
  });
  if (input.failureReply) {
    const reply = input.failureReply;
    Object.defineProperty(core, 'plugins', {
      value: [
        {
          name: 'test-fallback',
          channelFailureReply: (_ctx: unknown, failure: ChannelFailureInfo) =>
            reply(failure),
        },
      ],
    });
  }
  const Oracle = createUserOracleDO({ core: () => core, hooks: {} });
  const host: object = Object.create(Oracle.prototype);
  const setPlan = vi.fn(async (_runId: string, _plan: string) => undefined);
  const inputs: unknown[] = [];
  const thread: BaseMessage[] = [new HumanMessage('Done')];
  let call = 0;
  Object.assign(host, {
    env: {},
    ctx: {
      waitUntil: vi.fn(),
      storage: {
        sync: vi.fn(async () => undefined),
        get: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    },
    userDid: 'did:ixo:owner',
    channelTurns: {
      isCancelled: vi.fn(async () => false),
      choices: { record: vi.fn(async () => undefined) },
    },
    aborts: new Map(),
    delegations: new Map([
      [
        'did:ixo:owner',
        { raw: 'ucan', expiration: Math.floor(Date.now() / 1000) + 86_400 },
      ],
    ]),
    runs: { touchKeepAlive: vi.fn() },
    events: { register: vi.fn(), unregister: vi.fn(), emitToTaps: vi.fn() },
    runStore: {
      update: vi.fn(async () => undefined),
      setPlan,
      listMarks: vi.fn(async () => []),
    },
    ready: vi.fn(async () => undefined),
    afterTurn: vi.fn(async () => undefined),
    pluginHookContext: vi.fn(async () => ({})),
    runTurnDisposables: vi.fn(async () => undefined),
    prepareTurn: vi.fn(async () => ({
      agent: {
        async *streamEvents(graphInput: unknown) {
          inputs.push(graphInput);
          const nudge = (graphInput as { messages?: BaseMessage[] } | null)
            ?.messages?.[0];
          if (call > 0 && nudge) thread.push(nudge);
          thread.push(new AIMessage(input.replies[call] ?? ''));
          call += 1;
          yield graphEnd([...thread]);
        },
      },
      stateInput: { messages: [thread[0]] },
      config: {},
      turnDisposables: [],
      delivery: input.delivery ?? chat,
      usage: () => '{}',
      toolOutputCapChars: 1000,
    })),
  });
  const request = input.request ?? channelRequest;
  const live = {
    runId: 'run',
    sessionId: request.sessionId,
    requestId: request.requestId,
    record: {
      request: JSON.stringify({
        ...storedRunRequest(request),
        disposition: { kind: 'agent' },
      }),
    },
    buffer: { isClosed: false, push: vi.fn() },
    abort: new AbortController(),
    continuation: null,
    attemptSource: 'begin',
  };
  const attempt = (): Promise<unknown> =>
    Reflect.apply(Reflect.get(host, 'runAttempt'), host, [live, false]);
  return { attempt, setPlan, inputs };
}

describe('a channel turn whose reply came out empty', () => {
  it('asks the model once more with a hidden note, and sends its answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { attempt, inputs } = channelRun({
      replies: ['', 'Your identity check has started.'],
    });
    const outcome = await attempt();
    expect(outcome).toMatchObject({
      status: 'finished',
      plan: {
        parts: [{ kind: 'text', text: 'Your identity check has started.' }],
      },
    });
    expect(inputs).toHaveLength(2);
    const nudge = (inputs[1] as { messages: BaseMessage[] }).messages[0];
    expect(nudge?.content).toBe(EMPTY_REPLY_NUDGE);
    // A delivery notice: never shown or remembered as the person's words.
    expect(nudge?.additional_kwargs[CHANNEL_DELIVERY_NOTICE_KWARG]).toBe(
      EMPTY_REPLY_NUDGE,
    );
    expect(JSON.stringify(warn.mock.calls)).toContain(
      `the model's reply was empty (${EMPTY_REPLY_KIND}); asking it once more`,
    );
    vi.restoreAllMocks();
  });

  it("still empty: the oracle's fallback line, told empty_reply, logged with its own code", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const seen: ChannelFailureInfo[] = [];
    const { attempt, setPlan, inputs } = channelRun({
      replies: ['', ''],
      failureReply: (failure) => {
        seen.push(failure);
        return 'Sorry, I am a bit busy. Try again soon.';
      },
    });
    const plan = {
      v: 1,
      parts: [
        {
          partId: EMPTY_REPLY_KIND,
          kind: 'text',
          text: 'Sorry, I am a bit busy. Try again soon.',
        },
      ],
    };
    expect(await attempt()).toMatchObject({ status: 'finished', plan });
    expect(inputs).toHaveLength(2);
    expect(seen).toEqual([{ kind: 'empty_reply' }]);
    expect(setPlan).toHaveBeenLastCalledWith('run', JSON.stringify(plan));
    expect(JSON.stringify(warn.mock.calls)).toContain(
      `the model's reply was empty after a retry (${EMPTY_REPLY_KIND}); sent the fallback line`,
    );
    vi.restoreAllMocks();
  });

  it('without a plugin line: CHANNEL_BUSY_REPLY, else the default', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await channelRun({ replies: ['', ''] }).attempt()).toMatchObject({
      plan: { parts: [{ text: CHANNEL_EMPTY_REPLY_DEFAULT }] },
    });
    expect(
      await channelRun({
        replies: ['', ''],
        env: { CHANNEL_BUSY_REPLY: 'Eish, try again soon.' },
      }).attempt(),
    ).toMatchObject({ plan: { parts: [{ text: 'Eish, try again soon.' }] } });
    vi.restoreAllMocks();
  });

  it('an event turn is answered the same way (the gateway sends only while the window is open)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { attempt, inputs } = channelRun({
      replies: ['', 'Here is your link.'],
      request: {
        ...channelRequest,
        message: '',
        channel: {
          ...channelRequest.channel!,
          eventNote: '[Identity check update; this is not a message.]',
        },
      },
    });
    expect(await attempt()).toMatchObject({
      status: 'finished',
      plan: { parts: [{ text: 'Here is your link.' }] },
    });
    expect(inputs).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('a reply with text is sent as it is, with no second call', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { attempt, inputs } = channelRun({ replies: ['Thanks!'] });
    expect(await attempt()).toMatchObject({
      status: 'finished',
      plan: { parts: [{ text: 'Thanks!' }] },
    });
    expect(inputs).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('a turn that is not a channel turn is left as it was', async () => {
    const { attempt, inputs } = channelRun({
      replies: [''],
      request: {
        ...channelRequest,
        client: 'matrix',
        roomId: '!r:example.org',
        channel: undefined,
      },
      delivery: { kind: 'stream' },
    });
    const outcome = await attempt();
    expect(outcome).toMatchObject({ status: 'finished' });
    expect(Reflect.get(outcome as object, 'plan')).toBeUndefined();
    expect(inputs).toHaveLength(1);
  });
});
