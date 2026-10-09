/**
 * LLM error classification — the port of the Node runtime's classifier that
 * shapes the SSE `error` payload (kind / source / retryable / redaction).
 */
import { describe, expect, it } from 'vitest';
import {
  buildByoFallbackNotice,
  classifyLlmError,
  isModelUnavailableError,
  isOperatorFault,
  redactOperatorFault,
} from './provider-error';
import { ProviderStallError } from './stream-liveness';

describe('classifyLlmError', () => {
  it('maps HTTP statuses and provider codes to kinds', () => {
    expect(
      classifyLlmError(Object.assign(new Error('x'), { status: 429 })),
    ).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429 });
    expect(
      classifyLlmError(
        Object.assign(new Error('quota'), { code: 'insufficient_quota' }),
      ),
    ).toMatchObject({ kind: 'billing', retryable: false });
    expect(classifyLlmError(new Error('504 Gateway Timeout'))).toMatchObject({
      kind: 'timeout',
      retryable: true,
      status: 504,
    });
    expect(classifyLlmError(new Error('fetch failed'))).toMatchObject({
      kind: 'network',
      retryable: true,
    });
    expect(
      classifyLlmError({
        error: { type: 'overloaded_error' },
        message: 'busy',
      }),
    ).toMatchObject({ kind: 'server', retryable: true });
    expect(classifyLlmError(new Error('weird'))).toMatchObject({
      kind: 'unknown',
      retryable: false,
      source: 'platform',
      detail: 'weird',
    });
  });

  it('classifies a provider stall as a retryable timeout that names the stall', () => {
    const midReply = new ProviderStallError({
      phase: 'stream',
      idleMs: 90_000,
      elapsedMs: 130_000,
      bytesSeen: 2048,
      label: 'openrouter subagent openai/gpt-5.6-luna',
    });
    expect(classifyLlmError(midReply)).toMatchObject({
      kind: 'timeout',
      source: 'platform',
      retryable: true,
      message: 'The model stopped responding mid-reply. Please try again.',
      detail: midReply.message,
    });
    // Before the first byte, wrapped the way the OpenAI SDK wraps a failed
    // fetch (APIConnectionError with the original as `cause`).
    const beforeFirstByte = new Error('Connection error.', {
      cause: new ProviderStallError({
        phase: 'first-byte',
        idleMs: 90_000,
        elapsedMs: 91_000,
        bytesSeen: 0,
        label: 'openrouter main openai/gpt-5.6-luna',
      }),
    });
    const classified = classifyLlmError(beforeFirstByte, {
      byoProvider: 'openai',
    });
    expect(classified).toMatchObject({
      kind: 'timeout',
      source: 'byo',
      provider: 'openai',
      retryable: true,
      message: 'The model did not start responding. Please try again.',
    });
    expect(classified.status).toBeUndefined();
    // The stall is never mistaken for a refused model.
    expect(isModelUnavailableError(beforeFirstByte)).toBe(false);
  });

  it('attributes BYO turns to the provider with a human label', () => {
    const c = classifyLlmError(
      Object.assign(new Error('401 incorrect api key'), { status: 401 }),
      { byoProvider: 'openai' },
    );
    expect(c.source).toBe('byo');
    expect(c.provider).toBe('openai');
    expect(typeof c.providerLabel).toBe('string');
    expect(c.kind).toBe('auth');
    expect(c.message).toContain(c.providerLabel!);
    // A user's own credential failing is not an operator fault — not redacted.
    expect(isOperatorFault(c)).toBe(false);
    expect(redactOperatorFault(c)).toBe(c);
  });

  it('ignores unknown provider ids in the context', () => {
    expect(
      classifyLlmError(new Error('x'), { byoProvider: 'not-a-provider' }),
    ).toMatchObject({ source: 'platform' });
  });

  it('redacts platform-side billing/auth failures before they reach the wire', () => {
    const platformAuth = classifyLlmError(
      Object.assign(new Error('invalid api key'), { status: 401 }),
    );
    expect(platformAuth.kind).toBe('auth');
    expect(isOperatorFault(platformAuth)).toBe(true);
    const safe = redactOperatorFault(platformAuth);
    expect(safe).toMatchObject({
      kind: 'unknown',
      source: 'platform',
      status: 500,
      retryable: false,
    });
    expect(safe.detail).not.toMatch(/api key/i);

    const platformBilling = classifyLlmError(
      new Error('402 payment required: purchase credits'),
    );
    expect(platformBilling.kind).toBe('billing');
    expect(redactOperatorFault(platformBilling).kind).toBe('unknown');

    // Retryable platform faults are the user's to see.
    const platformRate = classifyLlmError(new Error('429 too many requests'));
    expect(redactOperatorFault(platformRate)).toBe(platformRate);
  });
});

