import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Always-on health surface. Both routes are excluded from the auth
 * middleware (see `RuntimeAppModule.AUTH_EXCLUDED_ROUTES`) so probes
 * (Railway, Fly, k8s liveness/readiness) and a friendly landing page
 * can hit the oracle without a UCAN delegation header.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Root — oracle landing.' })
  root() {
    return {
      status: 'ok',
      message: 'QiForge oracle is running. See /docs for the API.',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health')
  @ApiOperation({ summary: 'Liveness probe.' })
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
