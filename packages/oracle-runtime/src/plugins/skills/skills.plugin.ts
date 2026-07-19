import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import { createSkillsTools } from './skills-tools.js';
import {
  createDefaultSkillsUcanBuilder,
  type SkillsUcanBuilder,
} from './skills-ucan.js';

const DEFAULT_SKILLS_BASE_URL = 'https://capsules.skills.ixo.earth';

const configSchema = z.object({
  SKILLS_CAPSULES_BASE_URL: z.url().default(DEFAULT_SKILLS_BASE_URL),
});

/**
 * Sibling env vars read at request time. `NETWORK` is owned by the core
 * (Tier-0) base env schema and forwarded to ai-skills as the `X-IXO-Network`
 * routing hint. Optional here — absent values fall back to `mainnet`.
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
    'Before running a skill via the sandbox, list or search to obtain its cid + path.',
  ],
  whenNotToUse: [
    'Executing a skill — that goes through the Sandbox (`sandbox_run`), not the skills tools.',
    'General web search (use Firecrawl).',
  ],
  examples: [
    {
      user: 'Do you have a skill that can generate an invoice?',
      thought:
        'Skill discovery — search the registry, then hand the cid+path off to sandbox_run for execution.',
      tool: 'search_skills',
    },
  ],
  tags: ['skills', 'capsules', 'registry', 'ucan'],
  category: 'data',
  visibility: 'always',
  stability: 'stable',
  permissions: { ucan: { invoke: true } },
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
 * Skills plugin.
 *
 * Exposes `list_skills` and `search_skills` over the IXO skills registry
 * (ai-skills). Both tools mint an `ixo:skills` UCAN invocation per call so
 * the registry can surface the caller's own published private skills
 * alongside the public ones. When minting fails the tools degrade to
 * public-only — they never throw on auth issues.
 *
 * Hard-depends on the sandbox plugin: skill *execution* runs through
 * `sandbox_run`, which the sandbox plugin owns. Listing/search is HTTP-only.
 */
export class SkillsPlugin extends OraclePlugin {
  readonly name = 'skills';
  readonly version = '1.0.0';
  readonly manifest = manifest;
  override readonly dependsOn = ['sandbox'];
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
