/** Stable provider identifier used in config, events and audit records. */
export const CODEX_PROVIDER_ID = 'codex';

/** Human-readable provider name shown in settings UIs. */
export const CODEX_PROVIDER_DISPLAY_NAME = 'OpenAI Codex';

/**
 * How the operator authenticates the Codex runtime.
 *
 * A ChatGPT subscription authorises the Codex *runtime*; it does not grant
 * raw OpenAI API access. `api_key` is the usage-billed path. The two are never
 * interchangeable — see `resolveCodexCapabilities`.
 */
export const CODEX_AUTH_MODES = ['chatgpt_subscription', 'api_key'] as const;
export type CodexAuthMode = (typeof CODEX_AUTH_MODES)[number];

/**
 * Connection lifecycle. Every value is reachable and observable over
 * `GET /codex/status`; transitions are constrained by `CONNECTION_TRANSITIONS`.
 */
export const CODEX_CONNECTION_STATUSES = [
  'disconnected',
  'connecting',
  'connected',
  'requires_sign_in',
  'requires_device_authorization',
  'invalid_credentials',
  'unsupported_environment',
  'error',
] as const;
export type CodexConnectionStatus = (typeof CODEX_CONNECTION_STATUSES)[number];

/** What the active auth mode actually permits. Resolved, never assumed. */
export interface CodexCapabilities {
  /** App Server thread/turn operations are available. */
  readonly runtimeThreads: boolean;
  /**
   * Credentials may be used for direct, token-billed OpenAI API calls.
   * False under a ChatGPT subscription — the plan covers the Codex runtime
   * only, and reusing those credentials against the raw API is unsupported.
   */
  readonly directModelApi: boolean;
  /** Who pays, and how. Surfaced in the settings UI. */
  readonly billing: 'subscription' | 'usage_based';
  /** Whether a per-turn `model` override may be sent to the App Server. */
  readonly modelOverride: boolean;
}

/**
 * Tenant scoping for runtime state and credentials. One Codex runtime context
 * per tenant-facing workload — threads and credential material never cross
 * this boundary.
 */
export interface CodexTenantScope {
  /** DID of the user the runtime is acting for. */
  readonly userDid: string;
  /** Oracle entity DID — distinguishes deployments sharing a homeserver. */
  readonly oracleEntityDid: string;
}

/** Opaque, filesystem-safe key derived from a tenant scope. */
export function tenantScopeKey(scope: CodexTenantScope): string {
  const raw = `${scope.oracleEntityDid}::${scope.userDid}`;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** True when the status is resolvable by the user re-authenticating. */
export function isAuthActionable(status: CodexConnectionStatus): boolean {
  return (
    status === 'requires_sign_in' ||
    status === 'requires_device_authorization' ||
    status === 'invalid_credentials'
  );
}
