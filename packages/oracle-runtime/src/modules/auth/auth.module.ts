/**
 * @fileoverview Auth module wrapping the UCAN-based auth-header middleware.
 *
 * Provides AuthHeaderMiddleware as a NestJS provider so that
 * RuntimeAppModule can wire it via `MiddlewareConsumer.apply()`.
 */

import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { UcanModule } from '../ucan/ucan.module.js';
import { AuthHeaderMiddleware } from './auth-header.middleware.js';

@Module({
  imports: [ConfigModule, CacheModule.register(), UcanModule],
  providers: [AuthHeaderMiddleware],
  exports: [AuthHeaderMiddleware],
})
export class AuthModule {}
