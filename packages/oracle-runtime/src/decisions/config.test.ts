import { describe, expect, it } from 'vitest';
import {
  createDecisionAdapterFromConfig,
  validateDecisionProviderConfig,
} from './config.js';
import { CloudflareJevDecisionAdapter } from './adapters/cloudflare-jev.js';

describe('decision provider config', () => {
  it('leaves Decisions unconfigured when no provider is selected', () => {
    expect(validateDecisionProviderConfig({})).toEqual([]);
    expect(createDecisionAdapterFromConfig({})).toBeUndefined();
  });

  it('requires Cloudflare credentials only when cloudflare-jev is selected', () => {
    expect(
      validateDecisionProviderConfig({
        DECISION_PROVIDER: 'cloudflare-jev',
      }).map((issue) => issue.field),
    ).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  });

  it('creates the Cloudflare Jev adapter from validated config', () => {
    const adapter = createDecisionAdapterFromConfig({
      DECISION_PROVIDER: 'cloudflare-jev',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_AI_GATEWAY_ID: 'decisions',
    });

    expect(adapter).toBeInstanceOf(CloudflareJevDecisionAdapter);
    expect(adapter?.provider).toBe('cloudflare');
    expect(adapter?.model).toBe('typesafe/jev');
  });
});
