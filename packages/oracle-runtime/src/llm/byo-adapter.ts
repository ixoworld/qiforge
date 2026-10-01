/**
 * Request-scoped LLM adapter for BYO turns.
 *
 * `AgentBuilder` swaps this in for `ambient.llm` on turns where the user has
 * an active BYO credential, so every downstream consumer — the main model,
 * sub-agents (`sub-agent-fallback`), plugin tools reading `rtCtx.llm`, and
 * middlewares — transparently runs on the user's provider. Roles the provider
 * cannot serve (embedding everywhere, vision on DeepSeek) fall through to the
 * platform adapter, so those stay platform-paid.
 *
 * The credential is captured in this closure only; it never appears on the
 * request context, graph state, or trace metadata.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatOpenAIFields, ModelRole } from '../plugin-api/types.js';
import type { LlmAdapter } from '../runtime-context/ambient.js';
import { byoModelForRole, type ByoCredential } from './byo-catalog.js';
import { createByoChatModel } from './byo-client.js';

export interface ByoTurnResolution {
  credential: ByoCredential;
  /** Provider-native id serving the `main` role this turn. */
  mainModelId: string;
}

export function createByoLlmAdapter(
  platform: LlmAdapter,
  turn: ByoTurnResolution,
): LlmAdapter {
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
      return createByoChatModel({
        credential: turn.credential,
        modelId,
        role,
        params: rest,
      });
    },
  };
}
