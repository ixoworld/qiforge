import { AIMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  DecisionProviderUnavailableError,
  type DecisionEvaluation,
  type DecisionEvaluator,
} from '@ixo/common/ai/decisions';
import { describe, expect, it } from 'vitest';
import {
  attachModelCall,
  MODEL_CALL_METADATA_KEY,
  turnModelUsageTotals,
  type ModelCallPayer,
  type ModelCallRecord,
  type ModelCallReport,
} from '../llm/model-call';
import { budgetedLlm } from './budgeted-llm';
import {
  ModelCallReporter,
  purposeOfRun,
  reportingDecisions,
  reportingLlm,
  TurnModelCalls,
  withModelCallPurpose,
} from './model-call-reporter';
import { buildRuntimeContext, createNoopAmbient } from './runtime-context';
import { makeRunConfig } from './test-fixtures';
import { TurnBudget } from './turn-budget';
import type { LlmAdapter } from './runtime-context';

function record(
  overrides: Partial<ModelCallRecord> = {},
  paidBy: ModelCallPayer = 'platform',
): ModelCallRecord {
  return {
    role: 'main',
    paidBy,
    requestedModel: 'openai/gpt-5.6-luna',
    fallback: false,
    modelFallback: false,
    providerFallback: false,
    promptTokens: 100,
    outputTokens: 10,
    costUsd: 0.001,
    durationMs: 20,
    ok: true,
    ...overrides,
  };
}

/** A model that keeps a call record like the platform and BYO models do. */
class RecordingModel extends FakeListChatModel {
  constructor(
    private readonly kept: ModelCallRecord,
    private readonly fail = false,
  ) {
    super({ responses: ['ok'] });
  }

  override async _generate(): Promise<ChatResult> {
    if (this.fail) {
      const error = new Error('502 upstream');
      attachModelCall(error, { ...this.kept, ok: false, errorKind: 'server' });
      throw error;
    }
    return {
      generations: [
        {
          text: 'ok',
          message: new AIMessage({
            content: 'ok',
            response_metadata: { [MODEL_CALL_METADATA_KEY]: this.kept },
          }),
        },
      ],
    };
  }
}

/** A fresh recording model per `get`, like the real adapters. */
function adapter(kept = record(), fail = false): LlmAdapter {
  return { get: () => new RecordingModel(kept, fail) };
}

function metered(reports: ModelCallReport[], kept = record(), fail = false) {
  return budgetedLlm(adapter(kept, fail), {
    budget: new TurnBudget({ tools: 10, durationMs: 60_000 }, () => 0),
    outputReserveTokens: 100,
    onModelCall: (call) => reports.push(call),
  });
}

describe('model-call reports', () => {
  it('names the purpose from the run metadata: stamp first, then the role', () => {
    expect(purposeOfRun({ oracle_model_purpose: 'title' })).toBe('title');
    expect(purposeOfRun({ oracle_model_purpose: 'nonsense' })).toBe('other');
    expect(purposeOfRun({ lc_source: 'summarization' })).toBe('summarization');
    expect(purposeOfRun({ oracle_model_role: 'main' })).toBe('reply');
    expect(purposeOfRun({ oracle_model_role: 'summarizer' })).toBe(
      'summarization',
    );
    expect(purposeOfRun({ oracle_model_role: 'vision' })).toBe('other');
    expect(purposeOfRun(undefined)).toBe('other');
    expect(withModelCallPurpose({ metadata: { a: 1 } }, 'subagent')).toEqual({
      metadata: { a: 1, oracle_model_purpose: 'subagent' },
    });
  });

  it('reports each call of the turn adapter once, with purpose, id and start', async () => {
    const reports: ModelCallReport[] = [];
    const llm = metered(reports);
    const before = Date.now();
    await llm.get('main').invoke('hi');
    await llm.get('summarizer').invoke('hi');
    await llm
      .get('subagent', withModelCallPurpose(undefined, 'subagent'))
      .invoke('hi');
    // A plugin's own model, through its runtime context.
    const ctx = buildRuntimeContext(
      makeRunConfig(),
      createNoopAmbient({ llm }),
      { messages: [] },
    );
    await ctx.llm.get('main').invoke('hi');
    expect(reports.map((r) => r.purpose)).toEqual([
      'reply',
      'summarization',
      'subagent',
      'plugin',
    ]);
    expect(new Set(reports.map((r) => r.callId)).size).toBe(4);
    for (const report of reports) {
      expect(report.startedAt).toBeGreaterThanOrEqual(before);
      expect(report).toMatchObject({ paidBy: 'platform', costUsd: 0.001 });
    }
  });

  it('reports a call once even when the handler sees it twice (model and run config)', async () => {
    const reports: ModelCallReport[] = [];
    const llm = metered(reports);
    await llm.get('main').invoke('hi', { callbacks: [llm.callback] });
    expect(reports).toHaveLength(1);
  });

  it('reports a failed call once, from its error', async () => {
    const reports: ModelCallReport[] = [];
    const llm = metered(reports, record(), true);
    await expect(llm.get('main').invoke('hi')).rejects.toThrow('502');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      ok: false,
      errorKind: 'server',
      purpose: 'reply',
    });
  });

  it('keeps who paid: a BYO call reports paidBy user', async () => {
    const reports: ModelCallReport[] = [];
    const llm = metered(reports, record({ costUsd: undefined }, 'user'));
    await llm.get('main').invoke('hi');
    expect(reports[0]?.paidBy).toBe('user');
  });

  it('reports concurrent calls of one turn each once', async () => {
    const reports: ModelCallReport[] = [];
    const llm = metered(reports);
    await Promise.all(
      Array.from({ length: 8 }, () => llm.get('main').invoke('hi')),
    );
    expect(reports).toHaveLength(8);
    expect(new Set(reports.map((r) => r.callId)).size).toBe(8);
  });

  it('reports calls made outside a turn under the purpose given', async () => {
    const reports: ModelCallReport[] = [];
    const reporter = new ModelCallReporter((c) => reports.push(c), {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const llm = reportingLlm(adapter(), reporter, 'title');
    await llm.get('session-title').invoke('hi', { callbacks: [reporter] });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.purpose).toBe('title');
  });

  it('never lets a throwing sink fail the call', async () => {
    const reporter = new ModelCallReporter(
      () => {
        throw new Error('sink down');
      },
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );
    const llm = reportingLlm(adapter(), reporter, 'group-summary');
    await expect(llm.get('session-title').invoke('hi')).resolves.toBeDefined();
  });
});

