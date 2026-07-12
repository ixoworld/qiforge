import {
  type DynamicModule,
  Logger,
  Module,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import {
  createVerifiedWorkGateFromEnv,
  VERIFIED_WORK_GATE,
} from '../evals/verified-work.js';
import {
  CLAIM_PROCESSING_TOKEN_LIMITER,
  ClaimProcessingService,
} from './claim-processing.service.js';
import { TokenLimiter, type CreditsNetwork } from './token-limiter.js';

/**
 * Options for `ClaimProcessingModule.register`.
 *
 * `TokenLimiter` is stateless — it routes calls to Redis and holds no
 * mutable state outside it. Two instances pointing at the same Redis are
 * functionally identical, so this module builds its own from the supplied
 * Redis client instead of trying to share a single instance across plugins.
 */
export interface ClaimProcessingModuleOptions {
  /** Same `ioredis` client the credits plugin uses. */
  redis: Redis;
  /** Network — drives the credits-per-USD multiplier inside `TokenLimiter`. */
  network: CreditsNetwork;
  /** Whether `DISABLE_CREDITS` is set — relaxes the overdraft guard. */
  disableCredits?: boolean;
}

/**
 * NestJS module shipping the claim-processing cron service. Imported by the
 * runtime via `CreditsPlugin.getNestModules()` when the plugin is loaded
 * with a Redis client. Silent / agent-invisible — no controller, no tools.
 */
@Module({})
export class ClaimProcessingModule {
  static register(opts: ClaimProcessingModuleOptions): DynamicModule {
    const tokenLimiter = new TokenLimiter({
      redis: opts.redis,
      network: opts.network,
      disableCredits: opts.disableCredits ?? false,
    });

    const tokenLimiterProvider: Provider = {
      provide: CLAIM_PROCESSING_TOKEN_LIMITER,
      useValue: tokenLimiter,
    };

    // Verified-work loop (evals plugin): when enabled, a user's held amount
    // only settles while they have no unresolved task claims outstanding.
    // Null when EVALS_VERIFIED_WORK is unset.
    const verifiedWorkGateProvider: Provider = {
      provide: VERIFIED_WORK_GATE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createVerifiedWorkGateFromEnv({
          env: { get: (key) => config.get<string>(key) },
          redis: opts.redis,
          logger: new Logger('VerifiedWorkGate'),
        }),
    };

    return {
      module: ClaimProcessingModule,
      providers: [
        tokenLimiterProvider,
        verifiedWorkGateProvider,
        ClaimProcessingService,
      ],
      exports: [ClaimProcessingService],
    };
  }
}
