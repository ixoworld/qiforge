import type { Logger, RuntimeContext } from '../../../plugin-api/types.js';
import {
  CodexAppServerClient,
  CodexRpcError,
  type CodexApprovalRequest,
} from '../app-server/client.js';
import {
  CodexTurnTranscript,
  emitCodexEvent,
  mapNotification,
  type CodexRuntimeEvent,
} from '../app-server/event-mapper.js';
import {
  CODEX_METHODS,
  accountReadResultSchema,
  threadStartResultSchema,
  turnStartResultSchema,
  type CodexApprovalDecision,
} from '../app-server/protocol.js';
import {
  StdioCodexTransport,
  type CodexTransport,
  type StdioTransportOptions,
} from '../app-server/transport.js';
import {
  CodexConnectionState,
  type CodexConnectionSnapshot,
  type CodexTransition,
} from '../auth/connection-state.js';
import {
  redactCredentialEnv,
  resolveCodexCredentials,
  type CodexSecretReader,
} from '../auth/credentials.js';
import type { CodexRuntimePlan } from '../domain/preflight.js';
import { tenantScopeKey, type CodexTenantScope } from '../domain/provider.js';
import type { CodexApprovalGate } from './approval-gate.js';

/** Creates a started transport. Injectable so tests drive a real fixture server. */
export type CodexTransportFactory = (
  options: StdioTransportOptions,
) => CodexTransport;

export const defaultTransportFactory: CodexTransportFactory = (options) => {
  const transport = new StdioCodexTransport(options);
  transport.start();
  return transport;
};

export interface CodexSessionOptions {
  plan: CodexRuntimePlan;
  scope: CodexTenantScope;
  gate: CodexApprovalGate;
  logger: Logger;
  transportFactory?: CodexTransportFactory;
  clientVersion: string;
}

/** What `connect` needs. Deliberately narrow — no graph run required. */
export interface CodexConnectDeps {
  secrets: CodexSecretReader;
}

/** Emit + logger for the turn currently in flight. */
export type CodexTurnContext = Pick<RuntimeContext, 'emit' | 'logger'>;

export interface CodexTurnRequest {
  prompt: string;
  /** Resume this thread instead of starting a new one. */
  threadId?: string;
  ctx: Pick<RuntimeContext, 'emit' | 'logger' | 'abortSignal' | 'secrets'>;
}

export interface CodexTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: 'completed' | 'interrupted' | 'failed';
  readonly text: string;
  readonly error?: string;
}

export class CodexSessionError extends Error {
  constructor(
    message: string,
    readonly status: CodexConnectionSnapshot['status'],
  ) {
    super(`codex: ${message}`);
    this.name = 'CodexSessionError';
  }
}

interface PendingTurn {
  turnId?: string;
  transcript: CodexTurnTranscript;
  settle: (result: {
    turnId: string;
    status: 'completed' | 'interrupted' | 'failed';
    error?: string;
  }) => void;
  fail: (error: Error) => void;
}

/**
 * One tenant's Codex runtime: a long-lived App Server connection plus the
 * thread it owns. All state — credentials, thread id, approvals — is scoped to
 * the tenant key and never shared across instances.
 */
export class CodexSession {
  private client: CodexAppServerClient | null = null;

  private threadId: string | null = null;

  private pendingTurn: PendingTurn | null = null;

  /** Set only while a turn is in flight; streaming events go here. */
  private activeCtx: CodexTurnContext | null = null;

  private reconnectAttempts = 0;

  private connecting: Promise<void> | null = null;

  private readonly state: CodexConnectionState;

  private readonly tenant: string;

  private readonly transportFactory: CodexTransportFactory;

  constructor(private readonly options: CodexSessionOptions) {
    this.tenant = tenantScopeKey(options.scope);
    this.state = new CodexConnectionState(options.scope, options.plan.authMode);
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
  }

  snapshot(): CodexConnectionSnapshot {
    return this.state.snapshot();
  }

  history(): readonly CodexTransition[] {
    return this.state.history();
  }

  tenantKey(): string {
    return this.tenant;
  }

  currentThreadId(): string | null {
    return this.threadId;
  }

  async connect(deps: CodexConnectDeps): Promise<CodexConnectionSnapshot> {
    if (this.client && this.state.current() === 'connected') {
      return this.state.snapshot();
    }
    // A previous connection died. Reconnecting is bounded so a persistently
    // broken binary can't spin on every turn.
    if (this.state.current() === 'error' && !this.connecting) {
      if (!this.canReconnect()) {
        throw new CodexSessionError(
          `app server unavailable after ${this.reconnectAttempts} reconnect attempts`,
          'error',
        );
      }
      this.noteReconnectAttempt();
    }
    // Concurrent turns must not race two App Server processes into existence.
    this.connecting ??= this.doConnect(deps).finally(() => {
      this.connecting = null;
    });
    await this.connecting;
    return this.state.snapshot();
  }

