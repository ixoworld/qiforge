import { describe, expect, it, vi } from 'vitest';
import {
  DatabricksAiDecideDecisionAdapter,
  DatabricksSystemOneDecisionAdapter,
} from './databricks.js';

const request = {
  state: { message: 'refund please' },
  questions: {
    billing: { kind: 'boolean' as const, instructions: 'Billing?' },
  },
};

describe('Databricks decision adapters', () => {
  it('records requested and returned model separately on System One', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: 'openjev-qwen35-4b-build-7',
            answers: { billing: { type: 'noul', noul: 0.9 } },
            usage: { input_tokens: 12, output_tokens: 0 },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DatabricksSystemOneDecisionAdapter({
      workspaceUrl: 'https://example.cloud.databricks.com',
      token: 'secret',
      model: 'system.ai.openjev-qwen35-4b',
      fetch: fetchMock,
    });

    const result = await adapter.evaluate(request);
    expect(result.provenance).toMatchObject({
      apiDialect: 'systemone-v1',
      requestedModel: 'system.ai.openjev-qwen35-4b',
      returnedModel: 'openjev-qwen35-4b-build-7',
      modelPinning: 'mutable',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.cloud.databricks.com/ai-gateway/typesafe/v1/systemone',
    );
  });

  it('treats ai_decide as function-version-pinned but model-mutable', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            response: {
              answers: { billing: { type: 'noul', probability: 0.8 } },
            },
            metadata: { version: '1.0' },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DatabricksAiDecideDecisionAdapter({
      workspaceUrl: 'https://example.cloud.databricks.com',
      token: 'secret',
      fetch: fetchMock,
    });

    const result = await adapter.evaluate(request);
    expect(result.answers).toEqual({
      billing: { kind: 'boolean', probabilityTrue: 0.8 },
    });
    expect(result.provenance).toEqual({
      method: { kind: 'provider-native' },
      apiDialect: 'databricks-ai-decide-v1',
      functionVersion: '1.0',
      modelPinning: 'mutable',
      providerArtifactRef: 'databricks:ai_decide:1.0',
    });
  });

  describe('documented wire shapes for every primitive', () => {
    const workspaceUrl = 'https://example.cloud.databricks.com';
    const allPrimitives = {
      state: { message: 'My card was charged twice; I need a refund.' },
      questions: {
        is_billing: {
          kind: 'boolean' as const,
          instructions: 'Is this a billing-related request?',
        },
        intent: {
          kind: 'choice' as const,
          instructions: 'Which intent best matches the message?',
          options: {
            refund: 'The customer requests a refund.',
            duplicate_charge: 'The customer reports being charged twice.',
            other: 'Another request.',
          },
        },
        urgency: {
          kind: 'ordinal' as const,
          instructions: 'How urgent is the request?',
          levels: ['Can wait', 'Needs attention soon', 'Urgent'],
        },
      },
    };
    const choiceAnswer = {
      type: 'choice',
      choice: 'duplicate_charge',
      confidence: 0.965,
      probabilities: { refund: 0.023, duplicate_charge: 0.975, other: 0.002 },
    };
    const scoreAnswer = {
      type: 'score',
      score: 1.9,
      confidence: 0.85,
      legend: { 0: 'Can wait', 1: 'Needs attention soon', 2: 'Urgent' },
      probabilities: { 0: 0.01, 1: 0.08, 2: 0.91 },
    };
    const expectedAnswers = {
      is_billing: { kind: 'boolean', probabilityTrue: 0.98 },
      intent: {
        kind: 'choice',
        value: 'duplicate_charge',
        confidence: 0.965,
        probabilities: {
          refund: 0.023,
          duplicate_charge: 0.975,
          other: 0.002,
        },
      },
      urgency: {
        kind: 'ordinal',
        score: 1.9,
        confidence: 0.85,
        probabilities: { 0: 0.01, 1: 0.08, 2: 0.91 },
      },
    };
    const basicAuth = `Basic ${globalThis.btoa('token:secret')}`;

    it('System One: posts model, state and questions with token Basic auth and parses noul/choice/score', async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              model: '<returned-model-id>',
              answers: {
                is_billing: { type: 'noul', noul: 0.98 },
                intent: choiceAnswer,
                urgency: scoreAnswer,
              },
              usage: { input_tokens: 238, output_tokens: 0 },
            }),
            { status: 200 },
          ),
      );
      const adapter = new DatabricksSystemOneDecisionAdapter({
        workspaceUrl,
        token: 'secret',
        fetch: fetchMock,
      });

      const result = await adapter.evaluate(allPrimitives);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${workspaceUrl}/ai-gateway/typesafe/v1/systemone`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: basicAuth });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'system.ai.openjev-qwen35-4b',
        state: allPrimitives.state,
        questions: {
          is_billing: {
            type: 'noul',
            instructions: 'Is this a billing-related request?',
          },
          intent: {
            type: 'choice',
            instructions: 'Which intent best matches the message?',
            criteria: allPrimitives.questions.intent.options,
          },
          urgency: {
            type: 'score',
            instructions: 'How urgent is the request?',
            criteria: ['Can wait', 'Needs attention soon', 'Urgent'],
          },
        },
      });
      expect(result.answers).toEqual(expectedAnswers);
      expect(result.modelVersion).toBe('<returned-model-id>');
      expect(result.usage).toEqual({ inputTokens: 238, outputTokens: 0 });
    });

    it('ai_decide: posts options.version and parses the documented noul probability, choice and score', async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              response: {
                answers: {
                  is_billing: { type: 'noul', probability: 0.98 },
                  intent: choiceAnswer,
                  urgency: scoreAnswer,
                },
              },
              metadata: { version: '1.0' },
            }),
            { status: 200 },
          ),
      );
      const adapter = new DatabricksAiDecideDecisionAdapter({
        workspaceUrl,
        token: 'secret',
        fetch: fetchMock,
      });

      const result = await adapter.evaluate(allPrimitives);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${workspaceUrl}/api/2.0/ai-functions/ai-decide`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: basicAuth });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        state: allPrimitives.state,
        options: { version: '1.0' },
      });
      expect(result.answers).toEqual(expectedAnswers);
    });

    it('ai_decide: rejects a noul answer without the documented probability field', async () => {
      const adapter = new DatabricksAiDecideDecisionAdapter({
        workspaceUrl,
        token: 'secret',
        fetch: vi.fn<typeof fetch>(
          async () =>
            new Response(
              JSON.stringify({
                response: {
                  answers: { billing: { type: 'noul', noul: 0.8 } },
                },
                metadata: { version: '1.0' },
              }),
              { status: 200 },
            ),
        ),
      });

      await expect(adapter.evaluate(request)).rejects.toThrow(
        /noul answer did not carry a numeric probability/,
      );
    });
  });
});
