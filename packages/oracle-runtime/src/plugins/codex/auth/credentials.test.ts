import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCodexConfig } from '../domain/config.js';
import type { CodexTenantScope } from '../domain/provider.js';
import {
  redactCredentialEnv,
  resolveCodexCredentials,
  tenantHomePath,
  type CodexSecretReader,
} from './credentials.js';

const scope: CodexTenantScope = {
  userDid: 'did:ixo:user1',
  oracleEntityDid: 'did:ixo:oracle1',
};
const otherScope: CodexTenantScope = {
  userDid: 'did:ixo:user2',
  oracleEntityDid: 'did:ixo:oracle1',
};

const emptySecrets: CodexSecretReader = { getValues: async () => ({}) };

describe('resolveCodexCredentials', () => {
  let homeRoot: string;

  beforeEach(async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'codex-cred-'));
  });

  const configFor = (overrides: Record<string, string> = {}) =>
    normalizeCodexConfig({
      CODEX_AUTH_MODE: 'api_key',
      CODEX_HOME_ROOT: homeRoot,
      ...overrides,
    });

  it('reads the API key from the room secret store', async () => {
    const secrets: CodexSecretReader = {
      getValues: vi.fn(async () => ({ OPENAI_API_KEY: 'sk-test-value' })),
    };

    const outcome = await resolveCodexCredentials({
      config: configFor(),
      scope,
      secrets,
    });

    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    expect(outcome.credentials.env.OPENAI_API_KEY).toBe('sk-test-value');
    expect(secrets.getValues).toHaveBeenCalledWith(['OPENAI_API_KEY']);
  });

  it('honours a custom secret name', async () => {
    const secrets: CodexSecretReader = {
      getValues: vi.fn(async () => ({ CODEX_KEY: 'sk-other' })),
    };

    await resolveCodexCredentials({
      config: configFor({ CODEX_API_KEY_SECRET_NAME: 'CODEX_KEY' }),
      scope,
      secrets,
    });

    expect(secrets.getValues).toHaveBeenCalledWith(['CODEX_KEY']);
  });

  it('asks for sign-in rather than starting without a key', async () => {
    const outcome = await resolveCodexCredentials({
      config: configFor(),
      scope,
      secrets: emptySecrets,
    });

    expect(outcome.kind).toBe('requires_sign_in');
    if (outcome.kind !== 'requires_sign_in') return;
    expect(outcome.detail).toMatch(/OPENAI_API_KEY/u);
  });

  it('asks for sign-in when a subscription has no completed ChatGPT login', async () => {
    const outcome = await resolveCodexCredentials({
      config: configFor({ CODEX_AUTH_MODE: 'chatgpt_subscription' }),
      scope,
      secrets: emptySecrets,
    });

    expect(outcome.kind).toBe('requires_sign_in');
    if (outcome.kind !== 'requires_sign_in') return;
    expect(outcome.detail).toMatch(/ChatGPT sign-in/u);
  });

  it('uses the tenant CODEX_HOME once the ChatGPT login artefact exists', async () => {
    const config = configFor({ CODEX_AUTH_MODE: 'chatgpt_subscription' });
    const home = tenantHomePath(config, scope);
    // Creating the home is the resolver's job on first call.
    await resolveCodexCredentials({ config, scope, secrets: emptySecrets });
    await writeFile(join(home, 'auth.json'), '{"tokens":{}}');

    const outcome = await resolveCodexCredentials({
      config,
      scope,
      secrets: emptySecrets,
    });

    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    expect(outcome.credentials.codexHome).toBe(home);
    // A subscription never injects an API key into the child environment.
    expect(outcome.credentials.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('does not let one tenant see another tenant sign-in', async () => {
    const config = configFor({ CODEX_AUTH_MODE: 'chatgpt_subscription' });
    await resolveCodexCredentials({ config, scope, secrets: emptySecrets });
    await writeFile(join(tenantHomePath(config, scope), 'auth.json'), '{}');

    const outcome = await resolveCodexCredentials({
      config,
      scope: otherScope,
      secrets: emptySecrets,
    });

    expect(outcome.kind).toBe('requires_sign_in');
  });

  it('gives each tenant a distinct home directory', () => {
    const config = configFor();
    expect(tenantHomePath(config, scope)).not.toBe(
      tenantHomePath(config, otherScope),
    );
  });
});

describe('redactCredentialEnv', () => {
  it('hides the API key but keeps non-secret entries readable', () => {
    const redacted = redactCredentialEnv({
      CODEX_HOME: '/tmp/codex/tenant',
      OPENAI_API_KEY: 'sk-super-secret',
    });

    expect(redacted.OPENAI_API_KEY).toBe('[redacted]');
    expect(redacted.CODEX_HOME).toBe('/tmp/codex/tenant');
    expect(JSON.stringify(redacted)).not.toContain('sk-super-secret');
  });
});
