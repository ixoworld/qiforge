import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import {
  CHANNEL_BUSY_REPLY_COOLDOWN_MS,
  CHANNEL_BUSY_REPLY_DEFAULT,
  busyReplyKey,
} from '../channels/busy-reply';
import { resolveDeliveryProfile } from '../delivery/profile';
import type { DeliveryProfile } from '../delivery/types';
import { attachModelCall, type ModelCallRecord } from '../llm/model-call';
import type { TurnRequest } from './contracts';
import { storedRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

const channelRequest: TurnRequest = {
  identity: { userDid: 'did:ixo:owner', matrixUserId: '@owner:example.org' },
  sessionId: 'session',
  message: 'Hi',
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

/** The record the platform model puts on the error of a key-limit failure. */
const KEY_LIMIT: ModelCallRecord = {
  role: 'main',
  requestedModel: 'openai/gpt-5.6-luna',
  fallback: false,
  modelFallback: false,
  providerFallback: false,
  durationMs: 120,
  ok: false,
  errorKind: 'auth',
  errorStatus: 403,
};

function keyLimitError(): Error {
  const error = new Error('403 Key limit exceeded (daily limit)');
  attachModelCall(error, KEY_LIMIT);
  // LangChain's middleware layers wrap what the model threw.
  return new Error('Model call failed', { cause: error });
}

/**
 * The real `runAttempt` over a prepared channel turn whose model call fails
 * with `error`, as `failed-run-files.test.ts` drives it.
 */
function failingChannelRun(input: {
  error: unknown;
  storage?: Map<string, unknown>;
  env?: Record<string, unknown>;
  request?: TurnRequest;
  delivery?: DeliveryProfile;
}) {
  const core = createRuntimeCore({
    config: { name: 'Test', org: 'Test', description: 'Test' },
    plugins: [],
    env: makeEnv(input.env),
  });
  const Oracle = createUserOracleDO({ core: () => core, hooks: {} });
  const host: object = Object.create(Oracle.prototype);
  const storage = input.storage ?? new Map<string, unknown>();
  const setPlan = vi.fn(async (_runId: string, _plan: string) => undefined);
  Object.assign(host, {
    env: {},
    ctx: {
      waitUntil: vi.fn(),
      storage: {
        sync: vi.fn(async () => undefined),
        get: vi.fn(async (key: string) => storage.get(key)),
        put: vi.fn(async (key: string, value: unknown) => {
          storage.set(key, value);
        }),
      },
    },
    userDid: 'did:ixo:owner',
    channelTurns: { isCancelled: vi.fn(async () => false) },
    aborts: new Map(),
    // The person's delegation, valid for another day.
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
    saver: {
      getTuple: async () => ({
        checkpoint: { channel_values: { messages: [] } },
      }),
    },
    ready: vi.fn(async () => undefined),
    runTurnDisposables: vi.fn(async () => undefined),
    prepareTurn: vi.fn(async () => ({
      agent: {
        // eslint-disable-next-line require-yield -- fails before its first event
        async *streamEvents() {
          throw input.error;
        },
      },
      stateInput: {},
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
  return { attempt, setPlan, storage };
}

describe('a channel turn the model could not answer', () => {
  it('finishes with one short busy reply and keeps the error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { attempt, setPlan, storage } = failingChannelRun({
      error: keyLimitError(),
    });
    const outcome = await attempt();
    const plan = {
      v: 1,
      parts: [
        {
          partId: 'busy_reply',
          kind: 'text',
          text: CHANNEL_BUSY_REPLY_DEFAULT,
        },
      ],
    };
    expect(outcome).toMatchObject({ status: 'finished', plan });
    expect(Reflect.get(outcome as object, 'error')).toBeInstanceOf(Error);
    expect(setPlan).toHaveBeenCalledWith('run', JSON.stringify(plan));
    expect(typeof storage.get(busyReplyKey('chb_x'))).toBe('number');
    // The cause is logged.
    expect(JSON.stringify(warn.mock.calls)).toContain(
      'the model could not answer (auth 403); sent the busy reply',
    );
    warn.mockRestore();
  });

  it('sends nothing again within ten minutes, and does not leave the run failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = new Map<string, unknown>([
      [
        busyReplyKey('chb_x'),
        Date.now() - CHANNEL_BUSY_REPLY_COOLDOWN_MS + 60_000,
      ],
    ]);
    const { attempt, setPlan } = failingChannelRun({
      error: keyLimitError(),
      storage,
    });
    const outcome = await attempt();
    // `finished` with nothing to show: the gateway sends nothing either
    // (for a `failed` run it would send its own failure reply).
    expect(outcome).toMatchObject({
      status: 'finished',
      plan: { v: 1, parts: [] },
    });
    expect(setPlan).toHaveBeenCalledWith(
      'run',
      JSON.stringify({ v: 1, parts: [] }),
    );
    warn.mockRestore();
  });

  it('sends it again once ten minutes have passed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = new Map<string, unknown>([
      [busyReplyKey('chb_x'), Date.now() - CHANNEL_BUSY_REPLY_COOLDOWN_MS - 1],
    ]);
    const { attempt } = failingChannelRun({ error: keyLimitError(), storage });
    expect(await attempt()).toMatchObject({
      status: 'finished',
      plan: { parts: [{ text: CHANNEL_BUSY_REPLY_DEFAULT }] },
    });
    warn.mockRestore();
  });

  it("uses the deployment's CHANNEL_BUSY_REPLY", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { attempt } = failingChannelRun({
      error: keyLimitError(),
      env: { CHANNEL_BUSY_REPLY: 'Eish, I am busy. Try again soon.' },
    });
    expect(await attempt()).toMatchObject({
      status: 'finished',
      plan: { parts: [{ text: 'Eish, I am busy. Try again soon.' }] },
    });
    warn.mockRestore();
  });

  it('stays failed when the failure was not the model (a tool or runtime error)', async () => {
    const { attempt, setPlan, storage } = failingChannelRun({
      error: new Error('tool exploded'),
    });
    expect(await attempt()).toMatchObject({ status: 'failed' });
    expect(setPlan).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('stays failed on a turn that is not a channel turn', async () => {
    const { attempt, setPlan } = failingChannelRun({
      error: keyLimitError(),
      request: {
        ...channelRequest,
        client: 'matrix',
        roomId: '!r:example.org',
        channel: undefined,
      },
      delivery: { kind: 'stream' },
    });
    expect(await attempt()).toMatchObject({ status: 'failed' });
    expect(setPlan).not.toHaveBeenCalled();
  });
});
