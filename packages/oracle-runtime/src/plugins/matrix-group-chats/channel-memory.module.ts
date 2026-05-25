import { Global, Module } from '@nestjs/common';
import { ChannelMemoryService } from './channel-memory.service.js';

/**
 * Channel-memory module. Globally exports `ChannelMemoryService` so other
 * plugins / forks can inject it without re-importing the module.
 */
@Global()
@Module({
  providers: [ChannelMemoryService],
  exports: [ChannelMemoryService],
})
export class ChannelMemoryModule {}
