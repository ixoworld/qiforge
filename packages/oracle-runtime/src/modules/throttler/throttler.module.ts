import { Module } from '@nestjs/common';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';

/**
 * Re-exports `@nestjs/throttler` configured with the runtime's default
 * rate-limit policy (10 requests per 60 seconds, applied globally via
 * the `ThrottlerGuard` registered by `RuntimeAppModule`).
 *
 * Forks that need a different policy can swap this module in their
 * own AppModule, but most should leave it alone.
 */
@Module({
  imports: [
    NestThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 10,
      },
    ]),
  ],
  exports: [NestThrottlerModule],
})
export class ThrottlerModule {}