describe('isModelUnavailableError', () => {
  const httpError = (status: number, message: string, extra = {}) =>
    Object.assign(new Error(message), { status, ...extra });

  it('takes the ChatGPT backend’s empty 400 as a refused model', () => {
    expect(
      isModelUnavailableError(httpError(400, '400 status code (no body)')),
    ).toBe(true);
    // The status recovered from the message alone, as the SSE detail shows it.
    expect(
      isModelUnavailableError(new Error('400 status code (no body)')),
    ).toBe(true);
  });

  it('takes a 404 model_not_found and the providers’ model texts', () => {
    expect(
      isModelUnavailableError(
        httpError(404, 'The model `gpt-6-luna` does not exist', {
          code: 'model_not_found',
        }),
      ),
    ).toBe(true);
    expect(
      isModelUnavailableError(
        httpError(
          400,
          "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
        ),
      ),
    ).toBe(true);
    expect(
      isModelUnavailableError({
        message: 'bad request',
        error: { code: 'model_not_found' },
      }),
    ).toBe(true);
  });

  it('is never the case once the call produced output', () => {
    expect(
      isModelUnavailableError(httpError(400, '400 invalid request'), {
        afterOutput: true,
      }),
    ).toBe(false);
    expect(
      isModelUnavailableError(
        httpError(404, 'model_not_found', { code: 'model_not_found' }),
        { afterOutput: true },
      ),
    ).toBe(false);
  });

  it('leaves other failures to classifyLlmError, kinds unchanged', () => {
    const rate = httpError(429, '429 Too Many Requests');
    expect(isModelUnavailableError(rate)).toBe(false);
    expect(classifyLlmError(rate).kind).toBe('rate_limit');
    const server = httpError(500, '500 Internal Server Error');
    expect(isModelUnavailableError(server)).toBe(false);
    expect(classifyLlmError(server).kind).toBe('server');
    expect(
      isModelUnavailableError(httpError(503, 'model is not available')),
    ).toBe(false);
    expect(isModelUnavailableError(httpError(401, 'invalid api key'))).toBe(
      false,
    );
    // A bare 400 that is something else this module or LangChain knows.
    expect(
      isModelUnavailableError(
        httpError(
          400,
          "This model's maximum context length is 128000 tokens.",
          { code: 'context_length_exceeded' },
        ),
      ),
    ).toBe(false);
    expect(
      isModelUnavailableError(
        httpError(400, '400 tool_calls must be followed by tool messages', {
          lc_error_code: 'INVALID_TOOL_RESULTS',
        }),
      ),
    ).toBe(false);
    expect(
      isModelUnavailableError(httpError(400, '400 insufficient_quota')),
    ).toBe(false);
    // No status and no model text: not a refusal.
    expect(isModelUnavailableError(new Error('socket hang up'))).toBe(false);
  });
});

describe('buildByoFallbackNotice model_unavailable', () => {
  it('names the subscription and the catalog label of the refused model', () => {
    const notice = buildByoFallbackNotice('model_unavailable', 'chatgpt', {
      modelId: 'gpt-5.6-terra',
    });
    expect(notice).toMatchObject({
      kind: 'byo_fallback',
      reason: 'model_unavailable',
      source: 'byo',
      provider: 'chatgpt',
      model: 'gpt-5.6-terra',
      retryable: false,
    });
    expect(notice.error).toBe(
      "Your ChatGPT subscription doesn't offer GPT-5.6 Terra, so this reply used the platform model instead. Pick another model in your Personal Agent settings.",
    );
  });

  it('names an API-key provider’s account, and an uncatalogued model by its id', () => {
    const notice = buildByoFallbackNotice('model_unavailable', 'openai', {
      modelId: 'gpt-6-luna',
    });
    expect(notice.error).toBe(
      "Your OpenAI API account doesn't offer gpt-6-luna, so this reply used the platform model instead. Pick another model in your Personal Agent settings.",
    );
  });

  it('leaves the pre-turn reasons as they were', () => {
    const unreachable = buildByoFallbackNotice('unreachable', 'chatgpt');
    expect(unreachable.reason).toBe('unreachable');
    expect(unreachable.model).toBeUndefined();
    expect(unreachable.error).toBe(
      "Your ChatGPT (subscription) can't be reached from this oracle right now, so this reply is using the platform model instead.",
    );
    // A model id passed with another reason is ignored.
    expect(
      buildByoFallbackNotice('reconnect_required', 'chatgpt', {
        modelId: 'gpt-5.6-luna',
      }).model,
    ).toBeUndefined();
  });
});
