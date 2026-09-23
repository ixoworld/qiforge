import { AsyncLocalStorage } from 'node:async_hooks';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { RunnableLambda } from '@langchain/core/runnables';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import {
  DecisionProviderUnavailableError,
  DecisionRuntime,
  UNAVAILABLE_DECISION_EVALUATOR,
  type DecisionLookup,
} from './runtime.js';
import type { DecisionAdapter } from './types.js';

const decision = defineDecision({
  name: 'test.boolean',
  version: '1.0.0',
  description: 'A test bounded boolean decision.',
  inputSchema: z.object({ text: z.string() }),
  project: ({ text }) => ({
    state: { text },
    questions: {
      yes: {
        kind: 'boolean',
        instructions: 'Is this a yes?',
      },
    },
  }),
});

const routeDecision = defineDecision({
  name: 'test.route',
  version: '1.0.0',
  description: 'A test bounded choice decision.',
  inputSchema: z.object({ text: z.string() }),
  project: ({ text }) => ({
    state: { text },
    questions: {
      service: {
        kind: 'choice',
        instructions: 'Which service?',
        options: { tax: 'Tax preparation', none: 'No matching service' },
      },
    },
  }),
});

const lookup: DecisionLookup = {
  get: (name) => (name === decision.name ? { decision } : undefined),
};

function stubAdapter(evaluate: DecisionAdapter['evaluate']): DecisionAdapter {
  return { provider: 'test-provider', model: 'test-model', evaluate };
}

describe('DecisionRuntime', () => {
  it('evaluates a registered decision and preserves provenance', async () => {
    const adapter = stubAdapter(async () => ({
      answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
      modelVersion: 'v1',
      usage: { inputTokens: 12 },
    }));
    const runtime = new DecisionRuntime(lookup, adapter);

    const result = await runtime.evaluateByName('test.boolean', {
      text: 'yes',
    });

    expect(result.decision).toEqual({ name: 'test.boolean', version: '1.0.0' });
    expect(result.provider).toBe('test-provider');
    expect(result.model).toBe('test-model');
    expect(result.modelVersion).toBe('v1');
    expect(result.usage).toEqual({ inputTokens: 12 });
    expect(result.answers.yes).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.8,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.evaluatedAt))).toBe(false);
  });

  it('returns input preparation failures as promise rejections', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
      })),
    );

    const rejection = runtime.evaluateByName('test.boolean', { text: 123 });

    expect(rejection).toBeInstanceOf(Promise);
    await expect(rejection).rejects.toThrow();
  });

  it('rejects unknown decision names and a missing lookup', async () => {
    const adapter = stubAdapter(async () => ({ answers: {} }));

    await expect(
      new DecisionRuntime(lookup, adapter).evaluateByName('missing', {}),
    ).rejects.toThrow(/"missing" is not registered/);
    await expect(
      new DecisionRuntime(undefined, adapter).evaluateByName('test.boolean', {
        text: 'yes',
      }),
    ).rejects.toThrow(/No DecisionRegistry/);
  });

  it('fails when no decision adapter is configured', async () => {
    const runtime = new DecisionRuntime(lookup);

    await expect(
      runtime.evaluate(decision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });

  it('rejects provider output outside the declared answer contract', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 1.5 } },
      })),
    );

    await expect(runtime.evaluate(decision, { text: 'yes' })).rejects.toThrow(
      /0 to 1/,
    );
  });

  it('returns the normalized provider result', async () => {
    const runtime = new DecisionRuntime(
      undefined,
      stubAdapter(async () => ({
        answers: {
          service: {
            kind: 'choice',
            value: 'tax',
            confidence: 0.9,
            probabilities: { tax: 1 },
          },
        },
      })),
    );

    const result = await runtime.evaluate(routeDecision, { text: 'taxes' });

    expect(result.answers.service).toEqual({
      kind: 'choice',
      value: 'tax',
      confidence: 0.9,
      probabilities: { tax: 1, none: 0 },
    });
  });

  it('aborts the adapter and rejects when the timeout elapses', async () => {
    let adapterSignal: AbortSignal | undefined;
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(
        (_request, options) =>
          new Promise(() => {
            adapterSignal = options?.signal;
          }),
      ),
    );

    await expect(
      runtime.evaluate(decision, { text: 'yes' }, { timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
    expect(adapterSignal?.aborted).toBe(true);
  });

  it('forwards caller aborts to the adapter signal', async () => {
    const controller = new AbortController();
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async (_request, options) => {
        controller.abort(new Error('caller cancelled'));
        if (options?.signal?.aborted) throw options.signal.reason;
        return {
          answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
        };
      }),
    );

    await expect(
      runtime.evaluate(
        decision,
        { text: 'yes' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/caller cancelled/);
  });
});

