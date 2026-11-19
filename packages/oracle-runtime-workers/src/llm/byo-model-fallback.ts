/**
 * Call-time fallback for a BYO model the user's provider refuses.
 *
 * The pre-turn checks (`WorkersByoService.resolveForTurn`) cannot know
 * whether the provider serves the selected model (the account's model
 * listing, `byo-model-discovery.ts`, is advisory and can lag), so only the
 * first real request finds out. This wrapper stands in for the BYO chat
 * model: when its call fails with a refusal that names the model
 * (`isModelUnavailableError`: an explicit code or text, never a bare 400 or
 * 404) before the
 * provider produced any output, it announces the fallback once (an
 * `on_custom_event` named `byo_fallback`, which the SSE producer writes as
 * the same `error`-channel notice the pre-turn fallbacks send) and answers
 * the very same call on the platform model. The refusal is remembered for
 * the rest of the turn (`ByoModelFallbackState`, one per adapter, i.e. per
 * turn): every later call to that model id goes to the platform model
 * directly. Other BYO model ids of the turn (the helper roles' models) stay
 * on the user's account. Nothing is persisted across turns. A failure of the
 * answering platform model is marked (`markPlatformFallbackFailure`) so the
 * SSE classification blames — and redacts — the platform, not the user's
 * account.
 *
 * Delegation runs at the `_streamResponseChunks` / `_generate` level, inside
 * this wrapper's own run, so callbacks, metering and the stream events see
 * one model call whichever model answered it.
 *
 * Each call carries one call record (`model-call.ts`), like a platform
 * model's: a call the user's model answered (or failed, other than the
 * refusal that is answered by the platform) gets a record with
 * `paidBy: 'user'`, built from the provider's reported usage; a call the
 * platform model answered carries that model's own record (`paidBy:
 * 'platform'`). The refused attempt itself is not reported: it failed on the
 * user's account and the platform answer is the call.
 *
 * `platformFallback: false` (a turn restricted to the person's own provider
 * by a plugin's turn gate) turns the fallback off: the refusal is the
 * call's error, reported as the user's call, and the platform model is
 * never built.
 */

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type {
  BaseLanguageModelInput,
  ToolDefinition,
} from '@langchain/core/language_models/base';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { ModelProfile } from '@langchain/core/language_models/profile';
import {
  AIMessageChunk,
  type BaseMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { Logger } from '../plugin-api/types';
import type { ByoProvider } from './byo-catalog';
import {
  attachModelCall,
  buildModelCallRecord,
  MODEL_CALL_METADATA_KEY,
  type ModelCallRecord,
} from './model-call';
import {
  BYO_FALLBACK_KIND,
  buildByoFallbackNotice,
  classifyLlmError,
  isModelUnavailableError,
  markPlatformFallbackFailure,
  upstreamEvidence,
} from './provider-error';

/** Turn-scoped record of the BYO model ids the provider refused. */
export class ByoModelFallbackState {
  private readonly refused = new Set<string>();

  isRefused(modelId: string): boolean {
    return this.refused.has(modelId);
  }

  /** Records a refusal; `true` only the first time for this model id. */
  markRefused(modelId: string): boolean {
    if (this.refused.has(modelId)) return false;
    this.refused.add(modelId);
    return true;
  }
}

export interface ByoModelFallbackCallOptions extends BaseChatModelCallOptions {
  /** Tools in OpenAI function format (see `bindTools`). */
  tools?: ToolDefinition[] | BindToolsInput[];
  strict?: boolean;
}

export interface ByoModelFallbackFields {
  provider: ByoProvider;
  /** The role the model serves (`main`, `summarizer`, …), for the call record. */
  role: string;
  /** Provider-native id of the wrapped BYO model. */
  modelId: string;
  /** The user's BYO model for this role. */
  byo: BaseChatModel;
  /** Builds the platform model for the same role (called at most once). */
  platform: () => BaseChatModel;
  /**
   * `false`: a refusal is NOT answered by the platform model; the
   * provider's error ends the call (a turn a gate restricted to the
   * person's own provider, `TurnRequest.platformModels`). Default true.
   */
  platformFallback?: boolean;
  state: ByoModelFallbackState;
  logger: Logger;
}

/** LangChain's usage of one call in the OpenAI shape the call record reads. */
function openAiUsage(usage: UsageMetadata): Record<string, unknown> {
  const cached = usage.input_token_details?.cache_read;
  const reasoning = usage.output_token_details?.reasoning;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    ...(cached !== undefined
      ? { prompt_tokens_details: { cached_tokens: cached } }
      : {}),
    ...(reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  };
}

function isUsageMetadata(value: unknown): value is UsageMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'input_tokens') === 'number' &&
    typeof Reflect.get(value, 'output_tokens') === 'number'
  );
}

