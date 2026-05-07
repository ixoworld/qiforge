import { Global, Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WsGateway } from './ws.gateway.js';
import { WsService } from './ws.service.js';

@Global()
@Module({
  imports: [SessionsModule],
  providers: [WsService, WsGateway],
  exports: [WsService],
})
export class WsModule {}
