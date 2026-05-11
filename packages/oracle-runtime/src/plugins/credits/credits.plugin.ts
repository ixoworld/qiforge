import type { Redis } from 'ioredis';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
} from '../../plugin-api/types.js';
import { createCreditsMiddleware } from './credits-middleware.js';
import {
  TokenLimiter,
  type CreditsNetwork,
  type ModelPricingLookup,
} from './token-limiter.js';

/** Constructor options for the credits plugin. */
export interface CreditsPluginOptions {
  /**
   * The ioredis client used for credit balance + atomic limit. `null`
   * disables the middleware (e.g. Redis not configured). Forks pass the
   * same client they already use elsewhere in the app.
   */
  redis?: Redis | null;
  /** Optional per-model pricing lookup; defaults to flat-rate fallback. */
  modelPricingLookup?: ModelPricingLookup;
}

const CreditsConfigSchema = z.object({
  SUBSCRIPTION_URL: z.string().url().optional(),
  SUBSCRIPTION_ORACLE_MCP_URL: z.string().url().optional(),
});

type CreditsConfig = z.infer<typeof CreditsConfigSchema>;

interface AppliedConfig extends CreditsConfig {
  NETWORK?: CreditsNetwork;
  DISABLE_CREDITS?: boolean;
}

/**
 * Enforces per-user credit budgets on every model call. Silent (no
 * agent-visible tools) — runs purely as middleware. Stays loaded by
 * default and only opts out when `DISABLE_CREDITS=true`.
 *
 * When loaded, this plugin also activates the runtime's Tier-0
 * `SubscriptionMiddleware`, which gates the HTTP request before the
 * graph even runs.
 */
export class CreditsPlugin extends OraclePlugin {
  static readonly NAME = 'credits';

  readonly name = CreditsPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest: PluginManifest = {
    title: 'Credits',
    summary:
      'Enforces per-user credit budgets; aborts model calls when the user is out of credits.',
    whenToUse: [],
    visibility: 'silent',
    stability: 'stable',
    category: 'core',
  };

  override readonly configSchema = CreditsConfigSchema;

  override readonly autoDetectHint = 'DISABLE_CREDITS!=true';

  private readonly redis: Redis | null;

  private readonly modelPricingLookup?: ModelPricingLookup;

  constructor(options: CreditsPluginOptions = {}) {
    super();
    this.redis = options.redis ?? null;
    this.modelPricingLookup = options.modelPricingLookup;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return env.DISABLE_CREDITS !== 'true';
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    const config = ctx.config as AppliedConfig;
    const redis = this.redis;

    if (!redis) {
      ctx.logger.warn?.(
        '[CreditsPlugin] No Redis client available — credit limiting disabled at runtime.',
      );
      return [createCreditsMiddleware({ limiter: null, logger: ctx.logger })];
    }

    const limiter = new TokenLimiter({
      redis,
      network: config.NETWORK ?? 'devnet',
      disableCredits: config.DISABLE_CREDITS ?? false,
      modelPricingLookup: this.modelPricingLookup,
      logger: ctx.logger,
    });

    return [createCreditsMiddleware({ limiter, logger: ctx.logger })];
  }
}
