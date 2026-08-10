import { Global, Module } from '@nestjs/common';
import { HomeServerCache } from '../messages/homeserver-cache.js';
import { ByoLlmController } from './byo-llm.controller.js';
import { ByoLlmService } from './byo-llm.service.js';

/**
 * Bring-your-own-credential LLMs. Always mounted (like Models); inert unless
 * `BYO_LLM_ENABLED=true` — the routes 404 and `resolveForTurn` returns null,
 * so non-companion oracles carry zero behaviour change.
 *
 * `@Global` because the service is consumed across module boundaries:
 * `AgentBuilder` (messages) resolves the per-turn credential and
 * `SubscriptionMiddleware` (subscription) consults it for the credit-floor
 * bypass. Provides its own `HomeServerCache` instance — the class is a
 * dependency-free per-DID memo, so a second instance costs one chain lookup
 * per user per hour at worst.
 */
@Global()
@Module({
  controllers: [ByoLlmController],
  providers: [ByoLlmService, HomeServerCache],
  exports: [ByoLlmService],
})
export class ByoLlmModule {}
