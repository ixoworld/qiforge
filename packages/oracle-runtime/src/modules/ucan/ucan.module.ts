/**
 * @fileoverview UCAN module for Oracle
 *
 * This module provides UCAN authorization services for the Oracle application.
 */

import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DelegationStore } from './delegation-store.js';
import { UcanService } from './ucan.service.js';

/**
 * UCAN Module
 *
 * Provides UCAN authorization services for MCP tool invocations.
 * Marked as @Global so the UcanService can be injected anywhere.
 *
 * @example
 * ```typescript
 * // In your app.module.ts
 * @Module({
 *   imports: [UcanModule],
 * })
 * export class AppModule {}
 *
 * // Then inject UcanService where needed
 * @Injectable()
 * class MyService {
 *   constructor(private readonly ucanService: UcanService) {}
 * }
 * ```
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [DelegationStore, UcanService],
  exports: [UcanService],
})
export class UcanModule {}
