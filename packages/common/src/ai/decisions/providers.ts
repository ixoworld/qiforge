import { z } from 'zod';
import {
  CloudflareJevDecisionAdapter,
  OpenRouterJevDecisionAdapter,
  WorkersAiJevDecisionAdapter,
  type WorkersAiBinding,
} from './jev/index.js';
import type { DecisionAdapter } from './types.js';

export const DECISION_PROVIDERS = ['cloudflare-jev', 'openrouter-jev'] as const;
export type DecisionProviderName = (typeof DECISION_PROVIDERS)[number];

/**
 * Env fields every runtime spreads into its base env schema.
 * `OPEN_ROUTER_API_KEY` is intentionally absent: both runtimes already declare
 * it for the LLM provider, and `openrouter-jev` reuses that key.
 */
export const decisionProviderEnvShape = {
  DECISION_PROVIDER: z.enum(DECISION_PROVIDERS).optional(),
  DECISION_MODEL: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
};

export interface DecisionProviderConfigIssue {
  field: string;
  message: string;
}

export interface ResolveDecisionAdapterOptions {
  /** Workers AI binding; when present `cloudflare-jev` needs no credentials. */
  workersAi?: WorkersAiBinding;
  fetch?: typeof globalThis.fetch;
  openRouterHeaders?: Record<string, string>;
}

export type ResolveDecisionAdapterResult =
  | { ok: true; adapter: DecisionAdapter | undefined }
  | { ok: false; issues: DecisionProviderConfigIssue[] };

/**
 * Turns validated env config into a decision adapter. An unset provider
 * leaves Decisions unconfigured (`adapter: undefined`); a selected provider
 * with missing credentials reports one issue per missing field.
 */
export function resolveDecisionAdapter(
  config: Record<string, unknown>,
  opts: ResolveDecisionAdapterOptions = {},
): ResolveDecisionAdapterResult {
  const provider = readNonEmptyString(config.DECISION_PROVIDER);
  if (provider === undefined) return { ok: true, adapter: undefined };

  const model = readNonEmptyString(config.DECISION_MODEL);

  switch (provider) {
    case 'openrouter-jev': {
      const apiKey = readNonEmptyString(config.OPEN_ROUTER_API_KEY);
      if (!apiKey) {
        return {
          ok: false,
          issues: [
            {
              field: 'OPEN_ROUTER_API_KEY',
              message:
                "DECISION_PROVIDER='openrouter-jev' requires OPEN_ROUTER_API_KEY.",
            },
          ],
        };
      }
      return {
        ok: true,
        adapter: new OpenRouterJevDecisionAdapter({
          apiKey,
          ...(model ? { model } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.openRouterHeaders
            ? { headers: opts.openRouterHeaders }
            : {}),
        }),
      };
    }

    case 'cloudflare-jev': {
      if (opts.workersAi) {
        return {
          ok: true,
          adapter: new WorkersAiJevDecisionAdapter({
            ai: opts.workersAi,
            ...(model ? { model } : {}),
          }),
        };
      }

      const accountId = readNonEmptyString(config.CLOUDFLARE_ACCOUNT_ID);
      const apiToken = readNonEmptyString(config.CLOUDFLARE_API_TOKEN);
      const issues: DecisionProviderConfigIssue[] = [];
      if (!accountId) {
        issues.push({
          field: 'CLOUDFLARE_ACCOUNT_ID',
          message: cloudflareCredentialMessage('CLOUDFLARE_ACCOUNT_ID'),
        });
      }
      if (!apiToken) {
        issues.push({
          field: 'CLOUDFLARE_API_TOKEN',
          message: cloudflareCredentialMessage('CLOUDFLARE_API_TOKEN'),
        });
      }
      if (!accountId || !apiToken) return { ok: false, issues };

      return {
        ok: true,
        adapter: new CloudflareJevDecisionAdapter({
          accountId,
          apiToken,
          ...(model ? { model } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        }),
      };
    }

    default:
      return {
        ok: false,
        issues: [
          {
            field: 'DECISION_PROVIDER',
            message: `Unknown DECISION_PROVIDER; expected one of ${DECISION_PROVIDERS.join(', ')}.`,
          },
        ],
      };
  }
}

function cloudflareCredentialMessage(field: string): string {
  return (
    `DECISION_PROVIDER='cloudflare-jev' requires ${field} when calling the ` +
    'Cloudflare REST API. On Cloudflare Workers, pass the AI binding instead ' +
    'and the credential is not needed.'
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}
