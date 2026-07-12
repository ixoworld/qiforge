import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  MergedConfig,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
} from '../../plugin-api/types.js';
import { createEvalsSubAgent } from './evals-agent.js';
import { EvalsEngineClient } from './evals-client.js';
import { createEvalsTools } from './evals-tools.js';

const configSchema = z.object({
  EVALS_ENGINE_URL: z
    .string()
    .url('EVALS_ENGINE_URL must be a valid HTTP(S) URL.'),
  EVALS_ENGINE_AUTH_TOKEN: z.string().min(1).optional(),
});

function resolveEvalsConfig(config: MergedConfig): {
  baseUrl: string;
  authToken?: string;
} {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      'evals: could not resolve Evals Engine config. Set EVALS_ENGINE_URL to the oracle-api base URL (and EVALS_ENGINE_AUTH_TOKEN when the deployment requires auth).',
    );
  }
  return {
    baseUrl: parsed.data.EVALS_ENGINE_URL,
    authToken: parsed.data.EVALS_ENGINE_AUTH_TOKEN,
  };
}

const manifest: PluginManifest = {
  title: 'Evals Engine',
  summary:
    'Verifiable claim evaluation via the IXO Evals Engine — submit claims for rubric-based scoring and retrieve signed verdicts (UDIDs), audit trails, and governance maturity status.',
  whenToUse: [
    'User asks to evaluate, verify, score, or adjudicate a claim about completed work (a task, delivery, payment, or other deed).',
    'User asks for the status or verdict of a previously submitted claim evaluation.',
    'User needs the signed receipt (UDID) or the audit trail explaining why a claim was approved or rejected.',
    'User asks how much autonomy the engine has for a claim type (maturity ladder) or what is waiting on human review.',
  ],
  whenNotToUse: [
    'Authoring or registering rubrics — rubric governance happens in the Evals Engine deployment, not through this plugin.',
    'Adjudicating manual-review cases — that is a human reviewer action performed against the engine directly.',
    'Looking up IXO entities or domain data (use Domain Indexer).',
  ],
  examples: [
    {
      user: 'Verify this claim that the restocking task was completed, using the standard rubric.',
      thought:
        'Claim verification against a rubric — delegate to call_evals_agent to submit the evaluation.',
      tool: 'call_evals_agent',
    },
    {
      user: 'Was claim-42 approved? Show me why.',
      thought:
        'Verdict + reasoning for an existing claim — the Evals Agent checks status and fetches the audit trail.',
      tool: 'call_evals_agent',
    },
  ],
  tags: ['evaluations', 'claims', 'verification', 'rubrics', 'audit'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'beta',
};

/**
 * Evals Engine plugin. Exposes a sub-agent (`call_evals_agent`) that drives
 * the IXO Evals Engine's hosted `oracle-api`: submitting claims for
 * rubric-based evaluation, polling async jobs, and fetching signed UDID
 * receipts, audit bundles, maturity rungs, and the manual-review queue.
 *
 * Enabled when `EVALS_ENGINE_URL` points at a deployed oracle-api. Deployments
 * with auth enabled also need `EVALS_ENGINE_AUTH_TOKEN` (the engine's static
 * bearer secret). Only read + evaluate endpoints are exposed — privileged
 * governance and reviewer writes are deliberately out of scope.
 */
export class EvalsPlugin extends OraclePlugin {
  readonly name = 'evals';
  readonly version = '1.0.0';
  readonly manifest = manifest;
  override readonly configSchema = configSchema;
  override readonly autoDetectHint = 'EVALS_ENGINE_URL';

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.EVALS_ENGINE_URL);
  }

  override getSubAgents(ctx: PluginContext): PluginSubAgent[] {
    const { baseUrl, authToken } = resolveEvalsConfig(ctx.config);
    const client = new EvalsEngineClient({ baseUrl, authToken });
    const tools = createEvalsTools(client);
    return [createEvalsSubAgent(tools)];
  }
}
