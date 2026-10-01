import { z } from 'zod';
import { OraclePlugin } from '../../../plugin-api/oracle-plugin';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../../plugin-api/types';
import {
  createDefaultSkillsUcanBuilder,
  createSkillsTools,
  type SkillsUcanBuilder,
} from './skills-tools';

const DEFAULT_SKILLS_BASE_URL = 'https://capsules.skills.ixo.earth';

const configSchema = z.object({
  SKILLS_CAPSULES_BASE_URL: z.string().url().default(DEFAULT_SKILLS_BASE_URL),
});

/**
 * Sibling env vars read at boot. `NETWORK` is owned by the core base env
 * schema and forwarded to ai-skills as the `X-IXO-Network` routing hint.
 */
const siblingEnvSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
});

const manifest: PluginManifest = {
  title: 'Skills',
  summary:
    "Discover IXO skill capsules — the caller's published private skills first, then the public registry.",
  whenToUse: [
    'User asks "what skills are available?" or "what can you do?".',
    'User asks the agent to find a skill for a specific task ("a skill for invoices", "is there a skill for KYC?").',
  ],
  whenNotToUse: [
    'Executing a skill — this runtime only lists and searches the registry.',
  ],
  examples: [
    {
      user: 'Do you have a skill that can generate an invoice?',
      thought: 'Skill discovery — search the registry.',
      tool: 'search_skills',
    },
  ],
  tags: ['skills', 'capsules', 'registry', 'ucan'],
  category: 'data',
  visibility: 'always',
  stability: 'stable',
};

export interface SkillsPluginOptions {
  /**
   * Override the UCAN minting helper. Tests inject a stub here so the plugin
   * never touches did:web resolution / the UCAN service; production code
   * lets the default builder do the network work.
   */
  ucanBuilder?: SkillsUcanBuilder;
}

/**
 * Skills plugin — the read-only half of the Node runtime's skills plugin.
 *
 * Exposes `list_skills` and `search_skills` over the IXO skills registry
 * (ai-skills). When the oracle has a signing key, both tools mint an
 * `ixo:skills` UCAN invocation per call so the registry can surface the
 * caller's own published private skills alongside the public ones; without
 * one (`ctx.ucan.hasSigningKey()` is `false`) they call public-only. They
 * never throw on auth issues.
 *
 * Unlike the Node plugin this one has no `dependsOn: ['sandbox']` — skill
 * *execution* (`sandbox_run`) is not part of the Workers runtime.
 */
export class SkillsPlugin extends OraclePlugin {
  static readonly NAME = 'skills';

  readonly name = SkillsPlugin.NAME;
  readonly version = '1.0.0';
  readonly manifest = manifest;
  override readonly configSchema = configSchema;

  private readonly ucanBuilderOverride?: SkillsUcanBuilder;

  constructor(opts: SkillsPluginOptions = {}) {
    super();
    this.ucanBuilderOverride = opts.ucanBuilder;
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const parsed = configSchema.safeParse(ctx.config);
    if (!parsed.success) {
      throw new Error(
        `skills: invalid configuration: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const siblings = siblingEnvSchema.safeParse(ctx.config);
    const network = siblings.success
      ? (siblings.data.NETWORK ?? 'mainnet')
      : 'mainnet';

    const ucanBuilder =
      this.ucanBuilderOverride ?? createDefaultSkillsUcanBuilder();

    return createSkillsTools({
      baseUrl: parsed.data.SKILLS_CAPSULES_BASE_URL,
      network,
      ucanBuilder,
    });
  }
}