interface RecordedRun {
  runId: string;
  parentRunId?: string;
  runName?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Records chain runs synchronously so assertions see them after `invoke`. */
class RecordingHandler extends BaseCallbackHandler {
  name = 'recording-handler';
  awaitHandlers = true;
  readonly runs: RecordedRun[] = [];

  // The callback manager calls this as (chain, inputs, runId, parentRunId,
  // tags, metadata, runType, runName), which is not the parameter order
  // `BaseCallbackHandler` declares, so the arguments are read by position
  // and narrowed at runtime.
  override handleChainStart(...args: unknown[]): void {
    const [, inputs, runId, parentRunId, tags, metadata, , runName] = args;
    if (typeof runId !== 'string' || !isRecord(inputs)) return;
    this.runs.push({
      runId,
      inputs,
      ...(typeof parentRunId === 'string' && { parentRunId }),
      ...(typeof runName === 'string' && { runName }),
      ...(Array.isArray(tags) && {
        tags: tags.filter((tag): tag is string => typeof tag === 'string'),
      }),
      ...(isRecord(metadata) && { metadata }),
    });
  }

  override handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string,
  ): void {
    const run = this.runs.find((entry) => entry.runId === runId);
    if (run) run.outputs = outputs;
  }

  override handleChainError(error: Error, runId: string): void {
    const run = this.runs.find((entry) => entry.runId === runId);
    if (run) run.error = error;
  }

  decisionRuns(): RecordedRun[] {
    return this.runs.filter((run) => run.runName?.startsWith('decision:'));
  }
}

describe('DecisionRuntime tracing', () => {
  const answering = stubAdapter(async () => ({
    answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
  }));

  it('records the evaluation as a decision span on the given callbacks', async () => {
    const handler = new RecordingHandler();
    const runtime = new DecisionRuntime(lookup, answering);

    const evaluation = await runtime.evaluate(
      decision,
      { text: 'yes' },
      { callbacks: [handler], metadata: { user_did: 'did:test:user' } },
    );

    const [span] = handler.decisionRuns();
    expect(handler.decisionRuns()).toHaveLength(1);
    expect(span?.runName).toBe('decision:test.boolean');
    expect(span?.tags).toContain('decision');
    expect(span?.metadata).toMatchObject({
      user_did: 'did:test:user',
      decision_name: 'test.boolean',
      decision_version: '1.0.0',
      decision_provider: 'test-provider',
      decision_model: 'test-model',
    });
    expect(span?.inputs).toMatchObject({
      decision: 'test.boolean',
      state: { text: 'yes' },
    });
    expect(span?.outputs).toMatchObject({
      provider: 'test-provider',
      answers: evaluation.answers,
    });
  });

  it('records a failure on the span and rethrows the original error', async () => {
    class ProviderDown extends Error {
      override name = 'ProviderDown';
    }
    const failure = new ProviderDown('provider down');
    const handler = new RecordingHandler();
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => {
        throw failure;
      }),
    );

    await expect(
      runtime.evaluate(decision, { text: 'yes' }, { callbacks: [handler] }),
    ).rejects.toBe(failure);
    expect(handler.decisionRuns()[0]?.error).toBe(failure);
  });

  it('nests under the surrounding LangChain run without explicit callbacks', async () => {
    AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
      new AsyncLocalStorage(),
    );
    const handler = new RecordingHandler();
    const runtime = new DecisionRuntime(lookup, answering);
    const parent = RunnableLambda.from(async (text: string) =>
      runtime.evaluate(decision, { text }),
    ).withConfig({ runName: 'tool-call' });

    await parent.invoke('yes', { callbacks: [handler] });

    const parentRun = handler.runs.find((run) => run.runName === 'tool-call');
    const [span] = handler.decisionRuns();
    expect(parentRun).toBeDefined();
    expect(span?.parentRunId).toBe(parentRun?.runId);
  });

  it('runs untraced when no callbacks are given', async () => {
    const runtime = new DecisionRuntime(lookup, answering);
    await expect(
      runtime.evaluate(decision, { text: 'yes' }),
    ).resolves.toMatchObject({ provider: 'test-provider' });
  });
});

describe('UNAVAILABLE_DECISION_EVALUATOR', () => {
  it('rejects every call with DecisionProviderUnavailableError', async () => {
    await expect(
      UNAVAILABLE_DECISION_EVALUATOR.evaluate(decision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
    await expect(
      UNAVAILABLE_DECISION_EVALUATOR.evaluateByName('test.boolean', {}),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });
});
