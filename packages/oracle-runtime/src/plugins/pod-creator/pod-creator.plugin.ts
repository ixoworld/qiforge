import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { InMemoryApprovalStore, type ApprovalStore } from './approval-store.js';
import {
  InMemoryBlueprintStore,
  type BlueprintStore,
} from './blueprint-store.js';
import {
  CapsuleContentClient,
  type CapsuleContentClientOptions,
  type CapsuleContentFetcher,
} from './capsule-content-client.js';
import {
  notConfiguredChainGateway,
  type ChainGateway,
} from './chain-gateway.js';
import { createCreateTools } from './create-tools.js';
import { createOrchestrationTools } from './orchestration-tools.js';
import { buildStageSubAgents } from './sub-agents.js';

/**
 * Plugin-owned env vars. The capsules registry URL and `NETWORK` are read as
 * siblings from the merged config (owned by the skills plugin / base schema),
 * so they are intentionally NOT redeclared here — that would collide in the
 * config-schema registry when both plugins are loaded.
 */
const configSchema = z.object({
  /** Marketplace endpoint used by the commercial-packager listing draft. */
  POD_CREATOR_MARKETPLACE_URL: z.url().optional(),
  /**
   * Must be explicitly enabled before a mainnet creation batch can be
   * prepared. Testnet / devnet require no opt-in. Accepts a real boolean
   * (tests / programmatic config) or the string `'true'` / `'false'` (env).
   */
  POD_CREATOR_ALLOW_MAINNET: z
    .union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ])
    .default(false),
});

/**
 * Sibling env read at request time to configure the capsule client. The
 * registry URL is owned by the skills plugin's configSchema and `NETWORK` by
 * the base env schema; pod-creator reads them without redeclaring (which would
 * collide in the config-schema registry).
 */
const capsuleEnvSchema = z.object({
  SKILLS_CAPSULES_BASE_URL: z.url().optional(),
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
});

const manifest: PluginManifest = {
  title: 'POD Creator',
  summary:
    'Design and create an IXO Programmable Organisational Domain (POD) end to end — qualify, architect, build, evaluate, then prepare an on-chain creation batch for the user to sign.',
  whenToUse: [
    'User wants to create, design, or stand up a new POD (Programmable Organisational Domain) or service domain on IXO.',
    'User describes a service or organisation they want to launch and asks the oracle to turn it into a working POD.',
  ],
  whenNotToUse: [
    'Operating or supporting an already-live POD — out of scope for now.',
    'Generic on-chain entity creation unrelated to POD design.',
  ],
  examples: [
    {
      user: 'Help me create a POD for a community solar monitoring service.',
      thought:
        'A POD creation request — open the design session, then drive the specialists stage by stage.',
      tool: 'start_pod_design',
      args: { brief: 'Community solar monitoring service' },
    },
  ],
  tags: ['pod', 'domain', 'design', 'orchestration', 'on-chain'],
  category: 'automation',
  visibility: 'on-demand',
  stability: 'experimental',
};

export interface PodCreatorPluginOptions {
  /**
   * Registry retrieval for capsule `SKILL.md` text. Injected by tests, and the
   * seam where the confirmed production content path is wired. When omitted,
   * specialist sub-agents fall back to built-in prompts until a fetcher is
   * configured.
   */
  capsuleContentFetcher?: CapsuleContentFetcher;
  /**
   * Chain gateway for the create path. Injected by tests; the real
   * `@ixo/oracles-chain-client`-backed gateway wires in here. When omitted, the
   * create tools error until a gateway is configured.
   */
  chainGateway?: ChainGateway;
}

/**
 * POD-creator plugin.
 *
 * Runs the design-pod lifecycle: a conductor (the main agent) drives the
 * specialist sub-agents to design a POD, then prepares an unsigned on-chain
 * creation batch for the user's wallet to sign. Each specialist's instructions
 * are loaded from the ai-skills capsule registry per stage via the
 * `CapsuleContentClient`.
 *
 * Exposes the conductor's orchestration tools (the blueprint lifecycle), the
 * stage-gated specialist sub-agents, and the on-chain create path
 * (prepare → sign → confirm) behind an injectable chain gateway.
 */
export class PodCreatorPlugin extends OraclePlugin {
  readonly name = 'pod-creator';
  readonly version = '0.1.0';
  readonly manifest = manifest;
  override readonly softDependsOn = [
    'agui',
    'editor',
    'domain-indexer',
    'memory',
  ];
  override readonly configSchema = configSchema;

  /**
   * Process-local blueprint store, held on the plugin instance so a design
   * session persists across requests. A cross-restart durable backend is a
   * swappable implementation of `BlueprintStore`.
   */
  private readonly blueprintStore: BlueprintStore =
    new InMemoryBlueprintStore();

  /** Per-thread record of which prepared batch the user has approved to sign. */
  private readonly approvalStore: ApprovalStore = new InMemoryApprovalStore();

  private readonly capsuleContentFetcher?: CapsuleContentFetcher;

  private readonly chainGateway: ChainGateway;

  /**
   * Built lazily from request config; cached so the per-thread prompt cache
   * survives across requests.
   */
  private capsuleContent?: CapsuleContentClient;

  constructor(options: PodCreatorPluginOptions = {}) {
    super();
    this.capsuleContentFetcher = options.capsuleContentFetcher;
    this.chainGateway = options.chainGateway ?? notConfiguredChainGateway;
  }

  override getTools(): PluginTool[] {
    return [
      ...createOrchestrationTools(this.blueprintStore),
      ...createCreateTools(
        this.blueprintStore,
        this.chainGateway,
        this.approvalStore,
      ),
    ];
  }

  override async getRequestSubAgents(
    rt: RuntimeContext,
  ): Promise<PluginSubAgent[]> {
    return buildStageSubAgents(rt, this.blueprintStore, this.capsuleClient(rt));
  }

  private capsuleClient(rt: RuntimeContext): CapsuleContentClient {
    if (!this.capsuleContent) {
      const env = capsuleEnvSchema.safeParse(rt.config);
      const options: CapsuleContentClientOptions = {};
      if (env.success) {
        if (env.data.SKILLS_CAPSULES_BASE_URL !== undefined) {
          options.baseUrl = env.data.SKILLS_CAPSULES_BASE_URL;
        }
        if (env.data.NETWORK !== undefined) {
          options.network = env.data.NETWORK;
        }
      }
      if (this.capsuleContentFetcher !== undefined) {
        options.fetcher = this.capsuleContentFetcher;
      }
      this.capsuleContent = new CapsuleContentClient(options);
    }
    return this.capsuleContent;
  }
}
