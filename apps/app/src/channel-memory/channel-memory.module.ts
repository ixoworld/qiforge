import { Global, Module } from '@nestjs/common';
import { ChannelMemoryService } from './channel-memory.service';

@Global()
@Module({
  providers: [ChannelMemoryService],
  exports: [ChannelMemoryService],
})
export class ChannelMemoryModule {}
