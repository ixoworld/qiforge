import { BadRequestException } from '@nestjs/common';
import type * as IxoCommon from '@ixo/common';
import { AIMessage, HumanMessage, type BaseMessage } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentBuilder, type BuiltAgent } from './agent-builder.js';
import { BatchInvoker, type BatchInvokeInput } from './batch-invoker.js';
import { type SendMessagePayload } from './dto/send-message.dto.js';
import { makePrepared } from './__test-fixtures__/deps.js';

vi.mock('@ixo/common', async (importOriginal) => ({
  ...(await importOriginal<typeof IxoCommon>()),
  transformGraphStateMessageToListMessageResponse: vi.fn(
    (messages: BaseMessage[]) => ({
      messages: messages.map((m) => ({
        content: String(m.content),
        type: m.type,
        id: m.id ?? 'id',
      })),
      total: messages.length,
    }),
  ),
}));

const USER_DID = 'did:ixo:user-1';
const SESSION_ID = 'sess-1';

function makePayload(
  overrides: Partial<SendMessagePayload> = {},
): SendMessagePayload {
  return {
    message: 'hello',
    sessionId: SESSION_ID,
    did: USER_DID,
    ...overrides,
  };
}

function makeInput(
  overrides: {
    payload?: Partial<SendMessagePayload>;
    inputMessages?: BaseMessage[];
    abortController?: AbortController;
  } = {},
): BatchInvokeInput {
  return {
    payload: makePayload(overrides.payload),
    prepared: makePrepared(),
    inputMessages: overrides.inputMessages ?? [new HumanMessage('hello')],
    ...(overrides.abortController && {
      abortController: overrides.abortController,
    }),
  };
}

interface Harness {
  svc: BatchInvoker;
  invoke: ReturnType<typeof vi.fn>;
  build: ReturnType<typeof vi.fn>;
  abortController: AbortController;
}

function build(
  builtAgentOverrides: {
    invokeResult?: { messages: BaseMessage[] };
    langGraphConfig?: Record<string, unknown>;
    stateInput?: Partial<BuiltAgent['stateInput']>;
  } = {},
): Harness {
  const abortController = new AbortController();
  const invokeResult = builtAgentOverrides.invokeResult ?? {
    messages: [new AIMessage({ id: 'ai-1', content: 'hi there' })],
  };
  const invoke = vi.fn().mockResolvedValue(invokeResult);

  const langGraphConfig: Record<string, unknown> =
    builtAgentOverrides.langGraphConfig ?? {
      version: 'v2',
      streamMode: ['updates', 'messages'],
      recursionLimit: 200,
      configurable: { thread_id: SESSION_ID },
      context: { user: { did: USER_DID } },
      signal: abortController.signal,
    };

  const builtAgent: BuiltAgent = {
    agent: { invoke } as unknown as BuiltAgent['agent'],
    stateInput: builtAgentOverrides.stateInput ?? {},
    langGraphConfig,
  };

  const buildFn = vi.fn().mockResolvedValue(builtAgent);
  const agentBuilder = { build: buildFn } as unknown as AgentBuilder;
  const svc = new BatchInvoker(agentBuilder);
  return { svc, invoke, build: buildFn, abortController };
}

describe('BatchInvoker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('invoke — config stripping', () => {
    it('strips streamMode + version from langGraphConfig before agent.invoke', async () => {
      const { svc, invoke } = build();

      await svc.invoke(makeInput());

      expect(invoke).toHaveBeenCalledTimes(1);
      const passedConfig = invoke.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(passedConfig).toBeDefined();
      expect(passedConfig).not.toHaveProperty('streamMode');
      expect(passedConfig).not.toHaveProperty('version');
    });

    it('preserves recursionLimit + configurable + context + signal', async () => {
      const { svc, invoke, abortController } = build();

      await svc.invoke(makeInput());

      const passedConfig = invoke.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(passedConfig).toMatchObject({
        recursionLimit: 200,
        configurable: { thread_id: SESSION_ID },
        context: { user: { did: USER_DID } },
        signal: abortController.signal,
      });
    });
  });

  describe('invoke — abort controller', () => {
    it('hands the per-turn AbortController to agentBuilder.build', async () => {
      const { svc, build: buildFn } = build();
      const turnController = new AbortController();

      await svc.invoke(makeInput({ abortController: turnController }));

      expect(buildFn).toHaveBeenCalledTimes(1);
      expect(buildFn.mock.calls[0]?.[1]).toBe(turnController);
    });

    it('passes no controller when the input carries none', async () => {
      const { svc, build: buildFn } = build();

      await svc.invoke(makeInput());

      expect(buildFn.mock.calls[0]?.[1]).toBeUndefined();
    });
  });

  describe('invoke — return shape', () => {
    it('throws BadRequestException when result.messages is empty', async () => {
      const { svc } = build({ invokeResult: { messages: [] } });

      await expect(svc.invoke(makeInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('returns { message, sessionId } from the last assistant message', async () => {
      const { svc } = build({
        invokeResult: {
          messages: [
            new HumanMessage({ id: 'h-1', content: 'hi' }),
            new AIMessage({ id: 'ai-1', content: 'first reply' }),
            new AIMessage({ id: 'ai-2', content: 'final reply' }),
          ],
        },
      });

      const result = await svc.invoke(makeInput());

      expect(result).toEqual({
        message: { type: 'ai', content: 'final reply', id: 'ai-2' },
        sessionId: SESSION_ID,
      });
      expect(result.messages).toBeUndefined();
    });

    it('includes transcript when payload.returnAllMessages=true', async () => {
      const transcript: BaseMessage[] = [
        new HumanMessage({ id: 'h-1', content: 'hi' }),
        new AIMessage({ id: 'ai-1', content: 'final reply' }),
      ];
      const { svc } = build({ invokeResult: { messages: transcript } });

      const result = await svc.invoke(
        makeInput({ payload: { returnAllMessages: true } }),
      );

      expect(result.messages).toEqual([
        { content: 'hi', type: 'human', id: 'h-1' },
        { content: 'final reply', type: 'ai', id: 'ai-1' },
      ]);
    });
  });
});
