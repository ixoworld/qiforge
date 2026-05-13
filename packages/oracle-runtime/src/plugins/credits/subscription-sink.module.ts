import { type DynamicModule, Logger, Module, type Provider } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  SUBSCRIPTION_CREDIT_SINK,
  type SubscriptionCreditSink,
} from '../../modules/subscription/subscription.middleware.js';
import { TokenLimiter, type CreditsNetwork } from './token-limiter.js';

export interface SubscriptionSinkModuleOptions {
  redis: Redis;
  network: CreditsNetwork;
  disableCredits?: boolean;
}

const SINK_LOGGER = new Logger('SubscriptionCreditSink');

/**
 * Wires `SUBSCRIPTION_CREDIT_SINK` for `SubscriptionMiddleware`. The
 * adapter mirrors the per-DID subscription payload + balance into Redis
 * via a `TokenLimiter` instance, so the credits middleware on the LLM
 * hot path reads up-to-date budgets without re-hitting the subscription
 * API.
 *
 * TokenLimiter is stateless (state lives in Redis); the instance here
 * is independent of the one used in `getMiddlewares` or
 * `ClaimProcessingModule` — they share Redis so the data is consistent.
 */
@Module({})
export class SubscriptionSinkModule {
  static register(opts: SubscriptionSinkModuleOptions): DynamicModule {
    const limiter = new TokenLimiter({
      redis: opts.redis,
      network: opts.network,
      disableCredits: opts.disableCredits ?? false,
      logger: {
        log: (msg) => SINK_LOGGER.log(msg),
        warn: (msg) => SINK_LOGGER.warn(msg),
        error: (msg) => SINK_LOGGER.error(msg),
      },
    });

    const sink: SubscriptionCreditSink = {
      setSubscriptionPayload: limiter.setSubscriptionPayload.bind(limiter),
      overrideUserBalance: limiter.overrideUserBalance.bind(limiter),
    };

    const provider: Provider = {
      provide: SUBSCRIPTION_CREDIT_SINK,
      useValue: sink,
    };

    return {
      module: SubscriptionSinkModule,
      providers: [provider],
      exports: [provider],
      global: true,
    };
  }
}
