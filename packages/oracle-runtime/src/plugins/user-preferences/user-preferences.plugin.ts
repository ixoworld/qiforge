import type { DynamicModule, Type } from '@nestjs/common';
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
import { UserPreferencesHttpModule } from './user-preferences-http.module.js';
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
      'Behavioral preferences — how the user wants you to respond (tone, language, formality, what to call you).',
    whenToUse: [
      'User states how they want you to behave: "be more terse", "respond in Spanish", "call me Alex", "stop using emojis".',
      'User asks to change the voice, formality, or language of your replies — save it so it persists across sessions, not just this turn.',
    ],
    whenNotToUse: [
      'Facts about who the user is (name, role, project) — those go to memory, not preferences.',
      'Artifacts you have produced or how the user reacted to them — also memory, not preferences.',
      'One-turn formatting requests ("just for this answer, use bullets") — adapt locally without saving.',
    ],
    examples: [
      {
        user: 'From now on, please respond in Spanish.',
        thought:
          'Behavioral preference about language — save it so it persists.',
        tool: 'set_user_preferences',
        args: { language: 'Spanish' },
      },
      {
        user: 'Be more concise — drop the explanations.',
        thought: 'Preference about tone/length, not a single-turn request.',
        tool: 'set_user_preferences',
        args: { tone: 'concise' },
      },
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

  override getNestModules(): Array<Type | DynamicModule> {
    // Ships `GET /user-preferences` only when this plugin is loaded.
    return [UserPreferencesHttpModule];
  }
}
