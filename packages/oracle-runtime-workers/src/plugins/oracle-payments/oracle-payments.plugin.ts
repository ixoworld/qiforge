import { OraclePlugin, type PluginEnv } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
  TurnScope,
} from '../../plugin-api/types';
import { MemoryPlugin } from '../memory';
import { loadAgentCard, type AgentCard } from './agent-card';
import { oraclePaymentsConfigSchema, resolvePaymentsEnv } from './config';
import { EngagementStore } from './engagements';
import { supportOverlay, workOverlay } from './overlay';
import { supportTools, workTools, type ToolDeps } from './tools';

const manifest: PluginManifest = {
  title: 'Oracle Payments',
  summary:
    "This oracle's paid services: show the catalog and prices, explain how to hire it, start a paid job, deliver it and get paid.",
  whenToUse: [
    'User asks what you offer, what something costs, or how to hire you.',
    'User wants a paid service performed — `start_work` is the only way a paid job begins.',
    'A paid job is open and the work is done — `deliver_work` hands it over and files the claim.',
  ],
  whenNotToUse: [
    'Doing paid work without an open job — start it with `start_work` first.',
  ],
  examples: [
    {
      user: 'What can you do for me and how much is it?',
      thought: 'Catalog question.',
      tool: 'list_services',
    },
    {
      user: "I've hired you — please do the MRV plan now.",
      thought: 'They want the paid service performed: open the job.',
      tool: 'start_work',
      args: { serviceId: 'mrv-plan' },
    },
  ],
  tags: ['payments', 'contracting', 'services', 'commerce'],
  category: 'ui',
  visibility: 'always',
  stability: 'beta',
};

export interface OraclePaymentsPluginOptions {
  /** Shown in `show_contract` as where to hire this oracle. */
  portalUrl?: string;
}

/**
 * Sell a professional service over chat and get paid on chain.
 *
 * Every turn runs as one of two personas (`getTurnScope`):
 *  - SUPPORT (no open job): a front desk that can only quote, explain and
 *    `start_work`; every other plugin's tools are unbound, so free support
 *    cannot do the paid work.
 *  - WORK (an open job in the user's own store): the full tool surface plus
 *    `deliver_work` / `cancel_work`.
 *
 * Needs `AGENT_CARD_JSON` (the catalog) and the host's `ctx.chain` (the
 * oracle's secp account + `SEQUENCE_MANAGER`) and `ctx.kv`.
 */
export class OraclePaymentsPlugin extends OraclePlugin {
  static readonly NAME = 'oracle-payments';
  readonly name = OraclePaymentsPlugin.NAME;
  readonly version = '1.0.0';
  readonly manifest = manifest;
  override readonly configSchema = oraclePaymentsConfigSchema;
  override readonly autoDetectHint = 'AGENT_CARD_JSON';

  constructor(private readonly options: OraclePaymentsPluginOptions = {}) {
    super();
  }

  override autoDetect(env: PluginEnv): boolean {
    return (
      env.ORACLE_PAYMENTS_DISABLED !== 'true' &&
      typeof env.AGENT_CARD_JSON === 'string' &&
      env.AGENT_CARD_JSON.length > 0
    );
  }

  private cardOf(ctx: RuntimeContext): AgentCard | null {
    const raw = ctx.config.AGENT_CARD_JSON;
    return loadAgentCard(typeof raw === 'string' ? raw : undefined);
  }

  private deps(card: AgentCard): ToolDeps {
    return {
      card,
      env: (ctx) => resolvePaymentsEnv(ctx.config),
      ...(this.options.portalUrl ? { portalUrl: this.options.portalUrl } : {}),
    };
  }

  override async getTurnScope(
    ctx: RuntimeContext,
  ): Promise<TurnScope | undefined> {
    const card = this.cardOf(ctx);
    if (!card || !ctx.kv) return undefined;
    const engagement = await new EngagementStore(ctx.kv).active();
    if (engagement) {
      return {
        commerce: { mode: 'work', engagement },
        promptOverlay: workOverlay(card, engagement),
      };
    }
    return {
      commerce: { mode: 'support' },
      allowPlugins: [this.name, MemoryPlugin.NAME],
      promptOverlay: supportOverlay(card),
    };
  }

  override getRequestTools(ctx: RuntimeContext): PluginTool[] {
    const card = this.cardOf(ctx);
    if (!card) return [];
    return ctx.commerce?.mode === 'work'
      ? workTools(this.deps(card))
      : supportTools(this.deps(card));
  }
}