function modelNameOf(metadata: Record<string, unknown>): string | undefined {
  const name: unknown = metadata.model_name ?? metadata.model;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

export class ByoModelFallbackChatModel extends BaseChatModel<ByoModelFallbackCallOptions> {
  private readonly fields: ByoModelFallbackFields;
  private platformModel: BaseChatModel | undefined;

  static lc_name(): string {
    return 'ByoModelFallbackChatModel';
  }

  constructor(fields: ByoModelFallbackFields) {
    super({});
    this.fields = fields;
  }

  /** The provider-native id this wrapper stands in for. */
  get modelId(): string {
    return this.fields.modelId;
  }

  /** The user's own model this wrapper calls first. */
  get byoModel(): BaseChatModel {
    return this.fields.byo;
  }

  private platform(): BaseChatModel {
    this.platformModel ??= this.fields.platform();
    return this.platformModel;
  }

  /** The record of a call the user's own model answered or failed. */
  private userCallRecord(
    started: number,
    seen: { usage?: UsageMetadata; servedModel?: string },
    error?: unknown,
  ): ModelCallRecord {
    return buildModelCallRecord(
      {
        role: this.fields.role,
        requestedModel: this.fields.modelId,
        paidBy: 'user',
      },
      {
        provider: this.fields.provider,
        ...(seen.servedModel ? { servedModel: seen.servedModel } : {}),
        ...(seen.usage ? { usage: openAiUsage(seen.usage) } : {}),
      },
      Date.now() - started,
      error,
    );
  }

  /** The model a call starting now goes to. */
  private active(): BaseChatModel {
    return this.fields.state.isRefused(this.fields.modelId)
      ? this.platform()
      : this.fields.byo;
  }

  /** Read by the base constructor, before the fields exist — a constant. */
  _llmType(): string {
    return 'byo-model-fallback';
  }

  override get profile(): ModelProfile {
    return this.active().profile;
  }

  override invocationParams(options?: this['ParsedCallOptions']): unknown {
    return this.active().invocationParams(options);
  }

  override getLsParams(options: this['ParsedCallOptions']) {
    return this.active().getLsParams(options);
  }

  /**
   * Tools travel as call options in OpenAI function format — the format
   * `ChatOpenAI.bindTools` produces and both of its request converters
   * (Chat Completions and Responses) accept — so the same bound call can be
   * answered by either model. `strict` stays a call option, applied by the
   * answering model exactly as its own `bindTools` would. Provider-specific
   * tool kinds that only `ChatOpenAI.bindTools` special-cases on a LangChain
   * tool (`metadata.customTool`, `extras.providerToolDefinition`,
   * `extras.defer_loading`) become plain functions here; the runtime binds
   * none of them. Plain OpenAI tool objects pass through unchanged.
   */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ByoModelFallbackCallOptions>,
  ): Runnable<
    BaseLanguageModelInput,
    AIMessageChunk,
    ByoModelFallbackCallOptions
  > {
    return this.withConfig({
      tools: tools.map((tool) => convertToOpenAITool(tool)),
      ...kwargs,
    });
  }

  /**
   * A refusal: announce it once per model id per turn, log it, and remember
   * it so every later call goes to the platform model.
   */
  private async fallBack(
    error: unknown,
    runManager: CallbackManagerForLLMRun | undefined,
  ): Promise<void> {
    const { provider, modelId, state, logger } = this.fields;
    if (!state.markRefused(modelId)) return;
    const status = classifyLlmError(error).status;
    logger.warn(
      `[byo] ${provider} refused model "${modelId}" (HTTP ${status ?? 'n/a'}): ${error instanceof Error ? error.message : String(error)} — this turn uses the platform model for it`,
    );
    await runManager?.handleCustomEvent(
      BYO_FALLBACK_KIND,
      buildByoFallbackNotice('model_unavailable', provider, {
        modelId,
        ...upstreamEvidence(error),
      }),
    );
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    if (!this.fields.state.isRefused(this.fields.modelId)) {
      let produced = false;
      const started = Date.now();
      const seen: { usage?: UsageMetadata; servedModel?: string } = {};
      try {
        for await (const chunk of this.fields.byo._streamResponseChunks(
          messages,
          options,
          runManager,
        )) {
          produced = true;
          // Only the final chunk carries the call's usage.
          const message = chunk.message;
          const usage: unknown = Reflect.get(message, 'usage_metadata');
          if (isUsageMetadata(usage)) seen.usage = usage;
          seen.servedModel =
            modelNameOf(message.response_metadata) ?? seen.servedModel;
          yield chunk;
        }
      } catch (error) {
        if (
          options.signal?.aborted ||
          this.fields.platformFallback === false ||
          !isModelUnavailableError(error, { afterOutput: produced })
        ) {
          attachModelCall(error, this.userCallRecord(started, seen, error));
          throw error;
        }
        await this.fallBack(error, runManager);
      }
      if (!this.fields.state.isRefused(this.fields.modelId)) {
        yield new ChatGenerationChunk({
          text: '',
          message: new AIMessageChunk({
            content: '',
            response_metadata: {
              [MODEL_CALL_METADATA_KEY]: this.userCallRecord(started, seen),
            },
          }),
        });
        return;
      }
    }
    try {
      yield* this.platform()._streamResponseChunks(
        messages,
        options,
        runManager,
      );
    } catch (error) {
      markPlatformFallbackFailure(error);
      throw error;
    }
  }

  /**
   * The non-streamed path (no streaming handler on the call). A model that
   * streams internally here reports tokens to handlers that do not forward
   * them anywhere, so a refusal is always answered by the platform model.
   */
  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    if (!this.fields.state.isRefused(this.fields.modelId)) {
      const started = Date.now();
      try {
        const result = await this.fields.byo._generate(
          messages,
          options,
          runManager,
        );
        const message = result.generations[0]?.message;
        if (message) {
          const usage: unknown = Reflect.get(message, 'usage_metadata');
          const servedModel = modelNameOf(message.response_metadata);
          message.response_metadata = {
            ...message.response_metadata,
            [MODEL_CALL_METADATA_KEY]: this.userCallRecord(started, {
              ...(isUsageMetadata(usage) ? { usage } : {}),
              ...(servedModel ? { servedModel } : {}),
            }),
          };
        }
        return result;
      } catch (error) {
        if (
          options.signal?.aborted ||
          this.fields.platformFallback === false ||
          !isModelUnavailableError(error)
        ) {
          attachModelCall(error, this.userCallRecord(started, {}, error));
          throw error;
        }
        await this.fallBack(error, runManager);
      }
    }
    try {
      return await this.platform()._generate(messages, options, runManager);
    } catch (error) {
      markPlatformFallbackFailure(error);
      throw error;
    }
  }
}
