import { AsyncLocalStorage } from 'node:async_hooks';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { RunnableLambda } from '@langchain/core/runnables';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import {
  AmbiguousDecisionProviderError,
  DecisionProviderNotFoundError,
  DecisionProviderRegistry,
  DecisionProviderRouter,
  HOST_DECISION_PROVIDER_ID,
} from './provider-router.js';
import {
  DecisionNotApplicableError,
  DecisionProviderUnavailableError,
  DecisionRuntime,
  UNAVAILABLE_DECISION_EVALUATOR,
  type DecisionLookup,
} from './runtime.js';
import type {
  DecisionAdapter,
  DecisionApplicability,
  DecisionRequest,
} from './types.js';

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

/** Same question as `decision` under a name no provider route mentions. */
const routeDecisionYes = defineDecision({
  name: 'test.unrouted',
  version: '1.0.0',
  description: 'An unrouted bounded boolean decision.',
  inputSchema: z.object({ text: z.string() }),
  project: ({ text }) => ({
    state: { text },
    questions: {
      yes: { kind: 'boolean', instructions: 'Is this a yes?' },
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

  it('records a bare adapter as the default host provider', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
      })),
    );

    const result = await runtime.evaluate(decision, { text: 'yes' });

    expect(HOST_DECISION_PROVIDER_ID).toBe('host');
    expect(result.providerId).toBe(HOST_DECISION_PROVIDER_ID);
    expect(result.providerSelection).toBe('default');
  });
});

