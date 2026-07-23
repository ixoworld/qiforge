import type { DynamicModule, Type } from '@nestjs/common';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  MergedConfig,
  PluginContext,
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { AgentCardService } from './agent-card.service.js';
import { ContractGateService } from './contract-gate.service.js';
import { ContractRecordService } from './contract-record.service.js';
import { EngagementService } from './engagement.service.js';
import {
  deriveManifestFromCard,
  loadLocalAgentCard,
  type LocalAgentCard,
} from './local-card.js';
import { OraclePaymentsModule } from './oracle-payments.module.js';
import { ThreadAttachmentService } from './thread-attachments.service.js';
import {
  createOraclePaymentsTools,
  createOraclePaymentsWorkTools,
} from './tools.js';
import { readConfigString } from './util.js';
import {
  DEFAULT_MAX_DELIVERABLE_MB,
  WorkClaimService,
} from './work-claim.service.js';
import { WorkIntentService } from './work-intent.service.js';
import { WorkSummaryExtractor } from './work-summary-extractor.js';

const configSchema = z.object({
  // Env vars are strings — only the literal 'true' opts the plugin out.
  ORACLE_PAYMENTS_DISABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  EVAL_ENGINE_URL: z.url().optional(),
  AGENT_CARD_PATH: z.string().optional(),
  /** Classifier model override for the commerce message router. */
  ORACLE_PAYMENTS_ROUTER_MODEL: z.string().optional(),
  /** Model override for the trusted request/workSummary extractor. */
  ORACLE_PAYMENTS_EXTRACTOR_MODEL: z.string().optional(),
  /** Size ceiling for a single delivered file. */
  ORACLE_PAYMENTS_MAX_DELIVERABLE_MB: z.coerce
    .number()
    .positive()
    .default(DEFAULT_MAX_DELIVERABLE_MB),
  /** Portal base URL — makes the receipt card's claim deep link. */
  PORTAL_URL: z.url().optional(),
});

const manifest: PluginManifest = {
  title: 'Oracle Payments',
  summary:
    "Discover, contract, and check status of this oracle's paid services from the chat: show the service catalog, propose a contract, and report whether the user is contracted.",
  whenToUse: [
    'User asks what you can do for them, what services you offer, or how much something costs.',
    'User wants to hire or contract you for a specific task, or asks how to get started with paid work.',
    'User asks whether they are already contracted, or how much of their quota / runs remain.',
  ],
  whenNotToUse: [
    'Answering a free support question itself — reply normally; reach for these tools only to show services, propose a contract, or check status.',
    'Performing the contracted work — that is the work persona, not these support tools.',
  ],
  examples: [
    {
      user: 'What can you do for me?',
      thought: 'The user is asking about services — show the catalog card.',
      tool: 'list_services',
    },
    {
      user: 'How do I hire you for a tax report?',
      thought: 'The user wants to contract a specific service.',
      tool: 'show_contract',
      args: { serviceId: 'tax-report' },
    },
    {
      user: 'Am I already contracted? How many runs do I have left?',
      thought: 'Read-only status question.',
      tool: 'get_contract_status',
    },
  ],
  tags: ['payments', 'contracting', 'services', 'commerce'],
  category: 'ui',
  visibility: 'always',
  stability: 'beta',
};

export interface OraclePaymentsPluginOptions {
  /** Override the card resolver (tests inject a stub with no network). */
  agentCard?: AgentCardService;
  /** Override the engine contract-lookup client. */
  contractRecord?: ContractRecordService;
  /** Override the thread-engagement store (tests stub the Matrix state read). */
  engagement?: EngagementService;
  /** Override the contract gate (otherwise built at module time). */
  contractGate?: ContractGateService;
  /** Override the escrow-first engagement start (tests inject a stub chain). */
  workIntent?: WorkIntentService;
  /** Override the trusted request/workSummary extractor. */
  extractor?: WorkSummaryExtractor;
  /** Override the delivery lane (tests inject stub uploads + chain). */
  workClaim?: WorkClaimService;
  /** Override the thread-attachment listing service. */
  threadAttachments?: ThreadAttachmentService;
}

/**
 * The Matrix agent-commerce plugin. Resolves the oracle's Agent Card, looks
 * up per-subscriber contract records from the engine, stores thread-scoped
 * work engagements, and registers the commerce router port so the core
 * message router can classify support vs work per turn. Support mode exposes
 * `list_services` / `show_contract` / `get_contract_status`; work mode swaps
 * them for the work surface — `cancel_work` now, `deliver_work` in the
 * delivery lane.
 *
 * `autoDetect` keeps the plugin on wherever the oracle has an entity DID (always
 * true today, base-required); runtime behavior is a no-op until a card resolves.
 * `ORACLE_PAYMENTS_DISABLED=true` opts out.
 */
export class OraclePaymentsPlugin extends OraclePlugin {
  static readonly NAME = 'oracle-payments';

  readonly name = OraclePaymentsPlugin.NAME;

  readonly version = '1.0.0';

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'ORACLE_PAYMENTS_DISABLED!=true';

  private readonly agentCard: AgentCardService;

  private readonly contractRecord: ContractRecordService;

  private readonly engagement: EngagementService;

  private readonly extractor: WorkSummaryExtractor;

  private readonly threadAttachments: ThreadAttachmentService;

  private contractGate?: ContractGateService;

  private workIntent?: WorkIntentService;

  private workClaim?: WorkClaimService;

  private localCardCache: { path: string; card: LocalAgentCard } | null = null;

