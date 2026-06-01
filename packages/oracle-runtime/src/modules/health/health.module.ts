import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * Always-on health surface registered by `RuntimeAppModule`. Both routes
 * are auth-excluded so probes (load balancers, k8s liveness/readiness,
 * uptime monitors) can hit the oracle without a UCAN delegation header.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
