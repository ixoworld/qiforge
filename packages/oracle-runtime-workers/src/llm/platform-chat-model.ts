/**
 * The chat model the platform adapter hands out (OpenRouter, Nebius):
 * `ChatOpenAICompletions` with three additions.
 *
 * - **Usage counted once.** OpenRouter sends the call's usage on its last
 *   streamed chunk, which also carries a choice. LangChain puts that usage in
 *   the chunk's `response_metadata`, then yields one more chunk with the same
 *   usage, and merging the chunks adds the two: every stored reply's
 *   `response_metadata.usage` (tokens and cost) was exactly twice the real
 *   value. Only LangChain's own usage chunk keeps it now. (`usage_metadata`
 *   was always right: only the final chunk sets it.)
 * - **Tool schemas OpenAI accepts.** Each tool's parameters go through
 *   `guardFunctionParameters` (`tool-schema-guard.ts`) on the way to the
 *   provider.
 * - **A record per call.** When a call ends or fails, one `[llm-call] {…}`
 *   line (`model-call.ts`): generation id, requested and served model,
 *   provider, whether a fallback answered, tokens, cost, duration. The record
 *   rides on the reply as `response_metadata.model_call`, or on the error.
 */
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { Logger } from '../plugin-api/types';
import {
  attachModelCall,
  buildModelCallRecord,
  type CallObservation,
  MODEL_CALL_METADATA_KEY,
  type ModelCallRecord,
  observeRawResponse,
} from './model-call';
import { guardFunctionParameters } from './tool-schema-guard';

type ToolInput = Parameters<ChatOpenAICompletions['bindTools']>[0][number];

/** How a platform model reports its calls. */
export interface PlatformCallReporting {
  /** The role the model serves (`main`, `summarizer`, …), for the record. */
  role: string;
  logger: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Longest error detail a `[llm-call]` line carries. */
const DETAIL_MAX_CHARS = 300;

function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > DETAIL_MAX_CHARS
    ? `${text.slice(0, DETAIL_MAX_CHARS)}…`
    : text;
}

export class PlatformChatModel extends ChatOpenAICompletions {
  /** Set by the adapter right after construction. */
  reporting?: PlatformCallReporting;

  static lc_name(): string {
    return 'ChatOpenAICompletions';
  }

  protected override _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<
      ChatOpenAICompletions['_convertCompletionsDeltaToBaseMessageChunk']
    >
  ) {
    const chunk = super._convertCompletionsDeltaToBaseMessageChunk(...args);
    if ('usage' in chunk.response_metadata) {
      const metadata = { ...chunk.response_metadata };
      delete metadata.usage;
      chunk.response_metadata = metadata;
    }
    return chunk;
  }

  protected override _convertChatOpenAIToolToCompletionsTool(
    tool: ToolInput,
    fields?: { strict?: boolean },
  ) {
    const converted = super._convertChatOpenAIToolToCompletionsTool(
      tool,
      fields,
    );
    if (converted.type !== 'function') return converted;
    const { parameters } = converted.function;
    if (!parameters) return converted;
    const shown = guardFunctionParameters(
      converted.function.name,
      parameters,
      this.reporting?.logger,
    );
    return shown === parameters
      ? converted
      : {
          ...converted,
          function: { ...converted.function, parameters: shown },
        };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const started = Date.now();
    const seen: CallObservation = {};
    try {
      for await (const chunk of super._streamResponseChunks(
        messages,
        options,
        runManager,
      )) {
        const raw: unknown = chunk.message.additional_kwargs.__raw_response;
        if (raw !== undefined) observeRawResponse(seen, raw);
        else {
          const usage: unknown = Reflect.get(
            chunk.message.response_metadata,
            'usage',
          );
          if (isRecord(usage)) seen.usage = usage;
        }
        yield chunk;
      }
    } catch (error) {
      this.reportFailure(seen, started, error);
      throw error;
    }
    const record = this.reportCall(seen, started);
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        response_metadata: { [MODEL_CALL_METADATA_KEY]: record },
      }),
    });
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    // A streaming model's `_generate` reads `_streamResponseChunks`, which
    // reports the call itself.
    if (this.streaming) return super._generate(messages, options, runManager);
    const started = Date.now();
    const seen: CallObservation = {};
    let result: ChatResult;
    try {
      result = await super._generate(messages, options, runManager);
    } catch (error) {
      this.reportFailure(seen, started, error);
      throw error;
    }
    const message = result.generations[0]?.message;
    if (message) {
      observeRawResponse(seen, message.additional_kwargs.__raw_response);
      const usage: unknown = Reflect.get(message.response_metadata, 'usage');
      if (!seen.usage && isRecord(usage)) seen.usage = usage;
      const record = this.reportCall(seen, started);
      message.response_metadata = {
        ...message.response_metadata,
        [MODEL_CALL_METADATA_KEY]: record,
      };
    }
    return result;
  }

  /** What the call asked for: the role, the model, the provider order sent. */
  private callRequest() {
    const provider: unknown = this.modelKwargs?.provider;
    const order =
      isRecord(provider) && Array.isArray(provider.order)
        ? provider.order.filter((p): p is string => typeof p === 'string')
        : undefined;
    return {
      role: this.reporting?.role ?? 'unknown',
      requestedModel: this.model,
      ...(order && order.length > 0 ? { providerOrder: order } : {}),
    };
  }

  private reportCall(seen: CallObservation, started: number): ModelCallRecord {
    const record = buildModelCallRecord(
      this.callRequest(),
      seen,
      Date.now() - started,
    );
    this.reporting?.logger.log(`[llm-call] ${JSON.stringify(record)}`);
    return record;
  }

  private reportFailure(
    seen: CallObservation,
    started: number,
    error: unknown,
  ): void {
    const record = buildModelCallRecord(
      this.callRequest(),
      seen,
      Date.now() - started,
      error,
    );
    attachModelCall(error, record);
    this.reporting?.logger.warn(
      `[llm-call] ${JSON.stringify({ ...record, detail: errorDetail(error) })}`,
    );
  }
}
