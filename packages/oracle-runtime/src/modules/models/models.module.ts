import { Module } from '@nestjs/common';
import { ModelsController } from './models.controller.js';
import { ModelsService } from './models.service.js';

/**
 * Always-on core module exposing the `GET /models` catalog. Depends only on
 * the global `ConfigModule`; the price fetch and catalog live in `llm/`.
 */
@Module({
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
