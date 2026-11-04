import {
  defineDecision,
  OraclePlugin,
  type AgentMiddleware,
  type AuthExcludedRoute,
  type MergedConfig,
  type PluginEnv,
  type PluginManifest,
  type PluginRoute,
  type PluginTool,
  type RuntimeContext,
} from '../../plugin-api';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { channelOriginsOf } from './attach';
import type { AsksWorkerEnv } from './connection';
import { ASKS_OPERATING_GUIDE } from './guide';
import { asksMcpUrlOf, deriveKeys, objectNameOf, type AsksKeys } from './oauth';
import { asksRoutes, connectionOf } from './routes';
import {
  asksSkillDecisionOptions,
  lastHumanText,
  pickSkill,
} from './skill-pick';
import {
  AsksSkills,
  folderOf,
  workersSkillCache,
  type Skill,
  type SkillFolder,
} from './skills';
import {
  asksTools,
  connectAsksMcp,
  keepTurnFiles,
  preloadText,
  type McpConnect,
} from './tools';

const configSchema = z.object({
  /** Seals the tokens and names each person's connection object (`openssl rand -base64 32`). */
  ASKS_TOKEN_KEY: z
    .string()
    .min(32, 'ASKS_TOKEN_KEY must be at least 32 characters.'),
  /** `https://wa.me/<number>?text=…`: the callback page's "Back to WhatsApp". */
  ASKS_WHATSAPP_RETURN_URL: z.string().url().optional(),
  /** Pilot: comma-separated user DIDs who get asks. Unset: everyone. */
  ASKS_ALLOWED_DIDS: z.string().optional(),
});

