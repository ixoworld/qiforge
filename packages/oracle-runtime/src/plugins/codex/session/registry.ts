import type { Logger } from '../../../plugin-api/types.js';
import type { CodexApprovalDecision } from '../app-server/protocol.js';
import type { CodexConnectionSnapshot } from '../auth/connection-state.js';
import type { CodexRuntimePlan } from '../domain/preflight.js';
import { tenantScopeKey, type CodexTenantScope } from '../domain/provider.js';
import {
  CodexApprovalGate,
  type PendingCodexApproval,
} from './approval-gate.js';
import {
  CodexSession,
  type CodexConnectDeps,
  type CodexTransportFactory,
} from './codex-session.js';

export interface CodexRegistryOptions {
  plan: CodexRuntimePlan;
  logger: Logger;
  clientVersion: string;
  transportFactory?: CodexTransportFactory;
  approvalTimeoutMs: number;
}

/**
 * Owns one `CodexSession` per tenant plus the shared approval gate.
 *
 * The registry is the only place sessions are created, which is what keeps the
 * tenant boundary enforceable: every lookup goes through a
 * `CodexTenantScope`, and nothing hands out a session by raw key.
 */
export class CodexRuntimeRegistry {
  private readonly sessions = new Map<string, CodexSession>();

  readonly gate: CodexApprovalGate;

  constructor(private readonly options: CodexRegistryOptions) {
    this.gate = new CodexApprovalGate({
      timeoutMs: options.approvalTimeoutMs,
    });
  }

  plan(): CodexRuntimePlan {
    return this.options.plan;
  }

  for(scope: CodexTenantScope): CodexSession {
    const key = tenantScopeKey(scope);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session = new CodexSession({
      plan: this.options.plan,
      scope,
      gate: this.gate,
      logger: this.options.logger,
      clientVersion: this.options.clientVersion,
      ...(this.options.transportFactory
        ? { transportFactory: this.options.transportFactory }
        : {}),
    });
    this.sessions.set(key, session);
    return session;
  }

  snapshot(scope: CodexTenantScope): CodexConnectionSnapshot {
    return this.for(scope).snapshot();
  }

  /** Resolve an approval for this tenant. Returns false when unknown. */
  resolveApproval(
    scope: CodexTenantScope,
    approvalId: string,
    decision: CodexApprovalDecision,
  ): boolean {
    return this.gate.resolve(tenantScopeKey(scope), approvalId, decision);
  }

  pendingApprovals(scope: CodexTenantScope): PendingCodexApproval[] {
    return this.gate.list(tenantScopeKey(scope));
  }

  async connect(
    scope: CodexTenantScope,
    deps: CodexConnectDeps,
  ): Promise<CodexConnectionSnapshot> {
    return this.for(scope).connect(deps);
  }

  async disconnect(scope: CodexTenantScope): Promise<CodexConnectionSnapshot> {
    const session = this.for(scope);
    await session.disconnect();
    return session.snapshot();
  }

  /** Shut every tenant down — used on module destroy. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        session.disconnect('runtime_shutdown').catch(() => undefined),
      ),
    );
    this.sessions.clear();
  }
}
