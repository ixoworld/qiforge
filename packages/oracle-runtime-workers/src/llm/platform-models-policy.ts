/**
 * A turn a plugin's gate restricted to the person's own provider
 * (`TurnGateResult.platformModels: 'deny'`, stored as
 * `TurnRequest.platformModels`): the pieces that make sure nothing of it
 * runs on the platform's model key.
 *
 * - `deniedPlatformLlm` stands in for the platform adapter under the BYO
 *   adapter: a role the person's provider does not serve gets a model whose
 *   every call fails with `PlatformModelsDeniedError`. Building it never
 *   fails, so an agent or sub-agent that binds tools to it still builds; the
 *   failure is the call's.
 * - `deniedDecisions` stands in for the Decision evaluator: every
 *   evaluation rejects with `DecisionProviderUnavailableError`, the error
 *   every caller already treats as "no provider" (the capability router
 *   preloads nothing, a plugin's `ctx.decisions` sees the provider as
 *   unavailable).
 *
 * The host skips the platform-only work around such a turn itself (title,
 * attachment extraction, channel routing): see `docs/usage-metering.md`.
 */
import {
  DecisionProviderUnavailableError,
  type DecisionEvaluator,
} from '@ixo/common/ai/decisions';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { LlmAdapter } from '../core/runtime-context';

/** Thrown by a model or step a turn restricted to the person's provider may not use. */
export class PlatformModelsDeniedError extends Error {
  readonly code = 'platform_models_denied';

  constructor(what: string) {
    super(
      `${what} needs the oracle's own models, which this turn may not use: it runs on your own model provider only`,
    );
    this.name = 'PlatformModelsDeniedError';
  }
}

/** A model whose calls fail: the platform model of a role the person's provider does not serve. */
export class DeniedPlatformChatModel extends BaseChatModel {
  static lc_name(): string {
    return 'DeniedPlatformChatModel';
  }

  constructor(private readonly role: string) {
    super({});
  }

  _llmType(): string {
    return 'platform-models-denied';
  }

  /** Binding tools succeeds (the agent still builds); a call does not. */
  override bindTools(
    _tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<
    BaseLanguageModelInput,
    AIMessageChunk,
    BaseChatModelCallOptions
  > {
    return this;
  }

  _generate(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    return Promise.reject(
      new PlatformModelsDeniedError(`The "${this.role}" model`),
    );
  }
}

/** The platform adapter of a restricted turn: every role is denied. */
export function deniedPlatformLlm(): LlmAdapter {
  return { get: (role) => new DeniedPlatformChatModel(String(role)) };
}

/** The Decision evaluator of a restricted turn: no provider. */
export function deniedDecisions(): DecisionEvaluator {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new DecisionProviderUnavailableError(
        'Decisions run on the platform provider, which this turn may not use',
      ),
    );
  return { evaluate: unavailable, evaluateByName: unavailable };
}
