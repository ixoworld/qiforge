/**
 * End-to-end coverage of the App Server adapter against a real child process.
 *
 * The fixture in `__test-fixtures__/fake-app-server.mjs` speaks the same
 * newline-delimited JSON-RPC framing as `codex app-server`, so the stdio
 * transport, id correlation, streaming notifications, the approval round-trip
 * and turn completion are all exercised for real. Only the Codex binary is
 * substituted — everything in this package runs as it does in production.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, RuntimeContext } from '../../../plugin-api/types.js';
import { preflight, type CodexRuntimePlan } from '../domain/preflight.js';
import type { CodexTenantScope } from '../domain/provider.js';
import { CodexApprovalGate } from './approval-gate.js';
import { CodexSession, CodexSessionError } from './codex-session.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '__test-fixtures__',
  'fake-app-server.mjs',
);

const scope: CodexTenantScope = {
  userDid: 'did:ixo:user1',
  oracleEntityDid: 'did:ixo:oracle1',
};

const logger: Logger = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

const emit = () => ({
  toolCall: vi.fn(() => {}),
  actionCall: vi.fn(() => {}),
  renderComponent: vi.fn(() => {}),
  reasoning: vi.fn(() => {}),
  browserToolCall: vi.fn(() => {}),
  router: vi.fn(() => {}),
  messageCacheInvalidation: vi.fn(() => {}),
});

/** Full `RuntimeContext.secrets` shape — the session only reads `getValues`. */
const secretsWith = (
  values: Record<string, string>,
): RuntimeContext['secrets'] => ({
  getIndex: async () => ({}),
  getValues: async () => values,
});

const apiKeySecrets = secretsWith({ OPENAI_API_KEY: 'sk-fixture' });
const noSecrets = secretsWith({});

