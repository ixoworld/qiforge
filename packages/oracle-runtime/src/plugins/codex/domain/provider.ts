import { createHash } from 'node:crypto';

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

/**
 * Filesystem-safe key for a tenant scope.
 *
 * Sanitizing alone is not injective — `did:x:a:b` and `did:x:a_b` would
 * collapse to the same key, and this value indexes sessions, approvals and
 * credential directories. The readable prefix is therefore paired with a
 * digest of the exact scope, so distinct DIDs can never collide.
 */
export function tenantScopeKey(scope: CodexTenantScope): string {
  const raw = `${scope.oracleEntityDid}\u0000${scope.userDid}`;
  const readable = `${scope.oracleEntityDid}::${scope.userDid}`
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `${readable}-${digest}`;
}

/** True when the status is resolvable by the user re-authenticating. */
export function isAuthActionable(status: CodexConnectionStatus): boolean {
  return (
    status === 'requires_sign_in' ||
    status === 'requires_device_authorization' ||
    status === 'invalid_credentials'
  );
}
