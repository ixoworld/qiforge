import { describe, expect, it } from 'vitest';
import {
  describeCodexAuthMode,
  resolveCodexCapabilities,
} from './capabilities.js';
import { CodexConfigError, normalizeCodexConfig } from './config.js';
import { preflight } from './preflight.js';

const base = { CODEX_AUTH_MODE: 'api_key' };

describe('normalizeCodexConfig', () => {
  it('applies defaults and splits the app-server argv', () => {
    const cfg = normalizeCodexConfig(base);

    expect(cfg.authMode).toBe('api_key');
    expect(cfg.command).toBe('codex');
    expect(cfg.args).toEqual(['app-server']);
    expect(cfg.sandboxMode).toBe('readOnly');
    expect(cfg.approvalPolicy).toBe('onRequest');
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
        CODEX_SANDBOX_MODE: 'dangerFullAccess',
        CODEX_APPROVAL_POLICY: 'never',
      }),
    ).toThrow(/removes every guardrail/u);
  });

  it('allows full host access when an approval gate remains', () => {
    const cfg = normalizeCodexConfig({
      ...base,
      CODEX_SANDBOX_MODE: 'dangerFullAccess',
      CODEX_APPROVAL_POLICY: 'onRequest',
    });
    expect(cfg.sandboxMode).toBe('dangerFullAccess');
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