describe('DecisionRuntime provider routing', () => {
  function answeringAdapter(provider: string, probabilityTrue: number) {
    const calls: DecisionRequest[] = [];
    const adapter: DecisionAdapter = {
      provider,
      model: `${provider}-model`,
      async evaluate(request) {
        calls.push(request);
        return { answers: { yes: { kind: 'boolean', probabilityTrue } } };
      },
    };
    return { adapter, calls };
  }

  it('routes by Decision name, falls back to the default and honours a caller override', async () => {
    const fallback = answeringAdapter('default', 0.2);
    const routed = answeringAdapter('routed', 0.8);
    const override = answeringAdapter('override', 0.95);
    const runtime = new DecisionRuntime(
      lookup,
      new DecisionProviderRouter(
        new DecisionProviderRegistry([
          { id: 'default-provider', adapter: fallback.adapter },
          { id: 'routed-provider', adapter: routed.adapter },
          { id: 'override-provider', adapter: override.adapter },
        ]),
        {
          defaultProviderId: 'default-provider',
          routes: { 'test.boolean': 'routed-provider' },
        },
      ),
    );

    const viaRoute = await runtime.evaluateByName('test.boolean', {
      text: 'yes',
    });
    expect(viaRoute).toMatchObject({
      providerId: 'routed-provider',
      providerSelection: 'decision-route',
      provider: 'routed',
      model: 'routed-model',
      answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
    });

    const viaDefault = await runtime.evaluate(routeDecisionYes, {
      text: 'yes',
    });
    expect(viaDefault).toMatchObject({
      providerId: 'default-provider',
      providerSelection: 'default',
      provider: 'default',
    });

    const viaOverride = await runtime.evaluateByName(
      'test.boolean',
      { text: 'yes' },
      { providerId: 'override-provider' },
    );
    expect(viaOverride).toMatchObject({
      providerId: 'override-provider',
      providerSelection: 'caller-override',
      answers: { yes: { kind: 'boolean', probabilityTrue: 0.95 } },
    });

    expect(routed.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    expect(override.calls).toHaveLength(1);
  });

  it('refuses an ambiguous configuration without calling any provider', async () => {
    const a = answeringAdapter('a', 0.5);
    const b = answeringAdapter('b', 0.5);
    const runtime = new DecisionRuntime(
      lookup,
      new DecisionProviderRouter(
        new DecisionProviderRegistry([
          { id: 'a', adapter: a.adapter },
          { id: 'b', adapter: b.adapter },
        ]),
      ),
    );

    await expect(
      runtime.evaluate(decision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(AmbiguousDecisionProviderError);
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });

  it('does not fall back to another provider when the selected one fails', async () => {
    const healthy = answeringAdapter('healthy', 0.9);
    const failing: DecisionAdapter = {
      provider: 'failing',
      model: 'failing-model',
      async evaluate() {
        throw new Error('provider down');
      },
    };
    const runtime = new DecisionRuntime(
      lookup,
      new DecisionProviderRouter(
        new DecisionProviderRegistry([
          { id: 'failing', adapter: failing },
          { id: 'healthy', adapter: healthy.adapter },
        ]),
        { defaultProviderId: 'failing' },
      ),
    );

    await expect(runtime.evaluate(decision, { text: 'yes' })).rejects.toThrow(
      /provider down/,
    );
    expect(healthy.calls).toHaveLength(0);
  });

  it('rejects an unknown caller override', async () => {
    const only = answeringAdapter('only', 0.9);
    const runtime = new DecisionRuntime(
      lookup,
      new DecisionProviderRouter(
        new DecisionProviderRegistry([{ id: 'only', adapter: only.adapter }]),
      ),
    );

    await expect(
      runtime.evaluate(decision, { text: 'yes' }, { providerId: 'other' }),
    ).rejects.toBeInstanceOf(DecisionProviderNotFoundError);
    expect(only.calls).toHaveLength(0);
  });

  it('fails as unavailable over an empty router', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      new DecisionProviderRouter(new DecisionProviderRegistry()),
    );

    await expect(
      runtime.evaluate(decision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });
});

describe('DecisionRuntime applicability', () => {
  const projectWith = (applicability: DecisionApplicability | undefined) =>
    defineDecision({
      name: 'test.applicability',
      version: '2.1.0',
      description: 'A decision whose evidence may be unavailable.',
      inputSchema: z.object({ text: z.string() }),
      project: ({ text }) => ({
        state: { text },
        ...(applicability ? { applicability } : {}),
        questions: {
          yes: { kind: 'boolean', instructions: 'Is this a yes?' },
        },
      }),
    });

  it('refuses before provider invocation when evidence is incomplete', async () => {
    const evaluate = vi.fn<DecisionAdapter['evaluate']>(async () => ({
      answers: { yes: { kind: 'boolean', probabilityTrue: 0.1 } },
    }));
    const runtime = new DecisionRuntime(undefined, stubAdapter(evaluate));
    const applicability = {
      applicable: true,
      evidenceComplete: false,
      reason: 'Encrypted delegated task is unavailable.',
    };

    const rejection = runtime.evaluate(projectWith(applicability), {
      text: 'yes',
    });

    await expect(rejection).rejects.toBeInstanceOf(DecisionNotApplicableError);
    await expect(rejection).rejects.toMatchObject({ applicability });
    await expect(rejection).rejects.toThrow(/Encrypted delegated task/);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('refuses an inapplicable Decision even when no provider is configured', async () => {
    const runtime = new DecisionRuntime();

    await expect(
      runtime.evaluate(
        projectWith({ applicable: false, evidenceComplete: true }),
        { text: 'yes' },
      ),
    ).rejects.toThrow(/not applicable to the projected state/);
  });

  it('records declared applicability, and full applicability when omitted', async () => {
    const runtime = new DecisionRuntime(
      undefined,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 0.7 } },
      })),
    );

    const declared = await runtime.evaluate(
      projectWith({
        applicable: true,
        evidenceComplete: true,
        reason: 'Message text is fully observable.',
      }),
      { text: 'yes' },
    );
    const omitted = await runtime.evaluate(projectWith(undefined), {
      text: 'yes',
    });

    expect(declared.applicability).toEqual({
      applicable: true,
      evidenceComplete: true,
      reason: 'Message text is fully observable.',
    });
    expect(omitted.applicability).toEqual({
      applicable: true,
      evidenceComplete: true,
    });
  });
});

