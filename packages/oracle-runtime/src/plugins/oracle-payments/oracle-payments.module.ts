import {
  Inject,
  Logger,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { RedisActiveEngagementCache } from './active-engagement-cache.js';
import { AgentCardService } from './agent-card.service.js';
import { ClaimStatusWatcher } from './claim-status.watcher.js';
import { CommerceRouterPortRegistrar } from './commerce-port.registrar.js';
import { ContractGateService } from './contract-gate.service.js';
import { ContractRecordService } from './contract-record.service.js';
import { ContractedEventListener } from './contracted-event.listener.js';
import { EngagementService } from './engagement.service.js';
import { WorkClaimService } from './work-claim.service.js';
import { WorkClaimWiring } from './work-claim.wiring.js';
import { WorkIntentService } from './work-intent.service.js';

/**
 * The plugin's own Redis connection, or `null` when the oracle runs without
 * one. Created by the factory that points the engagement replica at it, so the
 * module can close it on shutdown.
 */
const ENGAGEMENT_CACHE_REDIS = Symbol('ORACLE_PAYMENTS_ENGAGEMENT_CACHE_REDIS');

export interface OraclePaymentsModuleServices {
  agentCard: AgentCardService;
  contractRecord: ContractRecordService;
  engagement: EngagementService;
  contractGate: ContractGateService;
  workIntent: WorkIntentService;
  workClaim: WorkClaimService;
}

/**
 * Nest module for the oracle-payments plugin. Provides the plugin's resolver +
 * lookup services (as the same instances the request tools and shared-state
 * accessor use), the `ixo.oracle.contracted` cache-bust listener (which also
 * wires the engine token provider onto {@link ContractRecordService} at boot),
 * the registrar that plugs the plugin's commerce knowledge into the core
 * message router's port slot, the wiring that hands the delivery lane the
 * oracle's claim-signing key, and the cron that reports each submitted claim's
 * evaluation outcome back into its thread.
 *
 * It also decides where the per-user active-engagement replica lives: a
 * dedicated Redis connection when the oracle is deployed with `REDIS_URL`
 * (shared across replicas, survives restarts), the service's own in-process
 * map otherwise. `REDIS_URL` is deliberately NOT declared in this plugin's
 * config schema — the tasks plugin owns that key and requires it, and a second
 * declaration would silently override its validation.
 */
@Module({})
export class OraclePaymentsModule implements OnModuleDestroy {
  constructor(
    @Inject(ENGAGEMENT_CACHE_REDIS) private readonly redis: Redis | null,
  ) {}

  static register(services: OraclePaymentsModuleServices): DynamicModule {
    return {
      module: OraclePaymentsModule,
      providers: [
        {
          provide: ENGAGEMENT_CACHE_REDIS,
          inject: [ConfigService],
          useFactory: (config: ConfigService): Redis | null => {
            const url = config.get<string>('REDIS_URL');
            const logger = new Logger(OraclePaymentsModule.name);
            if (!url) {
              logger.log(
                '[oracle-payments] no REDIS_URL — the active-engagement replica is in-process only.',
              );
              return null;
            }
            // Default retry cap (unlike the BullMQ connection): a Redis
            // outage must fail the replica read fast and fall through to the
            // durable Matrix record, never queue behind a dead socket.
            const redis = new Redis(url, { enableReadyCheck: true });
            services.engagement.setCacheStore(
              new RedisActiveEngagementCache(
                {
                  get: (key) => redis.get(key),
                  set: async (key, value, ttlSeconds) => {
                    await redis.set(key, value, 'EX', ttlSeconds);
                  },
                  del: async (key) => {
                    await redis.del(key);
                  },
                },
                logger,
              ),
            );
            logger.log(
              '[oracle-payments] active-engagement replica on Redis (REDIS_URL is set).',
            );
            return redis;
          },
        },
        { provide: AgentCardService, useValue: services.agentCard },
        { provide: ContractRecordService, useValue: services.contractRecord },
        { provide: EngagementService, useValue: services.engagement },
        { provide: ContractGateService, useValue: services.contractGate },
        { provide: WorkIntentService, useValue: services.workIntent },
        { provide: WorkClaimService, useValue: services.workClaim },
        ClaimStatusWatcher,
        ContractedEventListener,
        CommerceRouterPortRegistrar,
        WorkClaimWiring,
      ],
      exports: [
        AgentCardService,
        ContractRecordService,
        EngagementService,
        ContractGateService,
        WorkIntentService,
        WorkClaimService,
        ClaimStatusWatcher,
      ],
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }
}
