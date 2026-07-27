import { describe, expect, it } from 'vitest';
import {
  describeCodexAuthMode,
  resolveCodexCapabilities,
} from './capabilities.js';
import { CodexConfigError, normalizeCodexConfig } from './config.js';
import { tenantScopeKey } from './provider.js';
import { preflight } from './preflight.js';

const base = { CODEX_AUTH_MODE: 'api_key' };

describe('normalizeCodexConfig', () => {
  it('applies defaults and splits the app-server argv', () => {
    const cfg = normalizeCodexConfig(base);

    expect(cfg.authMode).toBe('api_key');
    expect(cfg.command).toBe('codex');
    expect(cfg.args).toEqual(['app-server']);
    expect(cfg.sandboxMode).toBe('read-only');
    expect(cfg.approvalPolicy).toBe('on-request');
    expect(cfg.apiKeySecretName).toBe('OPENAI_API_KEY');
  });

  it('splits multi-word argv on whitespace', () => {
    const cfg = normalizeCodexConfig({
      ...base,
      CODEX_APP_SERVER_ARGS: 'app-server  --listen ws://127.0.0.1:4500',
    });
    expect(cfg.args).toEqual(['app-server', '--listen', 'ws://127.0.0.1:4500']);
  });

  it('coerces numeric env strings', () => {
    const cfg = normalizeCodexConfig({
      ...base,
      CODEX_TURN_TIMEOUT_MS: '1234',
    });
    expect(cfg.turnTimeoutMs).toBe(1234);
  });

  it('rejects a missing auth mode rather than guessing one', () => {
    expect(() => normalizeCodexConfig({})).toThrow(CodexConfigError);
  });

  it('rejects an unknown auth mode', () => {
    expect(() => normalizeCodexConfig({ CODEX_AUTH_MODE: 'chatgpt' })).toThrow(
      CodexConfigError,
    );
  });

  it('rejects an empty argv', () => {
    expect(() =>
      normalizeCodexConfig({ ...base, CODEX_APP_SERVER_ARGS: '   ' }),
    ).toThrow(/empty argv/u);
  });

  it('rejects full host access with approvals disabled', () => {
    expect(() =>
      normalizeCodexConfig({
        ...base,
        CODEX_SANDBOX_MODE: 'danger-full-access',
        CODEX_APPROVAL_POLICY: 'never',
      }),
    ).toThrow(/removes every guardrail/u);
  });

  it('allows full host access when an approval gate remains', () => {
    const cfg = normalizeCodexConfig({
      ...base,
      CODEX_SANDBOX_MODE: 'danger-full-access',
      CODEX_APPROVAL_POLICY: 'on-request',
    });
    expect(cfg.sandboxMode).toBe('danger-full-access');
  });
});

describe('resolveCodexCapabilities', () => {
  it('does not grant direct API access to a subscription', () => {
    const caps = resolveCodexCapabilities('chatgpt_subscription');

    expect(caps.runtimeThreads).toBe(true);
    expect(caps.directModelApi).toBe(false);
    expect(caps.billing).toBe('subscription');
    expect(caps.modelOverride).toBe(false);
  });

  it('grants usage-billed API access to an API key', () => {
    const caps = resolveCodexCapabilities('api_key');

    expect(caps.directModelApi).toBe(true);
    expect(caps.billing).toBe('usage_based');
    expect(caps.modelOverride).toBe(true);
  });

  it('describes each mode distinctly for the settings UI', () => {
    expect(describeCodexAuthMode('chatgpt_subscription')).toMatch(
      /ChatGPT sign-in/u,
    );
    expect(describeCodexAuthMode('api_key')).toMatch(/usage-based/u);
  });
});

describe('preflight', () => {
  it('returns a plan whose capabilities match the configured mode', () => {
    const plan = preflight({ CODEX_AUTH_MODE: 'chatgpt_subscription' });

    expect(plan.authMode).toBe('chatgpt_subscription');
    expect(plan.capabilities.billing).toBe('subscription');
    expect(plan.config.command).toBe('codex');
  });

  it('refuses a requested mode that disagrees with the configured one', () => {
    expect(() =>
      preflight(base, { requestedAuthMode: 'chatgpt_subscription' }),
    ).toThrow(/does not match the configured mode/u);
  });

  it('accepts a requested mode that agrees', () => {
    expect(preflight(base, { requestedAuthMode: 'api_key' }).authMode).toBe(
      'api_key',
    );
  });
});

describe('tenantScopeKey', () => {
  const oracleEntityDid = 'did:ixo:oracle1';

  it('keeps a readable prefix so credential directories stay diagnosable', () => {
    expect(
      tenantScopeKey({ oracleEntityDid, userDid: 'did:ixo:user1' }),
    ).toMatch(/^did_ixo_oracle1__did_ixo_user1-[0-9a-f]{16}$/u);
  });

  it('does not collide when sanitizing makes two DIDs look identical', () => {
    // Both sanitize to `did_x_a_b`; only the digest keeps them apart, and this
    // key indexes sessions, approvals and credential directories.
    const first = tenantScopeKey({ oracleEntityDid, userDid: 'did:x:a:b' });
    const second = tenantScopeKey({ oracleEntityDid, userDid: 'did:x:a_b' });

    expect(first).not.toBe(second);
  });

  it('separates the oracle and user fields unambiguously', () => {
    expect(tenantScopeKey({ oracleEntityDid: 'a:b', userDid: 'c' })).not.toBe(
      tenantScopeKey({ oracleEntityDid: 'a', userDid: 'b:c' }),
    );
  });

  it('is stable for the same scope', () => {
    const scope = { oracleEntityDid, userDid: 'did:ixo:user1' };
    expect(tenantScopeKey(scope)).toBe(tenantScopeKey(scope));
  });
});
