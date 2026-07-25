import { randomUUID } from 'node:crypto';
import type { RuntimeContext } from '../../../plugin-api/types.js';
import type { CodexApprovalRequest } from '../app-server/client.js';
import type { CodexApprovalDecision } from '../app-server/protocol.js';
import { CODEX_PROVIDER_ID } from '../domain/provider.js';

/** An approval Codex is blocked on, as shown to a client. Never auto-resolved. */
export interface PendingCodexApproval {
  readonly id: string;
  readonly tenant: string;
  readonly kind: CodexApprovalRequest['kind'];
  readonly threadId?: string;
  readonly turnId?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly reason?: string;
  readonly requestedAt: number;
}

interface GateEntry {
  approval: PendingCodexApproval;
  settle: (decision: CodexApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export interface CodexApprovalGateOptions {
  /**
   * How long an approval may stay open. On expiry the gate declines — the
   * safe default. Never `accept`.
   */
  timeoutMs: number;
  now?: () => number;
}

/**
 * Holds Codex approval requests open while a human decides.
 *
 * Codex blocks its turn on a server→client request; the gate parks that
 * request, emits an `action_call` event so any connected client (first- or
 * third-party) can render the prompt, and settles when a decision arrives via
 * `resolve`. Nothing here ever grants an approval on its own: an unanswered
 * request expires to `decline`.
 */
export class CodexApprovalGate {
  private readonly pending = new Map<string, GateEntry>();

  private readonly now: () => number;

  constructor(private readonly options: CodexApprovalGateOptions) {
    this.now = options.now ?? Date.now;
  }

  open(params: {
    tenant: string;
    request: CodexApprovalRequest;
    ctx: Pick<RuntimeContext, 'emit' | 'logger'>;
  }): Promise<CodexApprovalDecision> {
    const { tenant, request, ctx } = params;
    const id = randomUUID();
    const approval: PendingCodexApproval = {
      id,
      tenant,
      kind: request.kind,
      requestedAt: this.now(),
      ...(request.params.threadId ? { threadId: request.params.threadId } : {}),
      ...(request.params.turnId ? { turnId: request.params.turnId } : {}),
      ...(request.params.command ? { command: request.params.command } : {}),
      ...(request.params.cwd ? { cwd: request.params.cwd } : {}),
      ...(request.params.reason ? { reason: request.params.reason } : {}),
    };

    return new Promise<CodexApprovalDecision>((resolvePromise) => {
      const settle = (decision: CodexApprovalDecision) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        resolvePromise(decision);
      };

      const timer = setTimeout(() => {
        ctx.logger.warn('codex approval expired without a decision', {
          approvalId: id,
          kind: request.kind,
        });
        settle('decline');
      }, this.options.timeoutMs);
      timer.unref?.();

      this.pending.set(id, { approval, settle, timer });

      ctx.emit.actionCall({
        provider: CODEX_PROVIDER_ID,
        action: 'codex.approval.required',
        approvalId: id,
        kind: approval.kind,
        threadId: approval.threadId,
        turnId: approval.turnId,
        command: approval.command,
        cwd: approval.cwd,
      });
    });
  }

  /** Settle a pending approval. Tenant-scoped — a mismatch is a miss. */
  resolve(
    tenant: string,
    approvalId: string,
    decision: CodexApprovalDecision,
  ): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.approval.tenant !== tenant) return false;
    entry.settle(decision);
    return true;
  }

  /** Open approvals for one tenant, oldest first. */
  list(tenant: string): PendingCodexApproval[] {
    return [...this.pending.values()]
      .filter((entry) => entry.approval.tenant === tenant)
      .map((entry) => entry.approval)
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** Decline everything outstanding for a tenant (disconnect, mode change). */
  declineAll(tenant: string): number {
    const entries = [...this.pending.values()].filter(
      (entry) => entry.approval.tenant === tenant,
    );
    for (const entry of entries) entry.settle('decline');
    return entries.length;
  }
}
