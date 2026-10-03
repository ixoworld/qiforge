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
    const fetchMock = vi.fn<typeof fetch>(async () =>
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
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          response: {
            answers: { billing: { type: 'noul', noul: 0.8 } },
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
    expect(result.provenance).toEqual({
      apiDialect: 'databricks-ai-decide-v1',
      functionVersion: '1.0',
      modelPinning: 'mutable',
      providerArtifactRef: 'databricks:ai_decide:1.0',
    });
  });
});
