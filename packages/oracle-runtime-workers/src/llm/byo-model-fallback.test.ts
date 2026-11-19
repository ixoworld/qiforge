/**
 * The call record a BYO call carries: `paidBy: 'user'` when the person's
 * own model answered (or failed), the platform model's own record when the
 * platform answered a refused model.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { describe, expect, it } from 'vitest';
import { budgetedLlm } from '../core/budgeted-llm';
import { TurnBudget } from '../core/turn-budget';
import {
  ByoModelFallbackChatModel,
  ByoModelFallbackState,
} from './byo-model-fallback';
import {
  MODEL_CALL_METADATA_KEY,
  modelCallOf,
  type ModelCallRecord,
  type ModelCallReport,
} from './model-call';

const USAGE = {
  input_tokens: 50,
  output_tokens: 5,
  total_tokens: 55,
  input_token_details: { cache_read: 40 },
  output_token_details: { reasoning: 2 },
};

/** The person's model: streams two chunks, the last with the call's usage. */
class UserModel extends BaseChatModel {
  constructor(private readonly failure?: Error) {
    super({});
  }

  _llmType(): string {
    return 'user-model';
  }

  async _generate(): Promise<ChatResult> {
    if (this.failure) throw this.failure;
    return {
      generations: [
        {
          text: 'Hello',
          message: new AIMessage({
            content: 'Hello',
            usage_metadata: USAGE,
            response_metadata: { model_name: 'gpt-6-luna-2026-10-01' },
          }),
        },
      ],
    };
  }

  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    yield new ChatGenerationChunk({
      text: 'Hel',
      message: new AIMessageChunk({ content: 'Hel' }),
    });
    if (this.failure) throw this.failure;
    yield new ChatGenerationChunk({
      text: 'lo',
      message: new AIMessageChunk({ content: 'lo', usage_metadata: USAGE }),
    });
  }
}

const PLATFORM_RECORD: ModelCallRecord = {
  role: 'main',
  paidBy: 'platform',
  requestedModel: 'openai/gpt-5.6-luna',
  fallback: false,
  modelFallback: false,
  providerFallback: false,
  costUsd: 0.002,
  durationMs: 10,
  ok: true,
};

/** A platform model that keeps its record like `PlatformChatModel`. */
class PlatformModel extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType(): string {
    return 'platform-model';
  }

  async _generate(): Promise<ChatResult> {
    return {
      generations: [
        {
          text: 'From the platform',
          message: new AIMessage({
            content: 'From the platform',
            response_metadata: { [MODEL_CALL_METADATA_KEY]: PLATFORM_RECORD },
          }),
        },
      ],
    };
  }
}

function wrapper(
  byo: BaseChatModel,
  state = new ByoModelFallbackState(),
  options: { platformFallback?: boolean; platform?: () => BaseChatModel } = {},
) {
  return new ByoModelFallbackChatModel({
    provider: 'openai',
    role: 'main',
    modelId: 'gpt-6-luna',
    byo,
    platform: options.platform ?? (() => new PlatformModel()),
    ...(options.platformFallback === false ? { platformFallback: false } : {}),
    state,
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

/** Run `model` through the turn's metered adapter; its reports. */
async function reportsOf(
  model: BaseChatModel,
  run: (m: BaseChatModel) => Promise<unknown>,
): Promise<{ reports: ModelCallReport[]; outcome: unknown }> {
  const reports: ModelCallReport[] = [];
  const metered = budgetedLlm(
    { get: () => model },
    {
      budget: new TurnBudget({ tools: 10, durationMs: 60_000 }, () => 0),
      outputReserveTokens: 100,
      onModelCall: (call) => reports.push(call),
    },
  );
  const outcome = await run(metered.get('main')).catch(
    (error: unknown) => error,
  );
  return { reports, outcome };
}

const expectedUserRecord = {
  role: 'main',
  paidBy: 'user',
  requestedModel: 'gpt-6-luna',
  provider: 'openai',
  promptTokens: 50,
  cachedTokens: 40,
  outputTokens: 5,
  reasoningTokens: 2,
  ok: true,
};

describe('BYO call records', () => {
  it('a streamed call the user model answered is reported once, user-paid, with its usage', async () => {
    const { reports } = await reportsOf(wrapper(new UserModel()), async (m) => {
      const parts: string[] = [];
      for await (const chunk of await m.stream('hi')) parts.push(chunk.text);
      return parts.join('');
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      ...expectedUserRecord,
      purpose: 'reply',
    });
    expect(reports[0]?.costUsd).toBeUndefined();
  });

  it('a non-streamed call carries the same record, with the served model', async () => {
    const reply = await wrapper(new UserModel()).invoke('hi');
    expect(modelCallOf(reply)).toMatchObject({
      ...expectedUserRecord,
      servedModel: 'gpt-6-luna-2026-10-01',
    });
  });

  it('a failure of the user model carries a user-paid failed record, reported once', async () => {
    const failure = Object.assign(new Error('500 upstream'), { status: 500 });
    const { reports, outcome } = await reportsOf(
      wrapper(new UserModel(failure)),
      async (m) => {
        for await (const chunk of await m.stream('hi')) void chunk;
      },
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      paidBy: 'user',
      ok: false,
      errorStatus: 500,
    });
  });

  it('a refused model answered by the platform carries only the platform record', async () => {
    const refusal = Object.assign(
      new Error("The 'gpt-6-luna' model is not supported"),
      { status: 400, code: 'model_not_found' },
    );
    const { reports } = await reportsOf(wrapper(new UserModel(refusal)), (m) =>
      m.invoke('hi'),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      paidBy: 'platform',
      requestedModel: 'openai/gpt-5.6-luna',
      costUsd: 0.002,
    });
  });

  it('with the platform fallback off, a refused model is the provider’s error: no platform model is built or called', async () => {
    const refusal = Object.assign(
      new Error("The 'gpt-6-luna' model is not supported"),
      { status: 400, code: 'model_not_found' },
    );
    let platformBuilt = 0;
    const model = wrapper(new UserModel(refusal), new ByoModelFallbackState(), {
      platformFallback: false,
      platform: () => {
        platformBuilt += 1;
        return new PlatformModel();
      },
    });
    for (const run of [
      (m: BaseChatModel) => m.invoke('hi'),
      async (m: BaseChatModel) => {
        for await (const chunk of await m.stream('hi')) void chunk;
      },
    ]) {
      const { reports, outcome } = await reportsOf(model, run);
      expect(outcome).toBe(refusal);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ paidBy: 'user', ok: false });
    }
    expect(platformBuilt).toBe(0);
  });
});