  private async doConnect(deps: CodexConnectDeps): Promise<void> {
    const { config } = this.options.plan;
    this.state.transition('connecting', 'connect_requested');

    const outcome = await resolveCodexCredentials({
      config,
      scope: this.options.scope,
      secrets: deps.secrets,
    });

    if (outcome.kind === 'requires_sign_in') {
      this.state.transition('requires_sign_in', 'auth_missing', {
        detail: outcome.detail,
      });
      throw new CodexSessionError(outcome.detail, 'requires_sign_in');
    }

    const { credentials } = outcome;
    this.options.logger.log('starting codex app server', {
      tenant: this.tenant,
      command: config.command,
      env: redactCredentialEnv(credentials.env),
    });

    let transport: CodexTransport;
    try {
      transport = this.transportFactory({
        command: config.command,
        args: config.args,
        cwd: config.workspaceRoot,
        env: credentials.env,
        onStderr: (line) =>
          this.options.logger.warn('codex app server stderr', {
            tenant: this.tenant,
            line,
          }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.state.transition('unsupported_environment', 'environment_unusable', {
        detail,
      });
      throw new CodexSessionError(detail, 'unsupported_environment');
    }

    this.client = new CodexAppServerClient({
      transport,
      requestTimeoutMs: config.startupTimeoutMs,
      clientInfo: {
        name: 'qiforge-oracle-runtime',
        title: 'QiForge',
        version: this.options.clientVersion,
      },
      onNotification: (method, params) =>
        this.handleNotification(method, params),
      onApproval: (request) => this.handleApproval(request),
      onClose: (info) => this.handleTransportClose(info),
    });

    try {
      await this.client.initialize(config.startupTimeoutMs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.teardown();
      this.state.transition('unsupported_environment', 'environment_unusable', {
        detail: `handshake failed — ${detail}`,
      });
      throw new CodexSessionError(
        `handshake failed — ${detail}`,
        'unsupported_environment',
      );
    }

    await this.assertAuthenticated();

    this.state.transition('connected', 'handshake_ok');
  }

  /**
   * The App Server is the authority on whether its credentials work — a present
   * `auth.json` or API key is necessary, not sufficient.
   */
  private async assertAuthenticated(): Promise<void> {
    const client = this.client;
    if (!client) throw new CodexSessionError('client not started', 'error');

    let raw: unknown;
    try {
      raw = await client.request(CODEX_METHODS.accountRead, {});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.teardown();
      this.state.transition('invalid_credentials', 'auth_rejected', { detail });
      throw new CodexSessionError(detail, 'invalid_credentials');
    }

    const parsed = accountReadResultSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.account) {
      await this.teardown();
      const detail =
        this.options.plan.authMode === 'chatgpt_subscription'
          ? 'The Codex App Server reports no signed-in ChatGPT account.'
          : 'The Codex App Server rejected the configured API key.';
      this.state.transition('invalid_credentials', 'auth_rejected', { detail });
      throw new CodexSessionError(detail, 'invalid_credentials');
    }
  }

  async runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    const { config, capabilities } = this.options.plan;
    await this.connect({ secrets: request.ctx.secrets });

    const client = this.client;
    if (!client) throw new CodexSessionError('not connected', 'error');

    const threadId = await this.ensureThread(request.threadId);

    const transcript = new CodexTurnTranscript();
    const completion = new Promise<{
      turnId: string;
      status: 'completed' | 'interrupted' | 'failed';
      error?: string;
    }>((resolveTurn, rejectTurn) => {
      this.pendingTurn = { transcript, settle: resolveTurn, fail: rejectTurn };
    });
    this.activeCtx = { emit: request.ctx.emit, logger: request.ctx.logger };

    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: request.prompt }],
      effort: config.reasoningEffort,
    };
    // Under a subscription the plan decides the model; sending an override
    // yields an opaque upstream rejection instead of a useful error.
    if (capabilities.modelOverride && config.model) {
      params.model = config.model;
    }

    let turnId: string;
    try {
      const raw = await client.request(CODEX_METHODS.turnStart, params, {
        timeoutMs: config.turnTimeoutMs,
        signal: request.ctx.abortSignal,
      });
      turnId = turnStartResultSchema.parse(raw).turn.id;
      if (this.pendingTurn) this.pendingTurn.turnId = turnId;
    } catch (error) {
      this.pendingTurn = null;
      this.activeCtx = null;
      throw this.asSessionError(error);
    }

    const abortListener = () => {
      void this.interrupt(turnId);
    };
    request.ctx.abortSignal.addEventListener('abort', abortListener, {
      once: true,
    });

    const timeout = setTimeout(() => {
      this.pendingTurn?.fail(
        new CodexSessionError(
          `turn ${turnId} exceeded ${config.turnTimeoutMs}ms`,
          'error',
        ),
      );
    }, config.turnTimeoutMs);
    timeout.unref?.();

