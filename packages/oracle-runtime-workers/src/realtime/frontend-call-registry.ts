/**
 * Pending frontend (browser-tool / AG-UI action) calls awaiting a result
 * from the user's browser — the Workers counterpart of the Node runtime's
 * `callFrontendTool`, which parks a promise on `rootEventEmitter` until the
 * socket delivers `browser_tool_result` / `action_call_result` for the same
 * `toolCallId`.
 *
 * Settlement rules are Node's, verbatim:
 *   - `error` set                      → reject(Error(error))
 *   - AG-UI and `result.success === false` → reject(Error(result.error ?? 'Action failed'))
 *   - otherwise                        → resolve(result)
 *   - no result within `timeoutMs`     → reject("<kind> timeout after <ms>ms: <tool>")
 *
 * Purely in-memory: a pending call does not survive an object restart, and
 * neither does the turn that made it.
 */

export type FrontendCallKind = 'browser' | 'agui';

export interface FrontendCallResult {
  toolCallId: string;
  result?: unknown;
  error?: string;
}

export interface PendingFrontendCall {
  kind: FrontendCallKind;
  toolCallId: string;
  toolName: string;
  sessionId: string;
  startedAt: number;
}

interface Pending extends PendingFrontendCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const KIND_LABEL: Record<FrontendCallKind, string> = {
  browser: 'Browser tool',
  agui: 'AG-UI action',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readSuccessFlag(result: unknown): {
  success?: boolean;
  error?: string;
} {
  if (!isRecord(result)) return {};
  const record = result;
  return {
    ...(typeof record.success === 'boolean' ? { success: record.success } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

export class FrontendCallRegistry {
  private readonly pending = new Map<string, Pending>();

  private key(kind: FrontendCallKind, toolCallId: string): string {
    return `${kind}:${toolCallId}`;
  }

  /**
   * Park a call until `settle` delivers its result or `timeoutMs` elapses.
   * `signal` (the turn's abort signal) rejects early so an aborted turn does
   * not keep a browser waiting.
   */
  wait(
    call: Omit<PendingFrontendCall, 'startedAt'>,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const key = this.key(call.kind, call.toolCallId);
    const existing = this.pending.get(key);
    if (existing) {
      this.finish(key);
      existing.reject(
        new Error(`${KIND_LABEL[call.kind]} ${call.toolCallId} was superseded`),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(key);
        reject(
          new Error(
            `${KIND_LABEL[call.kind]} timeout after ${opts.timeoutMs}ms: ${call.toolName}`,
          ),
        );
      }, opts.timeoutMs);
      const entry: Pending = {
        ...call,
        startedAt: Date.now(),
        resolve,
        reject,
        timer,
      };
      this.pending.set(key, entry);
      if (opts.signal) {
        const onAbort = () => {
          if (this.pending.get(key) !== entry) return;
          this.finish(key);
          reject(
            new Error(`${KIND_LABEL[call.kind]} ${call.toolName} aborted`),
          );
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Deliver a result from the socket. Returns false when nothing was waiting
   * for that id (late, duplicate or unknown result — logged by the caller).
   */
  settle(kind: FrontendCallKind, data: FrontendCallResult): boolean {
    const key = this.key(kind, data.toolCallId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.finish(key);
    if (data.error) {
      entry.reject(new Error(data.error));
      return true;
    }
    if (kind === 'agui') {
      const flags = readSuccessFlag(data.result);
      if (flags.success === false) {
        entry.reject(new Error(flags.error || 'Action failed'));
        return true;
      }
    }
    entry.resolve(data.result);
    return true;
  }

  /** Pending calls, oldest first (diagnostics / status). */
  list(): PendingFrontendCall[] {
    return [...this.pending.values()]
      .map(({ kind, toolCallId, toolName, sessionId, startedAt }) => ({
        kind,
        toolCallId,
        toolName,
        sessionId,
        startedAt,
      }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  get size(): number {
    return this.pending.size;
  }

  private finish(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
  }
}
