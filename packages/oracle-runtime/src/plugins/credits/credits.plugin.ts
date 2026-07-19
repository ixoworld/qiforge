import type { DynamicModule, Type } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
} from '../../plugin-api/types.js';
import { ClaimProcessingModule } from './claim-processing.module.js';
import { createCreditsMiddleware } from './credits-middleware.js';
import { FileProcessingSinkModule } from './file-processing-sink.module.js';
import { SubscriptionSinkModule } from './subscription-sink.module.js';
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
  /**
   * Network tier — required when `redis` is set, so the claim-processing
   * Nest module can construct its `TokenLimiter` at boot. Omitted in tests
   * that don't exercise the cron path.
   */
  network?: CreditsNetwork;
  /** Optional per-model pricing lookup; defaults to flat-rate fallback. */
  modelPricingLookup?: ModelPricingLookup;
}

const CreditsConfigSchema = z.object({
  SUBSCRIPTION_URL: z.url().optional(),
  SUBSCRIPTION_ORACLE_MCP_URL: z.url().optional(),
  // Env vars are strings — coerce here so consumers get a real boolean
  // (`Boolean('false')` is true; only the literal 'true' disables credits).
  DISABLE_CREDITS: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Minimum held credits before the claim-processing cron settles a claim
  // on-chain. Validated when set; when unset, the claim-processing service
  // applies its own default (prevents spamming the chain with tiny txns).
  MINIMUM_CLAIM_THRESHOLD: z.coerce.number().int().positive().optional(),
});

type CreditsConfig = z.infer<typeof CreditsConfigSchema>;

interface AppliedConfig extends Omit<CreditsConfig, 'DISABLE_CREDITS'> {
  NETWORK?: CreditsNetwork;
  // Optional at the type level: `ctx.config` is a plain merged-env bag, the
  // key is only present once the composed schema has run.
  DISABLE_CREDITS?: boolean;
}

/**
 * Owns the full credit lifecycle:
 *   - **Enforcement**: per-request middleware that aborts model calls when
 *     the user is out of credits (`createCreditsMiddleware` + `TokenLimiter`).
 *   - **Settlement**: background cron that converts held credits into
 *     on-chain claims, shipped via `ClaimProcessingModule` (returned from
 *     `getNestModules()` when Redis is configured).
 *
 * Silent (no agent-visible tools). Stays loaded by default and only opts
 * out when `DISABLE_CREDITS=true`. When loaded, this plugin also activates
 * the runtime's Tier-0 `SubscriptionMiddleware`, which gates the HTTP
 * request before the graph even runs.
 */
export class CreditsPlugin extends OraclePlugin {
  static readonly NAME = 'credits';

  readonly name = CreditsPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest: PluginManifest = {
    title: 'Credits',
    summary:
      'Enforces per-user credit budgets and settles held credits to the chain on a cron.',
    whenToUse: [],
    visibility: 'silent',
    stability: 'stable',
    category: 'core',
    providesRequestGate: true,
  };

  override readonly configSchema = CreditsConfigSchema;

  override readonly autoDetectHint = 'DISABLE_CREDITS!=true';

  private readonly redis: Redis | null;

  private readonly network?: CreditsNetwork;

  private readonly modelPricingLookup?: ModelPricingLookup;

  constructor(options: CreditsPluginOptions = {}) {
    super();
    this.redis = options.redis ?? null;
    this.network = options.network;
    this.modelPricingLookup = options.modelPricingLookup;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return env.DISABLE_CREDITS !== 'true';
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [this.resolveMeteringMiddleware(ctx)];
  }

  /**
   * The SAME metering middleware instance also runs inside every sub-agent
   * loop — a credit gate that guards only the outer loop is a gate the
   * outer loop can walk around by delegating. Sharing one instance keeps
   * reservation pairing on one map across both stacks.
   */
  override getSubAgentMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [this.resolveMeteringMiddleware(ctx)];
  }

  private meteringMiddleware: AgentMiddleware | null = null;

  private resolveMeteringMiddleware(ctx: PluginContext): AgentMiddleware {
    if (this.meteringMiddleware) return this.meteringMiddleware;

    const config = ctx.config as AppliedConfig;
    const redis = this.redis;

    if (!redis) {
      ctx.logger.warn?.(
        '[CreditsPlugin] No Redis client available — credit limiting disabled at runtime.',
      );
      this.meteringMiddleware = createCreditsMiddleware({
        limiter: null,
        logger: ctx.logger,
      });
      return this.meteringMiddleware;
    }

    const limiter = new TokenLimiter({
      redis,
      network: config.NETWORK ?? 'devnet',
      disableCredits: config.DISABLE_CREDITS,
      modelPricingLookup: this.modelPricingLookup,
      logger: ctx.logger,
    });

    this.meteringMiddleware = createCreditsMiddleware({
      limiter,
      logger: ctx.logger,
    });
    return this.meteringMiddleware;
  }

  override getNestModules(): Array<Type | DynamicModule> {
    // All three modules require Redis + a known network. Host opt-in is
    // explicit: pass both to the plugin's constructor.
    //
    //   1. ClaimProcessingModule — cron that settles held credits on chain.
    //   2. FileProcessingSinkModule — `FILE_PROCESSING_CREDIT_SINK` so
    //      pre-flight file-processing LLM usage bills the per-user budget.
    //   3. SubscriptionSinkModule — `SUBSCRIPTION_CREDIT_SINK` so the
    //      subscription middleware mirrors per-DID subscription payload +
    //      balance into Redis on every authenticated request, keeping the
    //      LLM-hot-path credits middleware in sync with the chain.
    if (!this.redis || !this.network) return [];
    return [
      ClaimProcessingModule.register({
        redis: this.redis,
        network: this.network,
      }),
      FileProcessingSinkModule.register({
        redis: this.redis,
        network: this.network,
      }),
      SubscriptionSinkModule.register({
        redis: this.redis,
        network: this.network,
      }),
    ];
  }
}
