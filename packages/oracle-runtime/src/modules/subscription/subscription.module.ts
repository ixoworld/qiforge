import { Module } from '@nestjs/common';
import { SubscriptionMiddleware } from './subscription.middleware.js';

/**
 * Wraps `SubscriptionMiddleware` so `RuntimeAppModule` can pull it in via
 * `MiddlewareConsumer.apply(...)`. The middleware itself is the unit of
 * work — this module just owns the provider registration.
 *
 * `UcanService` flows in via Nest's global UCAN module (always present).
 * `SUBSCRIPTION_CREDIT_SINK` is plugin-supplied (credits plugin's
 * `getNestModules()`); the middleware tolerates it being absent.
 */
@Module({
  providers: [SubscriptionMiddleware],
  exports: [SubscriptionMiddleware],
})
export class SubscriptionModule {}
