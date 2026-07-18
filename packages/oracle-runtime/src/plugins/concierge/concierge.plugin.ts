import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { resolveDomainIndexerUrl } from '../domain-indexer/index.js';
import { resolveVfsBaseUrls } from '../vfs/index.js';
import { createDomainDocsTools } from './domain-docs-tools.js';
import { createEscalationTool } from './escalation-tool.js';
import { createOracleInfoTool } from './oracle-info-tool.js';
import { createRequestAuthorizationTool } from './request-authorization-tool.js';
import { createShareArtifactTool } from './share-artifact-tool.js';

/** Core env this plugin reads (owned by the base runtime schema). */
const runtimeEnvSchema = z.object({
  ORACLE_DID: z.string().min(1),
  ORACLE_ENTITY_DID: z.string().min(1),
  ORACLE_NAME: z.string().min(1),
});

/** Sibling tuning owned by the VFS plugin; defaulted when absent. */
const vfsTimeoutSchema = z.object({
  VFS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
});

const manifest: PluginManifest = {
  title: 'Concierge',
  summary:
    "This oracle's front desk: introduce the oracle from its public domain card, answer domain FAQs from its documentation, notify the human support team, share long/visual responses as files, and handle full-service authorization requests.",
  whenToUse: [
    'A visitor asks who you are, what this oracle does, who operates it, or anything covered by its FAQ — ground the answer in get_oracle_info.',
    "A domain question goes beyond the domain card — search this oracle's documentation with search_domain_docs.",
    'The user asks for a human, reports a problem you cannot resolve, or seems stuck — escalate_to_support with a concise summary.',
    'A complete answer will not comfortably fit as a Matrix chat message — attach it with share_artifact (md for text, html for visual) instead of pasting a wall of text.',
    'The user explicitly asks to authorize you / unlock full access — request_authorization, then explain the Portal flow.',
  ],
  whenNotToUse: [
    "General questions unrelated to this oracle's domain — decline politely in concierge mode; in full mode use the appropriate capability instead.",
    'Collaborative pages/canvases people will edit together — use the editor page tools, not share_artifact.',
    'Looking up OTHER entities or domains — that is the domain-indexer, not the concierge.',
  ],
  examples: [
    {
      user: 'What can you help me with?',
      thought:
        'Introduce this oracle from its own domain card — summary, overview, FAQ.',
      tool: 'get_oracle_info',
    },
    {
      user: 'This is not working and I need to talk to a person.',
      thought:
        'They want a human. Notify the designated support team with a handoff summary.',
      tool: 'escalate_to_support',
      args: {
        summary: 'Visitor reports X is failing; tried Y; needs human help.',
        urgency: 'high',
      },
    },
    {
      user: 'Give me the full detailed overview in writing.',
      thought:
        'Long-form answer — attach as a markdown file, then summarize in chat.',
      tool: 'share_artifact',
      args: { filename: 'overview.md', format: 'md' },
    },
  ],
  tags: ['concierge', 'support', 'faq', 'onboarding'],
  category: 'communication',
  visibility: 'always',
  stability: 'stable',
};

/**
 * Concierge plugin — the oracle's front desk.
 *
 * Static: `get_oracle_info` (the oracle's own domain card, all clients).
 * Matrix request-time: `escalate_to_support`, `share_artifact`,
 * `request_authorization`, and `search_domain_docs` (the latter only when
 * the oracle has a UCAN signing key to self-sign entity-namespace reads).
 *
 * In concierge mode (`session.mode === 'concierge'`) these are the ONLY
 * plugin tools bound (see `graph/concierge-policy.ts`), alongside the
 * domain-indexer sub-agent; in full mode they simply join the normal set.
 */
export class ConciergePlugin extends OraclePlugin {
  readonly name = 'concierge';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override getTools(ctx: PluginContext): PluginTool[] {
    let baseUrl: string;
    try {
      baseUrl = resolveDomainIndexerUrl(ctx.config);
    } catch (error) {
      ctx.logger.warn(
        `[concierge] domain-indexer URL unresolvable — get_oracle_info disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    return [
      createOracleInfoTool({
        baseUrl,
        entityDid: ctx.identity.entityDid,
      }),
    ];
  }

  override getRequestTools(rtCtx: RuntimeContext): PluginTool[] {
    if (rtCtx.session.client !== 'matrix') return [];

    const env = runtimeEnvSchema.safeParse(rtCtx.config);
    if (!env.success) {
      rtCtx.logger.warn(
        '[concierge] core oracle env missing — request tools disabled',
      );
      return [];
    }

    const tools: PluginTool[] = [
      createEscalationTool({
        entityDid: env.data.ORACLE_ENTITY_DID,
        oracleName: env.data.ORACLE_NAME,
      }),
      createShareArtifactTool(),
      createRequestAuthorizationTool({
        oracleEntityDid: env.data.ORACLE_ENTITY_DID,
        oracleDid: env.data.ORACLE_DID,
      }),
    ];

    // Domain docs need an oracle-signed invocation; without a signing key
    // the concierge answers from the domain card alone.
    if (rtCtx.ucan.hasSigningKey()) {
      const { vfs } = resolveVfsBaseUrls(rtCtx.config);
      const timeout = vfsTimeoutSchema.safeParse(rtCtx.config);
      tools.push(
        ...createDomainDocsTools({
          vfsBaseUrl: vfs,
          entityDid: env.data.ORACLE_ENTITY_DID,
          timeoutMs: timeout.success
            ? timeout.data.VFS_REQUEST_TIMEOUT_MS
            : 20000,
        }),
      );
    }

    return tools;
  }
}
