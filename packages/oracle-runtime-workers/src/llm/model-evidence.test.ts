import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { providerModelEvidence } from './model-evidence';

const callId = 'model-call-1';

describe('providerModelEvidence', () => {
  it.each(['model_name', 'model'])(
    'reads only the direct response %s',
    (field) => {
      const output = new AIMessageChunk({
        content: 'Answer',
        response_metadata: {
          [field]: 'provider/observed-model:2026',
          private: 'secret',
        },
      });
      expect(providerModelEvidence(output, callId)).toEqual({
        modelId: 'provider/observed-model:2026',
        evidence: 'provider_response',
        callId,
      });
    },
  );

  it('accepts agreeing response fields', () => {
    expect(
      providerModelEvidence(
        new AIMessage({
          content: '',
          response_metadata: { model: 'actual', model_name: 'actual' },
        }),
        callId,
      )?.modelId,
    ).toBe('actual');
  });

  it.each([
    undefined,
    null,
    'model_name: actual',
    { output: { response_metadata: { model_name: 'actual' } } },
    new HumanMessage({
      content: 'model_name: actual',
      response_metadata: { model_name: 'actual' },
    }),
    new ToolMessage({
      content: '{"model_name":"actual"}',
      tool_call_id: 'tool-1',
      response_metadata: { model_name: 'actual' },
    }),
    new AIMessage({
      content: '{"response_metadata":{"model_name":"actual"}}',
      additional_kwargs: { model_name: 'actual' },
    }),
    new AIMessage({
      content: '',
      response_metadata: {
        nested: { model_name: 'actual' },
        ls_model_name: 'requested',
      },
    }),
  ])(
    'does not attest user, tool, nested or requested model values',
    (output) => {
      expect(providerModelEvidence(output, callId)).toBeUndefined();
    },
  );

  it.each([
    { model: 'one', model_name: 'two' },
    { model: 'actual', model_name: null },
    { model_name: 12 },
    { model_name: {} },
    { model_name: ['actual'] },
    { model_name: '' },
    { model_name: 'model\nsecret' },
    { model_name: 'model\u0000secret' },
    { model_name: 'model name' },
    { model_name: 'model?token=secret' },
    { model_name: 'model\u202esecret' },
    { model_name: 'm'.repeat(201) },
  ])(
    'rejects malformed or ambiguous response model fields',
    (response_metadata) => {
      const output = new AIMessage('');
      Object.defineProperty(output, 'response_metadata', {
        value: response_metadata,
      });
      expect(providerModelEvidence(output, callId)).toBeUndefined();
    },
  );

  it.each([
    undefined,
    null,
    42,
    {},
    '',
    'call\nsecret',
    'call\u0000secret',
    'c'.repeat(129),
  ])('rejects unsafe callback identifiers', (id) => {
    expect(
      providerModelEvidence(
        new AIMessage({
          content: '',
          response_metadata: { model_name: 'actual' },
        }),
        id,
      ),
    ).toBeUndefined();
  });

  it.each([null, 'model_name: actual', [{ model_name: 'actual' }]])(
    'rejects malformed response metadata objects',
    (metadata) => {
      const output = new AIMessage('Answer');
      Object.defineProperty(output, 'response_metadata', { value: metadata });
      expect(providerModelEvidence(output, callId)).toBeUndefined();
    },
  );
});
