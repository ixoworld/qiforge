/**
 * User Preferences plugin — the Workers port of
 * `packages/oracle-runtime/src/plugins/user-preferences`.
 *
 *  - `state.userPreferences` is hydrated by the user object's turn preparer
 *    (through the host `UserPreferencesStore`) BEFORE the agent is built,
 *    so the system prompt sees the value on turn 1 — the Node AgentBuilder
 *    contract.
 *  - Exposes `set_user_preferences`, which the agent calls when the user
 *    asks to change behavioural preferences (tone, language, formality,
 *    what to call the agent / the user).
 *  - Ships `GET /user-preferences` (the NestJS controller became a
 *    `getRoutes()` entry): the caller's preferences, or `null`.
 *
 * Storage is the room's `ixo.room.state` / `user_prefs` event in the Node
 * envelope, so preferences survive a Node ⇄ Workers migration intact.
 */
import type { OracleWorkerEnv } from '../../do/contracts';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type { PluginRoute } from '../../shell/app';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types';
import {
  UserPreferencesStore,
  type RoomStateAccess,
} from './user-preferences-store';
import {
  createSetUserPreferencesTool,
  SET_USER_PREFERENCES_TOOL_NAME,
} from './user-preferences-tool';

/** What the route needs from the Matrix gateway: room lookup + room state. */
export interface PreferencesGateway extends RoomStateAccess {
  resolveUserRoom(
    userDid: string,
  ): Promise<{ roomId: string; alias: string } | null>;
}

export interface UserPreferencesPluginOptions {
  /**
   * Resolves the oracle's Matrix gateway for a request. Defaults to the
   * `MATRIX_GATEWAY` Durable Object stub; tests inject a fake.
   */
  gatewayFor?: (env: OracleWorkerEnv) => PreferencesGateway;
}

function defaultGatewayFor(env: OracleWorkerEnv): PreferencesGateway {
  const id = env.MATRIX_GATEWAY.idFromName(env.ORACLE_DID);
  return env.MATRIX_GATEWAY.get(id);
}

const manifest: PluginManifest = {
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
      thought: 'Behavioral preference about language — save it so it persists.',
      tool: SET_USER_PREFERENCES_TOOL_NAME,
      args: { language: 'Spanish' },
    },
    {
      user: 'Be more concise — drop the explanations.',
      thought: 'Preference about tone/length, not a single-turn request.',
      tool: SET_USER_PREFERENCES_TOOL_NAME,
      args: { tone: 'concise' },
    },
  ],
  visibility: 'always',
  stability: 'stable',
  category: 'core',
};

export class UserPreferencesPlugin extends OraclePlugin {
  readonly name = 'user-preferences';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  private readonly gatewayFor: (env: OracleWorkerEnv) => PreferencesGateway;

  constructor(options: UserPreferencesPluginOptions = {}) {
    super();
    this.gatewayFor = options.gatewayFor ?? defaultGatewayFor;
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    return [createSetUserPreferencesTool({ logger: ctx.logger })];
  }

  override getRoutes(ctx: PluginContext): PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/user-preferences',
        handler: async (_request, env, { auth }) => {
          if (!auth) {
            return Response.json(
              { statusCode: 401, message: 'Unauthorized' },
              { status: 401 },
            );
          }
          const gateway = this.gatewayFor(env);
          const room = await gateway.resolveUserRoom(auth.userDid);
          if (!room) {
            ctx.logger.warn(
              `[user-preferences] could not resolve user↔oracle room for userDid=${auth.userDid}`,
            );
            return Response.json(null);
          }
          const store = new UserPreferencesStore(gateway, {
            logger: ctx.logger,
          });
          const prefs = await store.get(room.roomId);
          ctx.logger.log(
            `[user-preferences] fetched for userDid=${auth.userDid}, roomId=${room.roomId}: ${prefs ? 'Found' : 'null'}`,
          );
          return Response.json(prefs ?? null);
        },
      },
    ];
  }
}