describe('DecisionRuntime judgment provenance', () => {
  it('records adapter method and calibration with the question-set version', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
        provenance: {
          method: {
            kind: 'specialized',
            name: 'test-head',
            artifactRef: 'artifact:head-v1',
          },
          calibration: {
            method: 'temperature-scaling',
            artifactRef: 'artifact:cal-v1',
            workload: 'test.boolean',
            version: '1',
            evaluatedAt: '2026-09-24T00:00:00.000Z',
            ece: 0.03,
            brier: 0.11,
          },
        },
      })),
    );

    const result = await runtime.evaluateByName('test.boolean', {
      text: 'yes',
    });

    expect(result.judgment).toEqual({
      method: {
        kind: 'specialized',
        name: 'test-head',
        artifactRef: 'artifact:head-v1',
      },
      calibration: {
        method: 'temperature-scaling',
        artifactRef: 'artifact:cal-v1',
        workload: 'test.boolean',
        version: '1',
        evaluatedAt: '2026-09-24T00:00:00.000Z',
        ece: 0.03,
        brier: 0.11,
      },
      questionSetVersion: '1.0.0',
    });
  });

  it('records provider-native without a calibration claim when the adapter declares nothing', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
      })),
    );

    const result = await runtime.evaluate(decision, { text: 'yes' });

    expect(result.judgment).toEqual({
      method: { kind: 'provider-native' },
      questionSetVersion: '1.0.0',
    });
  });

  it('rejects malformed adapter provenance like any other malformed output', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
        provenance: {
          method: { kind: 'calibrated' },
          calibration: { method: 'isotonic', ece: -0.1 },
        },
      })),
    );

    await expect(runtime.evaluate(decision, { text: 'yes' })).rejects.toThrow(
      /calibration ece/,
    );
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
      decision_provider_id: 'host',
      decision_provider_selection: 'default',
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

describe('decision timeouts', () => {
  const invalid = [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31];
  const answer = async () => ({
    answers: { yes: { kind: 'boolean' as const, probabilityTrue: 0.8 } },
  });

  it('defineDecision refuses a timeout that is not an integer in 1..2^31-1', () => {
    for (const timeoutMs of invalid) {
      expect(() =>
        defineDecision({
          name: 'test.timeout',
          version: '1.0.0',
          description: 'Timeout validation.',
          inputSchema: z.object({}),
          timeoutMs,
          project: () => ({
            state: {},
            questions: { yes: { kind: 'boolean', instructions: 'Yes?' } },
          }),
        }),
      ).toThrow(RangeError);
    }
  });

  it('defineDecision accepts the bounds 1 and 2^31-1', () => {
    for (const timeoutMs of [1, 2 ** 31 - 1]) {
      const defined = defineDecision({
        name: 'test.timeout',
        version: '1.0.0',
        description: 'Timeout validation.',
        inputSchema: z.object({}),
        timeoutMs,
        project: () => ({
          state: {},
          questions: { yes: { kind: 'boolean', instructions: 'Yes?' } },
        }),
      });
      expect(defined.timeoutMs).toBe(timeoutMs);
    }
  });

  it('evaluate refuses an invalid per-call timeout without calling the adapter', async () => {
    let calls = 0;
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => {
        calls += 1;
        return answer();
      }),
    );

    for (const timeoutMs of invalid) {
      await expect(
        runtime.evaluate(decision, { text: 'yes' }, { timeoutMs }),
      ).rejects.toThrow(RangeError);
    }
    expect(calls).toBe(0);
  });

  it('evaluateByName refuses a hand-written registration with an invalid timeout', async () => {
    const runtime = new DecisionRuntime(
      {
        get: () => ({
          decision: {
            name: 'test.handwritten',
            version: '1.0.0',
            description: 'A registration not built with defineDecision.',
            timeoutMs: 0,
            prepare: () => ({
              state: {},
              questions: { yes: { kind: 'boolean', instructions: 'Yes?' } },
            }),
          },
        }),
      },
      stubAdapter(answer),
    );

    await expect(
      runtime.evaluateByName('test.handwritten', {}),
    ).rejects.toThrow(RangeError);
  });
});
