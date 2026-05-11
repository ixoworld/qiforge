import type { Type } from '@nestjs/common';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../../plugin-api/types.js';
import { SlackModule } from './slack.module.js';

const configSchema = z.object({
  SLACK_BOT_OAUTH_TOKEN: z.string(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_USE_SOCKET_MODE: z.string().default('true'),
  SLACK_MAX_RECONNECT_ATTEMPTS: z.coerce.number().default(10),
  SLACK_RECONNECT_DELAY_MS: z.coerce.number().default(1000),
});

/**
 * Slack transport plugin. Ships its own NestJS module so the bot client can
 * use `OnModuleInit`/`OnModuleDestroy` for socket-mode lifecycle and inject
 * the Tier-0 services it needs (messages, sessions, cache). The plugin
 * itself contributes no agent-visible tools — slack is purely a transport.
 *
 * Auto-detects via `SLACK_BOT_OAUTH_TOKEN`; if the token is missing the
 * plugin is skipped at boot and no module is registered.
 */
export class SlackPlugin extends OraclePlugin {
  static readonly NAME = 'slack';

  readonly name = SlackPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest: PluginManifest = {
    title: 'Slack',
    summary:
      'Slack bot transport — runs as a NestJS module with socket-mode lifecycle.',
    whenToUse: [],
    visibility: 'silent',
    stability: 'stable',
    category: 'core',
  };

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'SLACK_BOT_OAUTH_TOKEN';

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.SLACK_BOT_OAUTH_TOKEN);
  }

  override getNestModules(): Type[] {
    return [SlackModule];
  }
}
