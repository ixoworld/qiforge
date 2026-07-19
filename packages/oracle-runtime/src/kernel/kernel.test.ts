import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../registries/test-fixtures.js';
import type { AuditRecord } from './audit.js';
import {
  BudgetExceededError,
  createTurnBudgetTracker,
  resolveTurnBudget,
} from './budget.js';
import {
  attenuateRuntimeContext,
  PermissionDeniedError,
} from './context-guard.js';
import {
  createInProcessExecutionBroker,
  ToolTimeoutError,
} from './execution-broker.js';

const LOGGER = {
  log: () => undefined,
  warn: vi.fn(),
  error: () => undefined,
};

const TENANT = {
  sessionId: 'sess-1',
  requestId: 'req-1',
  userDid: 'did:ixo:user1',
};

describe('attenuateRuntimeContext', () => {
  it('denies every undeclared surface with an error naming the missing grant', async () => {
    const ctx = makeRuntimeContext();
    const guarded = attenuateRuntimeContext(ctx, {
      pluginName: 'weather',
      permissions: undefined,
      enforcement: 'enforce',
      logger: LOGGER,
    });

    expect(() => guarded.llm.get('subagent')).toThrow(PermissionDeniedError);
    expect(() => guarded.llm.get('subagent')).toThrow(/llm: true/);
    expect(() => guarded.matrix.postToRoom('!r', {})).toThrow(
      /matrix: \['write'\]/,
    );
    expect(() => guarded.secrets.getIndex()).toThrow(/secrets: true/);
    expect(() =>
      guarded.ucan.mintInvocation('did:x', { did: 'd', capability: 'c' }),
    ).toThrow(/ucan: \{ invoke: true \}/);
  });

  it('keeps self-signed oracle authority denied even under a full invoke grant', async () => {
    const ctx = makeRuntimeContext();
    const guarded = attenuateRuntimeContext(ctx, {
      pluginName: 'memory',
      permissions: { ucan: { invoke: true } },
      enforcement: 'enforce',
      logger: LOGGER,
    });

    // invoke-granted surfaces pass through…
    await expect(
      guarded.ucan.resolveServiceDid('https://svc.test'),
    ).resolves.toBeDefined();
    // …but acting AS the oracle needs its own grant, which no bundled
    // plugin declares.
    expect(() =>
      guarded.ucan.mintSelfSignedInvocation('https://svc.test', {
        can: 'x',
        with: 'y',
      }),
    ).toThrow(/selfSign/);
  });

  it('passes declared surfaces through unchanged', async () => {
    const ctx = makeRuntimeContext();
    const guarded = attenuateRuntimeContext(ctx, {
      pluginName: 'editor',
      permissions: { secrets: true, blobStore: true, llm: true },
      enforcement: 'enforce',
      logger: LOGGER,
    });

    await expect(guarded.secrets.getIndex()).resolves.toEqual({});
    await expect(
      guarded.blobStore.put({ userDid: 'd', name: 'n', value: 'v' }),
    ).resolves.toMatch(/^blob_/);
  });

  it('warn mode logs once per surface and allows the call', async () => {
    const warnLogger = { ...LOGGER, warn: vi.fn() };
    const ctx = makeRuntimeContext();
    const guarded = attenuateRuntimeContext(ctx, {
      pluginName: 'legacy',
      permissions: undefined,
      enforcement: 'warn',
      logger: warnLogger,
    });

    await expect(guarded.secrets.getIndex()).resolves.toEqual({});
    await expect(guarded.secrets.getIndex()).resolves.toEqual({});
    const warnings = warnLogger.warn.mock.calls.filter(([msg]) =>
      String(msg).includes('secrets.getIndex'),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('turn budget tracker', () => {
  it('caps tool and model calls at the configured ceilings', () => {
    const tracker = createTurnBudgetTracker(
      resolveTurnBudget({ maxToolCalls: 2, maxModelCalls: 1 }),
    );

    tracker.beforeToolCall();
    tracker.beforeToolCall();
    expect(() => tracker.beforeToolCall()).toThrow(BudgetExceededError);

    tracker.beforeModelCall();
    expect(() => tracker.beforeModelCall()).toThrow(BudgetExceededError);
  });

  it('enforces the wall-clock ceiling', () => {
    let nowMs = 0;
    const tracker = createTurnBudgetTracker(
      resolveTurnBudget({ wallMs: 1000 }),
      () => nowMs,
    );

    tracker.beforeToolCall();
    nowMs = 1500;
    expect(() => tracker.beforeToolCall()).toThrow(/wallMs/);
  });

  it('rejects oversized tool output', () => {
    const tracker = createTurnBudgetTracker(
      resolveTurnBudget({ maxOutputBytes: 10 }),
    );
    expect(() => tracker.checkOutputSize(11)).toThrow(/maxOutputBytes/);
    expect(() => tracker.checkOutputSize(10)).not.toThrow();
  });
});

describe('in-process execution broker', () => {
  it('runs the handler, audits the allow, and returns its result', async () => {
    const audits: AuditRecord[] = [];
    const broker = createInProcessExecutionBroker({
      tracker: createTurnBudgetTracker(resolveTurnBudget()),
      audit: { append: (record) => void audits.push(record) },
      logger: LOGGER,
    });

    const result = await broker.execute({
      pluginName: 'weather',
      toolName: 'get_weather',
      tenant: TENANT,
      run: async () => 'sunny',
    });

    expect(result).toBe('sunny');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audits.map((a) => a.kind)).toEqual(['tool.allow']);
    expect(audits[0]?.detail.tool).toBe('get_weather');
    // Digest, never the raw DID.
    expect(JSON.stringify(audits[0])).not.toContain(TENANT.userDid);
  });

  it('times out a hung handler and audits the denial', async () => {
    const audits: AuditRecord[] = [];
    const broker = createInProcessExecutionBroker({
      tracker: createTurnBudgetTracker(resolveTurnBudget()),
      audit: { append: (record) => void audits.push(record) },
      logger: LOGGER,
    });

    await expect(
      broker.execute({
        pluginName: 'slowpoke',
        toolName: 'hang',
        tenant: TENANT,
        timeoutMs: 20,
        run: () => new Promise(() => undefined),
      }),
    ).rejects.toThrow(ToolTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audits.at(-1)?.kind).toBe('tool.deny');
    expect(audits.at(-1)?.detail.reason).toBe('timeout');
  });

  it('denies past the tool-call ceiling and audits the budget breach', async () => {
    const audits: AuditRecord[] = [];
    const broker = createInProcessExecutionBroker({
      tracker: createTurnBudgetTracker(resolveTurnBudget({ maxToolCalls: 1 })),
      audit: { append: (record) => void audits.push(record) },
      logger: LOGGER,
    });

    await broker.execute({
      pluginName: 'p',
      toolName: 'once',
      tenant: TENANT,
      run: async () => 'ok',
    });
    await expect(
      broker.execute({
        pluginName: 'p',
        toolName: 'twice',
        tenant: TENANT,
        run: async () => 'ok',
      }),
    ).rejects.toThrow(BudgetExceededError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audits.at(-1)?.kind).toBe('tool.deny');
    expect(audits.at(-1)?.detail.reason).toBe('budget');
  });
});