describe('CodexSession against a live App Server process', () => {
  let homeRoot: string;
  let sessions: CodexSession[];

  beforeEach(async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'codex-session-'));
    sessions = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.disconnect()));
  });

  const planFor = (overrides: Record<string, string> = {}): CodexRuntimePlan =>
    preflight({
      CODEX_AUTH_MODE: 'api_key',
      CODEX_HOME_ROOT: homeRoot,
      CODEX_APP_SERVER_COMMAND: process.execPath,
      CODEX_APP_SERVER_ARGS: FIXTURE,
      CODEX_STARTUP_TIMEOUT_MS: '15000',
      CODEX_TURN_TIMEOUT_MS: '15000',
      ...overrides,
    });

  const makeSession = (
    plan: CodexRuntimePlan,
    gate = new CodexApprovalGate({ timeoutMs: 5_000 }),
  ) => {
    const session = new CodexSession({
      plan,
      scope,
      gate,
      logger,
      clientVersion: 'test',
    });
    sessions.push(session);
    return session;
  };

  const turnCtx = (emitter = emit(), secrets = apiKeySecrets) => ({
    emit: emitter,
    logger,
    abortSignal: new AbortController().signal,
    secrets,
  });

  it('runs an API-key turn end to end and returns the agent output', async () => {
    const session = makeSession(planFor());
    const emitter = emit();

    const result = await session.runTurn({
      prompt: 'do the thing',
      ctx: turnCtx(emitter),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('handled: do the thing');
    expect(result.threadId).toMatch(/^thr_/u);
    expect(session.snapshot().status).toBe('connected');
  });

  it('streams reasoning and turn lifecycle onto the QiForge event channels', async () => {
    const session = makeSession(planFor());
    const emitter = emit();

    await session.runTurn({ prompt: 'stream please', ctx: turnCtx(emitter) });

    expect(emitter.reasoning).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', text: 'planning' }),
    );
    expect(emitter.router).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'started' }),
    );
    expect(emitter.router).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'completed', status: 'completed' }),
    );
  });

  it('runs a subscription turn once the ChatGPT sign-in artefact exists', async () => {
    const plan = planFor({ CODEX_AUTH_MODE: 'chatgpt_subscription' });
    const session = makeSession(plan);
    // Materialize the tenant home the way a completed `codex login` would.
    await expect(
      session.runTurn({ prompt: 'x', ctx: turnCtx(emit(), noSecrets) }),
    ).rejects.toThrow(/ChatGPT sign-in/u);

    const home = join(homeRoot, 'did_ixo_oracle1__did_ixo_user1');
    await writeFile(join(home, 'auth.json'), '{"tokens":{}}');

    const result = await session.runTurn({
      prompt: 'subscription task',
      ctx: turnCtx(emit(), noSecrets),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('handled: subscription task');
  });

  it('reports requires_sign_in rather than starting without credentials', async () => {
    const session = makeSession(planFor());

    await expect(
      session.runTurn({ prompt: 'x', ctx: turnCtx(emit(), noSecrets) }),
    ).rejects.toThrow(CodexSessionError);
    expect(session.snapshot().status).toBe('requires_sign_in');
  });

  it('reports invalid_credentials when the App Server has no account', async () => {
    process.env.FAKE_CODEX_ACCOUNT = 'none';
    try {
      const session = makeSession(planFor());
      await expect(
        session.runTurn({ prompt: 'x', ctx: turnCtx() }),
      ).rejects.toThrow(/no signed-in|rejected the configured API key/u);
      expect(session.snapshot().status).toBe('invalid_credentials');
    } finally {
      delete process.env.FAKE_CODEX_ACCOUNT;
    }
  });

  it('reuses one thread across turns and resumes it', async () => {
    const session = makeSession(planFor());

    const first = await session.runTurn({ prompt: 'one', ctx: turnCtx() });
    const second = await session.runTurn({ prompt: 'two', ctx: turnCtx() });

    expect(second.threadId).toBe(first.threadId);
    expect(second.turnId).not.toBe(first.turnId);
  });

  it('starts a fresh thread when the requested one is gone', async () => {
    const session = makeSession(planFor());

    const result = await session.runTurn({
      prompt: 'resume a dead thread',
      threadId: 'thr_missing',
      ctx: turnCtx(),
    });

    expect(result.threadId).not.toBe('thr_missing');
    expect(result.status).toBe('completed');
  });

  describe('approvals', () => {
    beforeEach(() => {
      process.env.FAKE_CODEX_REQUIRE_APPROVAL = '1';
    });
    afterEach(() => {
      delete process.env.FAKE_CODEX_REQUIRE_APPROVAL;
    });

    it('surfaces the request to a client and applies the human decision', async () => {
      const gate = new CodexApprovalGate({ timeoutMs: 5_000 });
      const session = makeSession(planFor(), gate);
      const emitter = emit();
      const tenant = session.tenantKey();

      const turn = session.runTurn({
        prompt: 'needs approval',
        ctx: turnCtx(emitter),
      });

      const approvalId = await waitFor(() => gate.list(tenant)[0]?.id);
      expect(emitter.actionCall).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'codex.approval.required',
          command: 'rm -rf build',
        }),
      );

      expect(gate.resolve(tenant, approvalId, 'accept')).toBe(true);

      const result = await turn;
      expect(result.text).toBe('handled: needs approval');
      expect(emitter.toolCall).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'codex.commandExecution' }),
      );
    });

    it('passes a decline through instead of silently allowing the command', async () => {
      const gate = new CodexApprovalGate({ timeoutMs: 5_000 });
      const session = makeSession(planFor(), gate);
      const tenant = session.tenantKey();

      const turn = session.runTurn({ prompt: 'nope', ctx: turnCtx() });
      const approvalId = await waitFor(() => gate.list(tenant)[0]?.id);
      gate.resolve(tenant, approvalId, 'decline');

      expect((await turn).text).toBe('declined: decline');
    });

    it('declines when nobody answers in time', async () => {
      const gate = new CodexApprovalGate({ timeoutMs: 50 });
      const session = makeSession(planFor(), gate);

      expect(
        (await session.runTurn({ prompt: 'x', ctx: turnCtx() })).text,
      ).toBe('declined: decline');
    });

    it('refuses a resolution from a different tenant', async () => {
      const gate = new CodexApprovalGate({ timeoutMs: 5_000 });
      const session = makeSession(planFor(), gate);
      const tenant = session.tenantKey();

      const turn = session.runTurn({ prompt: 'x', ctx: turnCtx() });
      const approvalId = await waitFor(() => gate.list(tenant)[0]?.id);

      expect(gate.resolve('someone_else', approvalId, 'accept')).toBe(false);
      expect(gate.list('someone_else')).toHaveLength(0);

      gate.resolve(tenant, approvalId, 'decline');
      await turn;
    });
  });

  describe('transport failure', () => {
    it('fails the in-flight turn and reconnects on the next one', async () => {
      process.env.FAKE_CODEX_EXIT_ON_TURN = '1';
      const session = makeSession(planFor());

      await expect(
        session.runTurn({ prompt: 'crash', ctx: turnCtx() }),
      ).rejects.toThrow();
      expect(session.snapshot().status).toBe('error');

      delete process.env.FAKE_CODEX_EXIT_ON_TURN;
      const result = await session.runTurn({
        prompt: 'recovered',
        ctx: turnCtx(),
      });

      expect(result.text).toBe('handled: recovered');
      expect(
        session.history().some((entry) => entry.reason === 'reconnect_attempt'),
      ).toBe(true);
    });

    it('stops reconnecting once the attempt budget is spent', async () => {
      process.env.FAKE_CODEX_EXIT_ON_TURN = '1';
      try {
        const session = makeSession(
          planFor({ CODEX_MAX_RECONNECT_ATTEMPTS: '1' }),
        );

        await expect(
          session.runTurn({ prompt: 'a', ctx: turnCtx() }),
        ).rejects.toThrow();
        await expect(
          session.runTurn({ prompt: 'b', ctx: turnCtx() }),
        ).rejects.toThrow();
        await expect(
          session.runTurn({ prompt: 'c', ctx: turnCtx() }),
        ).rejects.toThrow(/reconnect attempts/u);
      } finally {
        delete process.env.FAKE_CODEX_EXIT_ON_TURN;
      }
    });
  });

  it('switching auth mode disconnects and is recorded', async () => {
    const session = makeSession(planFor());
    await session.runTurn({ prompt: 'x', ctx: turnCtx() });

    await session.setAuthMode('chatgpt_subscription');

    expect(session.snapshot().status).toBe('disconnected');
    expect(session.snapshot().authMode).toBe('chatgpt_subscription');
    expect(session.currentThreadId()).toBeNull();
    expect(
      session.history().some((entry) => entry.reason === 'auth_mode_changed'),
    ).toBe(true);
  });
});

/** Poll until `read` returns a value. Approvals arrive asynchronously. */
async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for value');
    await new Promise((r) => setTimeout(r, 10));
  }
}
