import { Module } from '@nestjs/common';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';

/**
 * Re-exports `@nestjs/throttler` configured with the runtime's default
 * rate-limit policy (10 requests per 60 seconds, applied globally via
 * the `ThrottlerGuard` registered by `RuntimeAppModule`).
 *
 * `THROTTLE_LIMIT` / `THROTTLE_TTL_MS` override the policy. Note the guard
 * buckets by `req.ip` and the app does not enable Express `trust proxy`, so
 * every client behind one proxy/NAT shares a single bucket — load tests from
 * one machine (and deployments behind a load balancer) need the override.
 *
 * Forks that need a different policy can swap this module in their
 * own AppModule, but most should leave it alone.
 */
function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [
    NestThrottlerModule.forRoot([
      {
        ttl: intFromEnv('THROTTLE_TTL_MS', 60000),
        limit: intFromEnv('THROTTLE_LIMIT', 10),
      },
    ]),
  ],
  exports: [NestThrottlerModule],
})
export class ThrottlerModule {}
