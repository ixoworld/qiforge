/**
 * Request-scoped LLM adapter for BYO turns — the Workers port of the Node
 * runtime's `llm/byo-adapter.ts`.
 *
 * The host swaps this in for `ambient.llm` on turns where the user has an
 * active BYO credential, so every downstream consumer — the main model,
 * sub-agents, plugin tools reading `rtCtx.llm`, and middlewares —
 * transparently runs on the user's provider. Roles the provider cannot serve
 * (embedding everywhere, vision on DeepSeek) fall through to the platform
 * adapter, so those stay platform-paid.
 *
 * The credential is captured in this closure only; it never appears on the
 * request context, graph state, or trace metadata.
 *
 * Every BYO model it hands out is wrapped in `ByoModelFallbackChatModel`:
 * a model the provider refuses (`isModelUnavailableError`) is answered by
 * the platform model for the rest of the turn, behind a `byo_fallback`
 * notice. The refusal state lives in this adapter, so it is per turn.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatOpenAIFields, Logger, ModelRole } from '../plugin-api/types';
import type { LlmAdapter } from '../core/runtime-context';
import { NOOP_LOGGER } from '../core/utils';
import { byoModelForRole, type ByoCredential } from './byo-catalog';
import { createByoChatModel, type ChatGptBackendConfig } from './byo-client';
import {
  ByoModelFallbackChatModel,
  ByoModelFallbackState,
} from './byo-model-fallback';

export interface ByoTurnResolution {
  credential: ByoCredential;
  /** Provider-native id serving the `main` role this turn. */
  mainModelId: string;
  /** ChatGPT lane only: backend/proxy the requests go to. */
  chatGptBackend?: ChatGptBackendConfig;
}

export function createByoLlmAdapter(
  platform: LlmAdapter,
  turn: ByoTurnResolution,
  logger?: Logger,
): LlmAdapter {
  const fallbackState = new ByoModelFallbackState();
  return {
    get(role: ModelRole, params?: ChatOpenAIFields): BaseChatModel {
      const modelId = byoModelForRole(
        turn.credential.provider,
        role,
        turn.mainModelId,
      );
      if (modelId === null) {
        // Role not served by this provider — platform model, platform key.
        return platform.get(role, params);
      }
      // Strip a caller-supplied `model` (for `main` it carries the `byo:` id,
      // which is not a wire id) — the translated id wins.
      const { model: _model, ...rest } = params ?? {};
      // Wrapped even after a refusal this turn: the wrapper then goes straight
      // to the platform model and attributes that model's failures to the
      // platform, not to the user's account.
      return new ByoModelFallbackChatModel({
        provider: turn.credential.provider,
        modelId,
        byo: createByoChatModel({
          credential: turn.credential,
          modelId,
          role,
          chatGptBackend: turn.chatGptBackend,
          params: rest,
          logger,
        }),
        platform: () => platform.get(role, rest),
        state: fallbackState,
        logger: logger ?? NOOP_LOGGER,
      });
    },
  };
}
