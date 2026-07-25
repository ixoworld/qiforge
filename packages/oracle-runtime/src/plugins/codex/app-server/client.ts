import {
  CODEX_APPROVAL_REQUESTS,
  CODEX_METHODS,
  approvalParamsSchema,
  classifyFrame,
  type CodexApprovalDecision,
  type CodexApprovalParams,
  type JsonRpcId,
} from './protocol.js';
import type { CodexTransport } from './transport.js';

/** A request the App Server makes of us. Today: the two approval gates. */
export interface CodexApprovalRequest {
  readonly kind: 'commandExecution' | 'fileChange';
  readonly params: CodexApprovalParams;
}

export type CodexApprovalHandler = (
  request: CodexApprovalRequest,
) => Promise<CodexApprovalDecision>;

export type CodexNotificationHandler = (
  method: string,
  params: unknown,
) => void;

export interface CodexClientOptions {
  transport: CodexTransport;
  /** Applied to every request that does not pass its own timeout. */
  requestTimeoutMs: number;
  onNotification: CodexNotificationHandler;
  /**
   * Answers server-initiated approval requests. Required — an App Server that
   * asks for approval must never be auto-allowed by the adapter.
   */
  onApproval: CodexApprovalHandler;
  onClose?: (info: { code: number | null; detail?: string }) => void;
  clientInfo: { name: string; title: string; version: string };
}

/** Structured error carrying the upstream JSON-RPC code when there was one. */
export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
  ) {
    super(`codex: ${method} failed — ${message}`);
    this.name = 'CodexRpcError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

const APPROVAL_METHOD_KINDS: Record<string, CodexApprovalRequest['kind']> = {
  [CODEX_APPROVAL_REQUESTS.commandExecution]: 'commandExecution',
  [CODEX_APPROVAL_REQUESTS.fileChange]: 'fileChange',
};

/**
 * Bidirectional JSON-RPC client for one App Server connection. Owns id
 * correlation, per-request timeouts, cancellation, and the approval
 * round-trip; knows nothing about threads or QiForge events.
 */
export class CodexAppServerClient {
  private nextId = 1;

  private readonly pending = new Map<JsonRpcId, Pending>();

  private closed = false;

  private closeReason?: string;

  constructor(private readonly options: CodexClientOptions) {
    options.transport.onMessage((frame) => this.handleFrame(frame));
    options.transport.onClose((info) => this.handleClose(info));
  }

  /** Handshake. Must complete before any thread or turn call. */
  async initialize(timeoutMs: number): Promise<unknown> {
    const result = await this.request(
      CODEX_METHODS.initialize,
      {
        clientInfo: this.options.clientInfo,
        capabilities: { experimentalApi: false },
      },
      { timeoutMs },
    );
    this.notify(CODEX_METHODS.initialized, {});
    return result;
  }

  async request(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.closed) {
      throw new CodexRpcError(this.closeReason ?? 'connection closed', method);
    }

    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs;

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const settleReject = (error: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        opts.signal?.removeEventListener('abort', onAbort);
        rejectPromise(error);
      };

      const onAbort = () => {
        settleReject(new CodexRpcError('cancelled by caller', method));
      };

      const timer = setTimeout(() => {
        settleReject(
          new CodexRpcError(`timed out after ${timeoutMs}ms`, method),
        );
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        timer,
        reject: settleReject,
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(id);
          opts.signal?.removeEventListener('abort', onAbort);
          resolvePromise(value);
        },
      });

      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        this.options.transport.send({ id, method, params });
      } catch (error) {
        settleReject(
          new CodexRpcError(
            error instanceof Error ? error.message : String(error),
            method,
          ),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.options.transport.send({ method, params });
  }

  async close(): Promise<void> {
    this.handleClose({ code: null, detail: 'closed by client' });
    await this.options.transport.close();
  }

  private handleFrame(raw: unknown): void {
    const frame = classifyFrame(raw);
    if (!frame) return;

    if (frame.kind === 'response') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      if (frame.error) {
        entry.reject(
          new CodexRpcError(
            frame.error.message,
            entry.method,
            frame.error.code,
          ),
        );
        return;
      }
      entry.resolve(frame.result);
      return;
    }

    if (frame.kind === 'notification') {
      this.options.onNotification(frame.method, frame.params);
      return;
    }

    void this.handleServerRequest(frame.id, frame.method, frame.params);
  }

  private async handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const kind = APPROVAL_METHOD_KINDS[method];
    if (!kind) {
      this.options.transport.send({
        id,
        error: { code: -32601, message: `unsupported request: ${method}` },
      });
      return;
    }

    const parsed = approvalParamsSchema.safeParse(params);
    if (!parsed.success) {
      // A malformed approval request is refused, never accepted by default.
      this.options.transport.send({ id, result: { decision: 'decline' } });
      return;
    }

    let decision: CodexApprovalDecision;
    try {
      decision = await this.options.onApproval({ kind, params: parsed.data });
    } catch {
      decision = 'decline';
    }

    if (this.closed) return;
    this.options.transport.send({ id, result: { decision } });
  }

  private handleClose(info: { code: number | null; detail?: string }): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = info.detail ?? `app server exited (code ${info.code})`;

    for (const [, entry] of this.pending) {
      entry.reject(new CodexRpcError(this.closeReason, entry.method));
    }
    this.pending.clear();
    this.options.onClose?.(info);
  }
}
