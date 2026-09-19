import type { DecisionAdapter } from '@ixo/common';
import { CloudflareJevDecisionAdapter } from './adapters/cloudflare-jev.js';

export type DecisionProviderName = 'cloudflare-jev';

export interface DecisionProviderConfigIssue {
  field: string;
  message: string;
}

export function validateDecisionProviderConfig(
  config: Record<string, unknown>,
): DecisionProviderConfigIssue[] {
  const provider = config.DECISION_PROVIDER;
  if (provider === undefined || provider === null || provider === '') return [];
  if (provider !== 'cloudflare-jev') return [];

  const issues: DecisionProviderConfigIssue[] = [];
  if (!readNonEmptyString(config.CLOUDFLARE_ACCOUNT_ID)) {
    issues.push({
      field: 'CLOUDFLARE_ACCOUNT_ID',
      message:
        "DECISION_PROVIDER='cloudflare-jev' requires CLOUDFLARE_ACCOUNT_ID.",
    });
  }
  if (!readNonEmptyString(config.CLOUDFLARE_API_TOKEN)) {
    issues.push({
      field: 'CLOUDFLARE_API_TOKEN',
      message:
        "DECISION_PROVIDER='cloudflare-jev' requires CLOUDFLARE_API_TOKEN.",
    });
  }
  return issues;
}

export function createDecisionAdapterFromConfig(
  config: Record<string, unknown>,
): DecisionAdapter | undefined {
  if (config.DECISION_PROVIDER !== 'cloudflare-jev') return undefined;

  const accountId = readNonEmptyString(config.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = readNonEmptyString(config.CLOUDFLARE_API_TOKEN);
  if (!accountId || !apiToken) {
    throw new Error(
      'Cloudflare Jev decision provider is missing required credentials.',
    );
  }

  const gatewayId = readNonEmptyString(config.CLOUDFLARE_AI_GATEWAY_ID);
  return new CloudflareJevDecisionAdapter({
    accountId,
    apiToken,
    ...(gatewayId ? { gatewayId } : {}),
  });
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}
