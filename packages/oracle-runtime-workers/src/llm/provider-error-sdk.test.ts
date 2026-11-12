/**
 * The classifier against the error objects the upgraded stack really throws:
 * `ChatOpenAICompletions` (@langchain/openai) on the `openai` SDK 7, answered
 * by a stub `fetch` with the HTTP responses the providers send. Nothing is
 * hand-built, so a change of error class or shape in either package shows up
 * here.
 */
import { ChatOpenAICompletions } from '@langchain/openai';
import { describe, expect, it } from 'vitest';
import { classifyLlmError, isModelUnavailableError } from './provider-error';

async function thrownBy(response: () => Response): Promise<unknown> {
  const model = new ChatOpenAICompletions({
    model: 'gpt-5.6-sol',
    apiKey: 'sk-test',
    maxRetries: 0,
    configuration: {
      baseURL: 'https://upstream.invalid/v1',
      fetch: async () => response(),
    },
  });
  try {
    await model.invoke('hi');
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isModelUnavailableError on the real SDK 7 errors', () => {
  it('a bare 400 (empty body) is not a model refusal', async () => {
    const error = await thrownBy(() => new Response('', { status: 400 }));
    expect(error).toMatchObject({ status: 400 });
    expect(isModelUnavailableError(error)).toBe(false);
    expect(classifyLlmError(error)).toMatchObject({
      kind: 'unknown',
      status: 400,
    });
  });

  it('a bare 404 (empty body) is not a model refusal', async () => {
    const error = await thrownBy(() => new Response('', { status: 404 }));
    expect(error).toMatchObject({ status: 404 });
    expect(isModelUnavailableError(error)).toBe(false);
  });

  it('a 400 that names another field is not a model refusal', async () => {
    const error = await thrownBy(() =>
      jsonResponse(400, {
        error: {
          message:
            "Invalid 'input[10].call_id': string too long. Expected a string with maximum length 64, but got a string with length 72 instead.",
          type: 'invalid_request_error',
          param: 'input[10].call_id',
          code: 'string_above_max_length',
        },
      }),
    );
    expect(error).toMatchObject({
      status: 400,
      code: 'string_above_max_length',
    });
    expect(isModelUnavailableError(error)).toBe(false);
  });

  it('an explicit 404 model_not_found is a model refusal', async () => {
    const error = await thrownBy(() =>
      jsonResponse(404, {
        error: {
          message:
            'The model `gpt-5.6-sol` does not exist or you do not have access to it.',
          type: 'invalid_request_error',
          param: null,
          code: 'model_not_found',
        },
      }),
    );
    expect(error).toMatchObject({ status: 404, code: 'model_not_found' });
    expect(isModelUnavailableError(error)).toBe(true);
  });

  it('a 400 that says the model is not supported is a model refusal', async () => {
    const error = await thrownBy(() =>
      jsonResponse(400, {
        detail:
          "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      }),
    );
    expect(error).toMatchObject({ status: 400 });
    expect(isModelUnavailableError(error)).toBe(true);
  });

  it('a 429 and a 500 never are', async () => {
    expect(
      isModelUnavailableError(
        await thrownBy(() =>
          jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }),
        ),
      ),
    ).toBe(false);
    expect(
      isModelUnavailableError(
        await thrownBy(() => new Response('', { status: 500 })),
      ),
    ).toBe(false);
  });
});
