import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import type { TokenLimiter } from '../credits/token-limiter.js';
import {
  CLAIM_PROCESSING_TOKEN_LIMITER,
  ClaimProcessingService,
} from './claim-processing.service.js';

/** Options for `ClaimProcessingModule.register`. */
export interface ClaimProcessingModuleOptions {
  /**
   * Token limiter instance owned by the credits plugin. The module wires it
   * into the service via the `CLAIM_PROCESSING_TOKEN_LIMITER` token so the
   * cron job can read held amounts, pending claims, and subscription
   * payloads on each run.
   */
  tokenLimiter: TokenLimiter;
}

/**
 * NestJS module shipping the claim-processing cron service. Imported by the
 * runtime when the `claim-processing` plugin is loaded (i.e. credits is
 * loaded). The service is silent / agent-invisible — no controller, no tools.
 */
@Module({})
export class ClaimProcessingModule {
  static register(opts: ClaimProcessingModuleOptions): DynamicModule {
    const tokenLimiterProvider: Provider = {
      provide: CLAIM_PROCESSING_TOKEN_LIMITER,
      useValue: opts.tokenLimiter,
    };

    return {
      module: ClaimProcessingModule,
      providers: [tokenLimiterProvider, ClaimProcessingService],
      exports: [ClaimProcessingService],
    };
  }
}