  constructor(options: OraclePaymentsPluginOptions = {}) {
    super();
    this.agentCard =
      options.agentCard ?? new AgentCardService({ logger: console });
    this.contractRecord = options.contractRecord ?? new ContractRecordService();
    this.engagement = options.engagement ?? new EngagementService();
    this.contractGate = options.contractGate;
    this.workIntent = options.workIntent;
    this.extractor = options.extractor ?? new WorkSummaryExtractor();
    this.threadAttachments =
      options.threadAttachments ?? new ThreadAttachmentService();
    this.workClaim = options.workClaim;
  }

  /**
   * The gate and the delivery lane are shared by the Nest module (boot) and
   * the request tools, and either may reach them first — a fork booted through
   * `createOracleApp` wires them at module registration, a unit test builds
   * them on the first tool call. Both resolve the same singleton per plugin
   * instance, from whichever validated config arrived first.
   */
  private resolveContractGate(config?: MergedConfig): ContractGateService {
    this.contractGate ??= new ContractGateService({
      contractRecord: this.contractRecord,
      engagement: this.engagement,
      engineUrl: config
        ? readConfigString(config, 'EVAL_ENGINE_URL')
        : undefined,
      network:
        (config ? readConfigString(config, 'NETWORK') : undefined) ?? 'devnet',
    });
    return this.contractGate;
  }

  private resolveWorkIntent(config?: MergedConfig): WorkIntentService {
    this.workIntent ??= new WorkIntentService({
      engagement: this.engagement,
      network:
        (config ? readConfigString(config, 'NETWORK') : undefined) ?? 'devnet',
      logger: console,
    });
    return this.workIntent;
  }

  private resolveWorkClaim(config?: MergedConfig): WorkClaimService {
    this.workClaim ??= new WorkClaimService({
      engagement: this.engagement,
      contractGate: this.resolveContractGate(config),
      extractor: this.extractor,
    });
    return this.workClaim;
  }

  /**
   * The manifest self-describes from the local agent card when
   * `AGENT_CARD_PATH` is set — a SYNCHRONOUS read, so the derived manifest is
   * already in place when the loader snapshots manifests at boot. Read lazily
   * (env may not be loaded at module-import time) and cached per path for the
   * process lifetime. Without the env var, the static manifest stands.
   */
  get manifest(): PluginManifest {
    const card = this.resolveLocalCard();
    return card ? deriveManifestFromCard(manifest, card) : manifest;
  }

  private resolveLocalCard(): LocalAgentCard | null {
    const path = process.env.AGENT_CARD_PATH;
    if (!path) return null;
    if (this.localCardCache?.path !== path) {
      this.localCardCache = { path, card: loadLocalAgentCard(path) };
    }
    return this.localCardCache.card;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return env.ORACLE_PAYMENTS_DISABLED !== 'true';
  }

  override getRequestTools(rtCtx: RuntimeContext): PluginTool[] {
    if (rtCtx.commerce?.mode === 'work') {
      // Work-mode surface: deliver or cancel. Cancellation is an agent
      // decision (the router is pure sticky); the fork's own work tools carry
      // the actual service.
      return createOraclePaymentsWorkTools({
        workClaim: this.resolveWorkClaim(rtCtx.config),
        threadAttachments: this.threadAttachments,
      });
    }
    return createOraclePaymentsTools({
      agentCard: this.agentCard,
      contractRecord: this.contractRecord,
      threadAttachments: this.threadAttachments,
    });
  }

  override getSharedState(): Record<
    string,
    (state: unknown, runCtx: RuntimeContext) => unknown
  > {
    return {
      oraclePayments: (_state, runCtx) => {
        const entityDid = readConfigString(runCtx.config, 'ORACLE_ENTITY_DID');
        return {
          services: () =>
            entityDid
              ? this.agentCard.getServices(entityDid)
              : Promise.resolve(null),
          engagement: (roomId: string, threadId: string) =>
            this.engagement.getActive(roomId, threadId),
        };
      },
    };
  }

  override getNestModules(ctx?: PluginContext): Array<Type | DynamicModule> {
    // Runs at boot with the validated config — the one place both the local
    // card and the oracle's entity DID are known, so the "card is about THIS
    // oracle" check lives here and a mismatch fails the boot loudly.
    // The claim-status cron has no room to start from, so the engagements it
    // polls are indexed in the oracle's own account room — known only here.
    const accountRoomId = ctx
      ? readConfigString(ctx.config, 'MATRIX_ACCOUNT_ROOM_ID')
      : undefined;
    if (accountRoomId) this.engagement.setClaimIndexRoom(accountRoomId);

    const localCard = this.resolveLocalCard();
    if (localCard && ctx) {
      const entityDid = readConfigString(ctx.config, 'ORACLE_ENTITY_DID');
      if (entityDid && localCard.subjectDid !== entityDid) {
        throw new Error(
          `AGENT_CARD_PATH card describes ${localCard.subjectDid} but this oracle is ${entityDid} — publish/point to the card for this oracle entity`,
        );
      }
      if (entityDid) {
        this.agentCard.setLocalSeed({
          oracleEntityDid: entityDid,
          cardProof: '',
          services: localCard.services,
        });
      }
    }

    return [
      OraclePaymentsModule.register({
        agentCard: this.agentCard,
        contractRecord: this.contractRecord,
        engagement: this.engagement,
        contractGate: this.resolveContractGate(ctx?.config),
        workIntent: this.resolveWorkIntent(ctx?.config),
        workClaim: this.resolveWorkClaim(ctx?.config),
      }),
    ];
  }
}
