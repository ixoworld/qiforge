import type {
  CodexAuthMode,
  CodexConnectionStatus,
  CodexTenantScope,
} from '../domain/provider.js';
import { tenantScopeKey } from '../domain/provider.js';

/** Why a transition happened. Recorded verbatim in the audit trail. */
export type CodexTransitionReason =
  | 'connect_requested'
  | 'handshake_ok'
  | 'auth_missing'
  | 'auth_pending_browser'
  | 'auth_rejected'
  | 'environment_unusable'
  | 'transport_closed'
  | 'reconnect_attempt'
  | 'disconnect_requested'
  | 'auth_mode_changed'
  | 'runtime_error';

/** One auditable state transition. Never carries credential material. */
export interface CodexTransition {
  readonly tenant: string;
  readonly authMode: CodexAuthMode;
  readonly from: CodexConnectionStatus;
  readonly to: CodexConnectionStatus;
  readonly reason: CodexTransitionReason;
  readonly at: number;
  /** Operator-facing detail. Callers must pass sanitized text only. */
  readonly detail?: string;
}

/**
 * Legal edges. Anything absent is a bug in the caller, not a state to fall
 * into silently — `transition` throws rather than corrupting the record.
 */
const CONNECTION_TRANSITIONS: Record<
  CodexConnectionStatus,
  readonly CodexConnectionStatus[]
> = {
  disconnected: ['connecting', 'unsupported_environment'],
  connecting: [
    'connected',
    'requires_sign_in',
    'requires_device_authorization',
    'invalid_credentials',
    'unsupported_environment',
    'error',
    'disconnected',
  ],
  connected: ['disconnected', 'error', 'invalid_credentials', 'connecting'],
  requires_sign_in: ['connecting', 'disconnected'],
  requires_device_authorization: [
    'connecting',
    'requires_sign_in',
    'disconnected',
  ],
  invalid_credentials: ['connecting', 'disconnected'],
  unsupported_environment: ['connecting', 'disconnected'],
  error: ['connecting', 'disconnected'],
};

export class CodexTransitionError extends Error {
  constructor(
    from: CodexConnectionStatus,
    to: CodexConnectionStatus,
    reason: CodexTransitionReason,
  ) {
    super(`codex: illegal connection transition ${from} → ${to} (${reason})`);
    this.name = 'CodexTransitionError';
  }
}

export function canTransition(
  from: CodexConnectionStatus,
  to: CodexConnectionStatus,
): boolean {
  return CONNECTION_TRANSITIONS[from].includes(to);
}

/** Snapshot returned to the settings UI. Credential-free by construction. */
export interface CodexConnectionSnapshot {
  readonly tenant: string;
  readonly authMode: CodexAuthMode;
  readonly status: CodexConnectionStatus;
  readonly since: number;
  readonly detail?: string;
  /** URL the user must open to finish a ChatGPT sign-in, when one is pending. */
  readonly authorizationUrl?: string;
}

/**
 * Per-tenant connection state with a bounded audit trail. Holds no
 * credentials — only the status derived from them.
 */
export class CodexConnectionState {
  private status: CodexConnectionStatus = 'disconnected';

  private since: number;

  private detail: string | undefined;

  private authorizationUrl: string | undefined;

  private readonly log: CodexTransition[] = [];

  private readonly tenant: string;

  constructor(
    scope: CodexTenantScope,
    private authMode: CodexAuthMode,
    private readonly now: () => number = Date.now,
    private readonly maxLogEntries = 50,
  ) {
    this.tenant = tenantScopeKey(scope);
    this.since = this.now();
  }

  current(): CodexConnectionStatus {
    return this.status;
  }

  mode(): CodexAuthMode {
    return this.authMode;
  }

  snapshot(): CodexConnectionSnapshot {
    return {
      tenant: this.tenant,
      authMode: this.authMode,
      status: this.status,
      since: this.since,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.authorizationUrl
        ? { authorizationUrl: this.authorizationUrl }
        : {}),
    };
  }

  /** Chronological audit trail, oldest first. */
  history(): readonly CodexTransition[] {
    return [...this.log];
  }

  transition(
    to: CodexConnectionStatus,
    reason: CodexTransitionReason,
    extra: { detail?: string; authorizationUrl?: string } = {},
  ): CodexTransition {
    const from = this.status;
    if (from !== to && !canTransition(from, to)) {
      throw new CodexTransitionError(from, to, reason);
    }

    const record: CodexTransition = {
      tenant: this.tenant,
      authMode: this.authMode,
      from,
      to,
      reason,
      at: this.now(),
      ...(extra.detail ? { detail: extra.detail } : {}),
    };

    this.status = to;
    this.since = record.at;
    this.detail = extra.detail;
    // Only a pending browser authorization carries a URL; every other
    // transition clears it so a stale link is never shown as actionable.
    this.authorizationUrl =
      to === 'requires_device_authorization'
        ? extra.authorizationUrl
        : undefined;

    this.log.push(record);
    if (this.log.length > this.maxLogEntries) this.log.shift();
    return record;
  }

  /**
   * Change the billing/auth mode. Always emits a transition so the switch is
   * observable, and drops the connection: credentials from the previous mode
   * must not carry into the new one.
   */
  setAuthMode(next: CodexAuthMode): CodexTransition {
    if (next === this.authMode) {
      throw new Error(`codex: auth mode is already '${next}'`);
    }
    if (this.status !== 'disconnected') {
      this.transition('disconnected', 'auth_mode_changed');
    }
    this.authMode = next;
    return this.transition('disconnected', 'auth_mode_changed', {
      detail: `auth mode set to ${next}`,
    });
  }
}