const manifest: PluginManifest = {
  title: 'asks.world',
  summary:
    'asks.world: find paid work and get paid, post asks real people answer, get an app or agent reviewed by verified pros, and see or cash out asks money.',
  // The on-demand catalogue's line (runtime 0.39+, at most 60 characters).
  brief: 'paid work, asks people answer, pro reviews, asks money',
  whenToUse: [
    'The person mentions asks.world or an ask, wants paid work or to apply to one, has an invitation to an ask, or wants to hand in an answer or a report.',
    'The person wants to hire someone, have something checked or found out somewhere they cannot see, or get an app or agent reviewed by pros.',
    'The person asks about their asks money, earnings or cash-out, their pro page, or whether anyone answered their ask.',
  ],
  whenNotToUse: [
    'IXO wallet balances, chain transactions or other on-chain actions (asks money is separate).',
    'General web research or tasks that need no person on asks.world.',
  ],
  tags: ['asks', 'work', 'jobs', 'payments', 'reviews'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'beta',
};

export interface AsksPluginOptions {
  /** The Worker env: the binding, vars and secret. Default: `env` from `cloudflare:workers`. */
  env?: () => AsksWorkerEnv;
  connect?: McpConnect;
  fetch?: typeof fetch;
}

/** Loaded on first use, so the plain-Node test suites can import the plugin. */
const workerEnv = async (): Promise<AsksWorkerEnv> => {
  // The host's Env type is its own; the plugin reads only its optional keys.
  const env: object = (await import('cloudflare:workers')).env;
  return env;
};

/**
 * asks.world through its hosted connector (`/v1/mcp` on the asks host for
 * `NETWORK`), signed in once per person with OAuth (asks' Google login).
 * See `docs/asks.md` and `guide.ts` for how the model is told to use it.
 */
export class AsksPlugin extends OraclePlugin {
  static readonly NAME = 'asks';

  readonly name = AsksPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly operatingGuide = ASKS_OPERATING_GUIDE;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint =
    'ASKS_TOKEN_KEY, ORACLE_PUBLIC_URL and NETWORK (mainnet, testnet or devnet)';

  private keys: Promise<AsksKeys> | null = null;

  private readonly skillSets = new Map<SkillFolder, AsksSkills>();

  private readonly decision = defineDecision(asksSkillDecisionOptions);

  constructor(private readonly options: AsksPluginOptions = {}) {
    super();
  }

  override autoDetect(env: PluginEnv): boolean {
    // The secret too: a deploy before it is set leaves asks off instead of failing the boot.
    const set = ['ASKS_TOKEN_KEY', 'ORACLE_PUBLIC_URL'].every(
      (key) => typeof env[key] === 'string' && env[key].length > 0,
    );
    if (!set) return false;
    if (asksMcpUrlOf(env['NETWORK'])) return true;
    // Never guess a network: the wrong one is the wrong money. No logger here.
    // eslint-disable-next-line no-console
    console.warn(
      `[asks] off: NETWORK is ${typeof env['NETWORK'] === 'string' ? `"${env['NETWORK']}"` : 'not set'}; asks needs mainnet, testnet or devnet`,
    );
    return false;
  }

  private allowed(config: MergedConfig, did: string): boolean {
    const list = configSchema.parse(config).ASKS_ALLOWED_DIDS;
    return !list?.trim() || list.split(/[\s,]+/).includes(did);
  }

  private skillsFor(rtCtx: RuntimeContext): Promise<Skill[]> {
    const folder = folderOf(rtCtx.config.NETWORK);
    let set = this.skillSets.get(folder);
    if (!set) {
      set = new AsksSkills({
        folder,
        fetch: (input, init) => (this.options.fetch ?? fetch)(input, init),
        now: () => Date.now(),
        cache: workersSkillCache(),
        warn: (line) => rtCtx.logger.warn(line),
      });
      this.skillSets.set(folder, set);
    }
    return set.skills(rtCtx.background);
  }

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    if (!this.allowed(rtCtx.config, rtCtx.user.did)) return [];
    const config = configSchema.parse(rtCtx.config);
    const mcpUrl = asksMcpUrlOf(rtCtx.config.NETWORK);
    if (!mcpUrl) return [];
    const env = this.options.env ? this.options.env() : await workerEnv();
    this.keys ??= deriveKeys(config.ASKS_TOKEN_KEY);
    const objectName = await objectNameOf(await this.keys, rtCtx.user.did);
    const conn = connectionOf(env, objectName);
    if (!conn) {
      rtCtx.logger.warn(
        '[asks] the ASKS_CONNECTIONS binding is missing: no asks tools',
      );
      return [];
    }
    await keepTurnFiles(rtCtx).catch((error: unknown) =>
      rtCtx.logger.warn(
        `[asks] could not keep this turn's files: ${String(error)}`,
      ),
    );
    return asksTools({
      ctx: rtCtx,
      conn,
      mcpUrl,
      channelOrigins: channelOriginsOf(env.CHANNEL_SERVICE_DID),
      skills: await this.skillsFor(rtCtx),
      connect: this.options.connect ?? connectAsksMcp,
      fetch: (input, init) => (this.options.fetch ?? fetch)(input, init),
      now: () => Date.now(),
    });
  }

  /** With asks loaded for the turn: the skill the message needs, in the prompt before the first model call. */
  override async getRequestMiddlewares(
    rtCtx: RuntimeContext,
  ): Promise<AgentMiddleware[]> {
    if (
      !rtCtx.loadedPlugins.has(this.name) ||
      !this.allowed(rtCtx.config, rtCtx.user.did)
    )
      return [];
    const skills = await this.skillsFor(rtCtx);
    let picked: Promise<Skill | null> | null = null;
    return [
      createMiddleware({
        name: 'AsksSkillPreload',
        wrapModelCall: async (request, handler) => {
          picked ??= pickSkill(
            rtCtx.decisions,
            this.decision,
            lastHumanText(request.messages),
            skills,
            rtCtx.abortSignal,
          );
          const skill = await picked;
          return skill
            ? handler({
                ...request,
                systemMessage: request.systemMessage.concat(preloadText(skill)),
              })
            : handler(request);
        },
      }),
    ];
  }

  override getRoutes(): PluginRoute[] {
    return asksRoutes();
  }

  override getAuthExcludedRoutes(): AuthExcludedRoute[] {
    return asksRoutes().map(({ path }) => ({ path, method: 'GET' as const }));
  }
}
