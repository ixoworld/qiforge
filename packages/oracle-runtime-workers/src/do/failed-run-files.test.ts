import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import { FAILED_RUN_NOTICE } from '../delivery/plan';
import { resolveDeliveryProfile } from '../delivery/profile';
import type { DeliveryProfile, ReplyFile } from '../delivery/types';
import type { TurnRequest } from './contracts';
import { storedRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

const request: TurnRequest = {
  identity: { userDid: 'did:ixo:owner', matrixUserId: '@owner:example.org' },
  sessionId: 'session',
  message: 'Make the report',
  client: 'matrix',
  roomId: '!main:example.org',
  requestId: 'request',
};

const FILE: ReplyFile = {
  url: 'https://r2.example/o/report.docx?X-Amz-Signature=deadbeef',
  filename: 'report.docx',
  mimetype: 'application/msword',
};

const history: BaseMessage[] = [
  new HumanMessage('Make the report'),
  new AIMessage({
    content: '',
    tool_calls: [
      { id: 'f1', name: 'send_file', args: { path: '/output/report.docx' } },
    ],
  }),
  new ToolMessage({
    tool_call_id: 'f1',
    name: 'send_file',
    content: '{"ok":true}',
    artifact: { ...FILE, path: '/output/report.docx' },
  }),
];

const chat = resolveDeliveryProfile({
  client: 'channel',
  channel: { provider: 'whatsapp', bindingId: 'chb_x', remoteMessageRef: 'x' },
});

/**
 * The real `runAttempt` over a prepared turn whose closing model call fails,
 * with the checkpoint and the tool marks the turn left behind.
 */
function failingRun(input: {
  delivery?: DeliveryProfile;
  marks?: string[];
  getTuple?: () => Promise<unknown>;
}) {
  const core = createRuntimeCore({
    config: { name: 'Test', org: 'Test', description: 'Test' },
    plugins: [],
    env: makeEnv(),
  });
  const Oracle = createUserOracleDO({ core: () => core, hooks: {} });
  const host: object = Object.create(Oracle.prototype);
  const setPlan = vi.fn(async (_runId: string, _plan: string) => undefined);
  Object.assign(host, {
    env: {},
    ctx: { waitUntil: vi.fn() },
    userDid: 'did:ixo:owner',
    aborts: new Map(),
    delegations: new Map(),
    runs: { touchKeepAlive: vi.fn() },
    events: { register: vi.fn(), unregister: vi.fn(), emitToTaps: vi.fn() },
    runStore: {
      update: vi.fn(async () => undefined),
      setPlan,
      listMarks: vi.fn(async () =>
        (input.marks ?? ['f1']).map((toolCallId) => ({ toolCallId })),
      ),
    },
    saver: {
      getTuple:
        input.getTuple ??
        (async () => ({
          checkpoint: { channel_values: { messages: history } },
        })),
    },
    ready: vi.fn(async () => undefined),
    runTurnDisposables: vi.fn(async () => undefined),
    prepareTurn: vi.fn(async () => ({
      agent: {
        // eslint-disable-next-line require-yield -- fails before its first event
        async *streamEvents() {
          throw new Error('provider down');
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
    attemptSource: 'recovery',
  };
  const attempt = (): Promise<unknown> =>
    Reflect.apply(Reflect.get(host, 'runAttempt'), host, [live, true]);
  return { attempt, setPlan };
}

describe('a chat run that fails after send_file', () => {
  it('finishes with the file and says the rest is missing, keeping the error', async () => {
    const { attempt, setPlan } = failingRun({});
    const outcome = await attempt();
    const plan = {
      v: 1,
      parts: [
        { partId: 'p1', kind: 'file', file: FILE },
        { partId: 'p2', kind: 'text', text: FAILED_RUN_NOTICE },
      ],
    };
    expect(outcome).toMatchObject({ status: 'finished', plan });
    expect(Reflect.get(outcome as object, 'error')).toBeInstanceOf(Error);
    // A poll, a re-post and a mirror read it back.
    expect(setPlan).toHaveBeenCalledWith('run', JSON.stringify(plan));
  });

  it('stays failed when the checkpoint holds only an earlier turn', async () => {
    const { attempt, setPlan } = failingRun({ marks: [] });
    expect(await attempt()).toMatchObject({ status: 'failed' });
    expect(setPlan).not.toHaveBeenCalled();
  });

  it('stays failed on a surface that is not chat', async () => {
    const { attempt, setPlan } = failingRun({ delivery: { kind: 'stream' } });
    expect(await attempt()).toMatchObject({ status: 'failed' });
    expect(setPlan).not.toHaveBeenCalled();
  });

  it('stays failed when the checkpoint cannot be read, and logs no error text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { attempt } = failingRun({
      getTuple: async () => {
        throw new Error(FILE.url);
      },
    });
    expect(await attempt()).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('X-Amz-Signature');
    warn.mockRestore();
  });
});
