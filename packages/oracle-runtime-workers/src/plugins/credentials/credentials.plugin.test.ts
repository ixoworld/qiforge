import { describe, expect, it } from 'vitest';
import { makeBuildCtx } from '../../core/test-fixtures';
import { IDENTITY_LEVEL1_VCT, resolveCredentialsConfig } from './config';
import { CredentialsPlugin } from './credentials.plugin';
import { RESPONSE_ROUTE_PATH } from './response-route';
import { ORACLE_DID, PUBLIC_URL, SERVICE_KEY } from './test-fixtures';

const ON = {
  NETWORK: 'devnet',
  ORACLE_DID,
  ORACLE_PUBLIC_URL: PUBLIC_URL,
  BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.ixo.world/graphql',
  CREDENTIALS_ENABLED: 'true',
  AUTH_HUB_CHANNEL_SERVICE_KEY: SERVICE_KEY,
};

describe('CredentialsPlugin', () => {
  it('is off unless switched on with the Hub key', () => {
    const plugin = new CredentialsPlugin();
    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetect({ CREDENTIALS_ENABLED: 'true' })).toBe(false);
    expect(
      plugin.autoDetect({
        CREDENTIALS_ENABLED: 'true',
        AUTH_HUB_CHANNEL_SERVICE_KEY: 'k',
      }),
    ).toBe(true);
  });

  it('offers the six tools only when enabled', () => {
    const plugin = new CredentialsPlugin();
    expect(
      plugin.getTools(
        makeBuildCtx({ config: { ...ON, CREDENTIALS_ENABLED: 'false' } }),
      ),
    ).toEqual([]);
    expect(
      plugin.getTools(makeBuildCtx({ config: ON })).map((t) => t.name),
    ).toEqual([
      'credentials_request_check_permission',
      'credentials_permission_status',
      'credentials_check',
      'credentials_request_action_permission',
      'credentials_request_action',
      'credentials_action_status',
    ]);
  });

  it('mounts the response endpoint outside UCAN auth, POST only', () => {
    const plugin = new CredentialsPlugin();
    expect(plugin.getRoutes().map((r) => [r.method, r.path])).toEqual([
      ['POST', RESPONSE_ROUTE_PATH],
    ]);
    expect(plugin.getAuthExcludedRoutes()).toEqual([
      { path: RESPONSE_ROUTE_PATH, method: 'POST' },
    ]);
  });

  it("trusts Self's identity issuer of the network by default, and only the configured list when set", () => {
    expect(
      resolveCredentialsConfig({ NETWORK: 'devnet' }).trustedIssuers,
    ).toEqual({
      [IDENTITY_LEVEL1_VCT]: [
        'did:ixo:entity:80f392610e8a128b4f4b1ed828dbeb7f',
      ],
    });
    expect(
      resolveCredentialsConfig({ NETWORK: 'testnet' }).trustedIssuers[
        IDENTITY_LEVEL1_VCT
      ],
    ).toEqual(['did:ixo:entity:f45746b09949bda3808d02439e212dcb']);
    expect(
      resolveCredentialsConfig({ NETWORK: 'mainnet' }).trustedIssuers[
        IDENTITY_LEVEL1_VCT
      ],
    ).toEqual(['did:ixo:entity:3ea2744791e5b8ce1ddd7d96c9fd27e7']);
    const custom = {
      'https://example.org/types/Member': ['did:web:issuer.example.org'],
    };
    expect(
      resolveCredentialsConfig({
        NETWORK: 'devnet',
        CREDENTIALS_TRUSTED_ISSUERS: JSON.stringify(custom),
      }).trustedIssuers,
    ).toEqual(custom);
    const schema = new CredentialsPlugin().configSchema;
    for (const bad of [
      'not json',
      '{"https://x.org/t": []}',
      '{"https://x.org/t": ["not-a-did"]}',
      '{"not a url": ["did:web:a"]}',
    ])
      expect(
        schema.safeParse({ CREDENTIALS_TRUSTED_ISSUERS: bad }).success,
      ).toBe(false);
  });

  it('defaults every service by network, overridable', () => {
    const plugin = new CredentialsPlugin();
    expect(
      plugin.configSchema.safeParse({ SELF_API_URL: 'http://self.example' })
        .success,
    ).toBe(false);
    expect(
      plugin.configSchema.safeParse({ SELF_API_URL: 'https://self.example' })
        .success,
    ).toBe(true);
  });
});
