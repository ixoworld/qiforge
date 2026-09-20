import type { DecisionAdapter } from './index.js';
import { CloudflareJevDecisionAdapter } from './providers/cloudflare-jev.js';
import { OpenRouterJevDecisionAdapter } from './providers/openrouter-jev.js';

export type DecisionProviderName = 'cloudflare-jev' | 'openrouter-jev';
export interface DecisionProviderConfigIssue {
  field: string;
  message: string;
}

export function validateDecisionProviderConfig(
  config: Record<string, unknown>,
): DecisionProviderConfigIssue[] {
  const provider = config.DECISION_PROVIDER;
  if (provider === undefined || provider === null || provider === '') return [];
  const required =
    provider === 'cloudflare-jev'
      ? ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']
      : provider === 'openrouter-jev'
        ? ['OPEN_ROUTER_API_KEY']
        : null;
  if (!required)
    return [
      { field: 'DECISION_PROVIDER', message: 'Unsupported Decision provider.' },
    ];
  return required
    .filter((field) => !readString(config[field]))
    .map((field) => ({
      field,
      message: `DECISION_PROVIDER='${provider}' requires ${field}.`,
    }));
}

export function createDecisionAdapterFromConfig(
  config: Record<string, unknown>,
): DecisionAdapter | undefined {
  const issues = validateDecisionProviderConfig(config);
  if (issues.length)
    throw new Error(issues.map((issue) => issue.message).join(' '));
  const provider = config.DECISION_PROVIDER;
  if (provider === 'cloudflare-jev') {
    return new CloudflareJevDecisionAdapter({
      accountId: readString(config.CLOUDFLARE_ACCOUNT_ID)!,
      apiToken: readString(config.CLOUDFLARE_API_TOKEN)!,
      gatewayId: readString(config.CLOUDFLARE_AI_GATEWAY_ID),
    });
  }
  if (provider === 'openrouter-jev') {
    return new OpenRouterJevDecisionAdapter({
      apiKey: readString(config.OPEN_ROUTER_API_KEY)!,
      model: readString(config.OPENROUTER_JEV_MODEL),
    });
  }
  return undefined;
}
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
