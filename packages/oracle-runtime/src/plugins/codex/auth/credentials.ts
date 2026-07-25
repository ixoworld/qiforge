import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { CodexNormalizedConfig } from '../domain/config.js';
import type { CodexTenantScope } from '../domain/provider.js';
import { tenantScopeKey } from '../domain/provider.js';

/** File the Codex CLI writes once a ChatGPT sign-in completes. */
const CODEX_AUTH_FILE = 'auth.json';

/**
 * Credential material for one tenant's App Server process. `env` is spread
 * into the child process environment and must never be logged, emitted,
 * serialized into events, or returned over HTTP.
 */
export interface CodexCredentials {
  readonly codexHome: string;
  readonly env: Readonly<Record<string, string>>;
}

export type CodexCredentialOutcome =
  | { readonly kind: 'ready'; readonly credentials: CodexCredentials }
  | {
      readonly kind: 'requires_sign_in';
      /** Sanitized, operator-facing reason. Contains no secret material. */
      readonly detail: string;
    };

/** The slice of `RuntimeContext.secrets` the resolver needs. */
export interface CodexSecretReader {
  getValues: (keys: string[]) => Promise<Record<string, string>>;
}

/** Per-tenant `CODEX_HOME`, created with owner-only permissions. */
export function tenantHomePath(
  config: CodexNormalizedConfig,
  scope: CodexTenantScope,
): string {
  const root = isAbsolute(config.homeRoot)
    ? config.homeRoot
    : resolve(process.cwd(), config.homeRoot);
  return join(root, tenantScopeKey(scope));
}

async function ensureTenantHome(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve credentials for the active auth mode.
 *
 * Subscription mode reads the ChatGPT sign-in artefact the Codex CLI writes
 * into the tenant's `CODEX_HOME`; the harness never handles the OAuth tokens
 * itself. API-key mode pulls the key from the room's encrypted secret store.
 * Neither path reuses the other's material — a missing credential surfaces as
 * `requires_sign_in` rather than falling through to the other mode.
 */
export async function resolveCodexCredentials(params: {
  config: CodexNormalizedConfig;
  scope: CodexTenantScope;
  secrets: CodexSecretReader;
}): Promise<CodexCredentialOutcome> {
  const { config, scope, secrets } = params;
  const codexHome = tenantHomePath(config, scope);
  await ensureTenantHome(codexHome);

  if (config.authMode === 'chatgpt_subscription') {
    const authFile = join(codexHome, CODEX_AUTH_FILE);
    if (!(await fileExists(authFile))) {
      return {
        kind: 'requires_sign_in',
        detail:
          'No ChatGPT sign-in found for this tenant. Complete the Codex sign-in to authorize subscription access.',
      };
    }
    // The App Server reads auth.json from CODEX_HOME itself; nothing is
    // injected into the environment on this path.
    return {
      kind: 'ready',
      credentials: { codexHome, env: { CODEX_HOME: codexHome } },
    };
  }

  const values = await secrets.getValues([config.apiKeySecretName]);
  const apiKey = values[config.apiKeySecretName];
  if (!apiKey) {
    return {
      kind: 'requires_sign_in',
      detail: `No API key found. Store a secret named '${config.apiKeySecretName}' to use usage-based access.`,
    };
  }

  return {
    kind: 'ready',
    credentials: {
      codexHome,
      env: { CODEX_HOME: codexHome, OPENAI_API_KEY: apiKey },
    },
  };
}

/**
 * Env keys whose values are credential material. Used to keep them out of
 * logs and diagnostics.
 */
const SECRET_ENV_KEYS = new Set(['OPENAI_API_KEY']);

/** Redacted view of a credential env, safe to log. */
export function redactCredentialEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SECRET_ENV_KEYS.has(key) ? '[redacted]' : value;
  }
  return out;
}