describe('Decision reports', () => {
  function evaluatorOf(
    answer: () => Promise<DecisionEvaluation>,
  ): DecisionEvaluator {
    return { evaluate: answer, evaluateByName: answer };
  }

  const evaluation: DecisionEvaluation = {
    decision: { name: 'test-decision', version: '1' },
    provider: 'openrouter',
    model: 'openai/gpt-5.4-nano',
    answers: {},
    latencyMs: 120,
    usage: { inputTokens: 300, outputTokens: 4 },
    evaluatedAt: new Date().toISOString(),
  };

  it('reports an evaluation: provider, model, tokens, latency; no cost', async () => {
    const reports: ModelCallReport[] = [];
    const wrapped = reportingDecisions(
      evaluatorOf(async () => evaluation),
      (call) => reports.push(call),
      () => 'routing',
    );
    await expect(
      wrapped.evaluateByName('test-decision', { text: 'x' }),
    ).resolves.toBe(evaluation);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      role: 'decision',
      purpose: 'routing',
      paidBy: 'platform',
      provider: 'openrouter',
      requestedModel: 'openai/gpt-5.4-nano',
      promptTokens: 300,
      outputTokens: 4,
      durationMs: 120,
      ok: true,
    });
    expect(reports[0]?.costUsd).toBeUndefined();
  });

  it('reports a failed evaluation, but not one no provider could take', async () => {
    const reports: ModelCallReport[] = [];
    const failing = reportingDecisions(
      evaluatorOf(async () => {
        throw new Error('Decision timed out after 3000ms');
      }),
      (call) => reports.push(call),
    );
    await expect(failing.evaluateByName('x', {})).rejects.toThrow('timed out');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: false, purpose: 'decision' });
    const unavailable = reportingDecisions(
      evaluatorOf(async () => {
        throw new DecisionProviderUnavailableError();
      }),
      (call) => reports.push(call),
    );
    await expect(unavailable.evaluateByName('x', {})).rejects.toThrow();
    expect(reports).toHaveLength(1);
  });

  it('hands the call options to the sink (the router passes its request id)', async () => {
    const seen: unknown[] = [];
    const wrapped = reportingDecisions(
      evaluatorOf(async () => evaluation),
      (_call, options) => seen.push(options?.metadata?.request_id),
    );
    await wrapped.evaluateByName(
      'test-decision',
      { text: 'x' },
      { metadata: { request_id: 'req-9' } },
    );
    expect(seen).toEqual(['req-9']);
  });
});

describe('turn usage', () => {
  it('waits for tracked deliveries before it answers', async () => {
    const calls = new TurnModelCalls();
    let release!: () => void;
    calls.track(
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() =>
        calls.add({ ...record(), purpose: 'title', callId: 't', startedAt: 0 }),
      ),
    );
    const settled = calls.settled(5_000);
    release();
    expect(await settled).toEqual({
      calls: [expect.objectContaining({ callId: 't' })],
      timedOut: false,
    });
  });

  it('gives up on a hung delivery after its limit', async () => {
    const calls = new TurnModelCalls();
    calls.track(new Promise(() => undefined));
    expect(await calls.settled(20)).toEqual({ calls: [], timedOut: true });
  });

  it('totals the platform cost and counts unpriced platform calls; user calls are not totalled', () => {
    const report = (
      paidBy: ModelCallPayer,
      costUsd?: number,
    ): ModelCallReport => ({
      ...record({ costUsd }, paidBy),
      purpose: 'reply',
      callId: crypto.randomUUID(),
      startedAt: 0,
    });
    expect(
      turnModelUsageTotals([
        report('platform', 0.002),
        report('platform', 0.003),
        report('platform'),
        report('user', 5),
      ]),
    ).toEqual({ platformCostUsd: 0.005, unpricedPlatformCalls: 1 });
  });
});