    try {
      const outcome = await completion;
      // A handshake alone doesn't prove health: a binary that starts and then
      // dies every turn must still exhaust the budget. Only a turn that ran to
      // completion earns a fresh one.
      this.reconnectAttempts = 0;
      return {
        threadId,
        turnId: outcome.turnId,
        status: outcome.status,
        text: transcript.text(),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    } catch (error) {
      throw this.asSessionError(error);
    } finally {
      clearTimeout(timeout);
      request.ctx.abortSignal.removeEventListener('abort', abortListener);
      this.pendingTurn = null;
      this.activeCtx = null;
    }
  }

  private async ensureThread(requested?: string): Promise<string> {
    const client = this.client;
    if (!client) throw new CodexSessionError('not connected', 'error');
    const { config, capabilities } = this.options.plan;

    const target = requested ?? this.threadId;
    if (target) {
      try {
        const raw = await client.request(
          CODEX_METHODS.threadResume,
          { threadId: target },
          { timeoutMs: config.startupTimeoutMs },
        );
        this.threadId = threadStartResultSchema.parse(raw).thread.id;
        return this.threadId;
      } catch (error) {
        // A thread the App Server no longer holds is recoverable: start a new
        // one rather than failing the user's turn.
        this.options.logger.warn('codex thread resume failed, starting fresh', {
          tenant: this.tenant,
          threadId: target,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const raw = await client.request(
      CODEX_METHODS.threadStart,
      {
        cwd: config.workspaceRoot,
        sandbox: config.sandboxMode,
        approvalPolicy: config.approvalPolicy,
        ...(capabilities.modelOverride && config.model
          ? { model: config.model }
          : {}),
      },
      { timeoutMs: config.startupTimeoutMs },
    );
    this.threadId = threadStartResultSchema.parse(raw).thread.id;
    return this.threadId;
  }

  async interrupt(turnId?: string): Promise<void> {
    const client = this.client;
    const target = turnId ?? this.pendingTurn?.turnId;
    if (!client || !this.threadId || !target) return;
    try {
      await client.request(CODEX_METHODS.turnInterrupt, {
        threadId: this.threadId,
        turnId: target,
      });
    } catch (error) {
      this.options.logger.warn('codex interrupt failed', {
        tenant: this.tenant,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async disconnect(reason = 'disconnect_requested'): Promise<void> {
    this.options.gate.declineAll(this.tenant);
    await this.teardown();
    if (this.state.current() !== 'disconnected') {
      this.state.transition('disconnected', 'disconnect_requested', {
        detail: reason,
      });
    }
  }

  /** Explicit operator mode switch. Drops the connection and audits the change. */
  async setAuthMode(mode: CodexRuntimePlan['authMode']): Promise<void> {
    await this.teardown();
    this.options.gate.declineAll(this.tenant);
    this.threadId = null;
    this.state.setAuthMode(mode);
  }

  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
  }

  private handleNotification(method: string, params: unknown): void {
    const event = mapNotification(method, params);
    if (!event) return;

    const ctx = this.activeCtx;
    if (ctx && this.threadId) emitCodexEvent(event, ctx, this.threadId);
    this.pendingTurn?.transcript.record(event);
    this.settleOnCompletion(event);
  }

  private settleOnCompletion(event: CodexRuntimeEvent): void {
    if (event.type !== 'turn.completed') return;
    const pending = this.pendingTurn;
    if (!pending) return;
    // Notifications can arrive before `turn/start` returns its id, so an
    // unidentified pending turn accepts the first completion it sees.
    if (pending.turnId && pending.turnId !== event.turnId) return;
    pending.settle({
      turnId: event.turnId,
      status: event.status,
      ...(event.error ? { error: event.error } : {}),
    });
  }

  private async handleApproval(
    request: CodexApprovalRequest,
  ): Promise<CodexApprovalDecision> {
    const ctx = this.activeCtx;
    // No turn in flight means no client is listening for the prompt. Declining
    // is the only safe answer — never accept on the user's behalf.
    if (!ctx) {
      this.options.logger.warn('codex approval arrived outside a turn', {
        tenant: this.tenant,
        kind: request.kind,
      });
      return 'decline';
    }
    return this.options.gate.open({ tenant: this.tenant, request, ctx });
  }

  private handleTransportClose(info: {
    code: number | null;
    detail?: string;
  }): void {
    const detail = info.detail ?? `app server exited (code ${info.code})`;
    this.client = null;

    this.pendingTurn?.fail(new CodexSessionError(detail, 'error'));
    this.pendingTurn = null;
    this.options.gate.declineAll(this.tenant);

    if (this.state.current() === 'connected') {
      this.state.transition('error', 'transport_closed', { detail });
    }
  }

  /** Whether a fresh connect is worth attempting after a transport failure. */
  canReconnect(): boolean {
    return (
      this.reconnectAttempts < this.options.plan.config.maxReconnectAttempts
    );
  }

  private noteReconnectAttempt(): void {
    this.reconnectAttempts += 1;
    this.state.transition('connecting', 'reconnect_attempt', {
      detail: `attempt ${this.reconnectAttempts}`,
    });
  }

  private asSessionError(error: unknown): Error {
    if (error instanceof CodexSessionError) return error;
    if (error instanceof CodexRpcError) {
      return new CodexSessionError(error.message, this.state.current());
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
