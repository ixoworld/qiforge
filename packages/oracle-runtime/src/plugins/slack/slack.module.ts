import { Global, Module } from '@nestjs/common';
import { MessagesModule } from '../../modules/messages/messages.module.js';
import { SessionsModule } from '../../modules/sessions/sessions.module.js';
import { SlackService } from './slack.service.js';

/**
 * NestJS module shipping `SlackService`. Imported by `RuntimeAppModule` when
 * the slack plugin is loaded — the plugin returns this class from its
 * `getNestModules()` hook. `OnModuleInit` opens the Slack socket; the
 * Tier-0 messages/sessions modules supply the DI it needs.
 */
@Global()
@Module({
  providers: [SlackService],
  exports: [SlackService],
  imports: [MessagesModule, SessionsModule],
})
export class SlackModule {}
