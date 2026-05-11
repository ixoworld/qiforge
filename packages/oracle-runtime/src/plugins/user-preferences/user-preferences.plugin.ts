import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import {
  UserPreferencesService,
  type UserPreferencesReader,
  type UserPreferencesWriter,
} from './service/user-preferences.service.js';
import { createUserPreferencesMiddleware } from './user-preferences-middleware.js';
import { createSetUserPreferencesTool } from './user-preferences-tool.js';

/** Service contract the plugin needs: read for the middleware, write for the tool. */
export type UserPreferencesPluginService = UserPreferencesReader &
  UserPreferencesWriter;

/**
 * Loads per-room user preferences (preferred user name, agent name, language,
 * tone, formality, custom instructions) into `state.userPreferences` before
 * each model call, and exposes a `set_user_preferences` tool the agent can
 * call when the user asks to change how it behaves.
 */
export class UserPreferencesPlugin extends OraclePlugin {
  readonly name = 'user-preferences';

  readonly version = '1.0.0';

  readonly manifest: PluginManifest = {
    title: 'User Preferences',
    summary:
      'Loads per-room user preferences into the system prompt and lets the agent update them.',
    whenToUse: [
      'User asks to change how the agent behaves (tone, formality, language) or what to call them.',
    ],
    visibility: 'always',
    stability: 'stable',
    category: 'core',
  };

  private readonly service: UserPreferencesPluginService;

  constructor(
    service: UserPreferencesPluginService = UserPreferencesService.getInstance(),
  ) {
    super();
    this.service = service;
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [
      createUserPreferencesMiddleware({
        service: this.service,
        logger: ctx.logger,
      }),
    ];
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    return [
      createSetUserPreferencesTool({
        service: this.service,
        logger: ctx.logger,
      }),
    ];
  }
}
