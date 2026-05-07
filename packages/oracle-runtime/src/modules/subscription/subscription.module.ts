import { Module } from '@nestjs/common';
import { SubscriptionMiddleware } from './subscription.middleware.js';

/**
 * Wraps `SubscriptionMiddleware` so `RuntimeAppModule` can pull it in via
 * `MiddlewareConsumer.apply(...)`. The middleware itself is the unit of
 * work — this module just owns the provider registration.
 *
 * Optional ports (`SUBSCRIPTION_UCAN_PORT`, `SUBSCRIPTION_CREDIT_SINK`)
 * are wired by their respective modules (UCAN module, credits plugin).
 * The middleware tolerates either being absent.
 */
@Module({
  providers: [SubscriptionMiddleware],
  exports: [SubscriptionMiddleware],
})
export class SubscriptionModule {}
