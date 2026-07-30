import { describe, expect, it } from 'vitest';
import {
  buildByoFallbackNotice,
  BYO_FALLBACK_KIND,
  classifyLlmError,
} from './provider-error.js';

/** Build an error the way the SDK stack actually throws them. */
function sdkError(message: string, extras?: Record<string, unknown>): Error {
  const error = new Error(message);
  if (extras) Object.assign(error, extras);
  return error;
}

describe('classifyLlmError — real provider error shapes', () => {
  it('OpenAI quota exhaustion (insufficient_quota on a 429) is billing, not rate limit', () => {
    const result = classifyLlmError(
      sdkError(
        '429 You exceeded your current quota, please check your plan and billing details.',
        { status: 429, code: 'insufficient_quota' },
      ),
      { byoProvider: 'openai' },
    );
    expect(result.kind).toBe('billing');
    expect(result.source).toBe('byo');
    expect(result.provider).toBe('openai');
    expect(result.status).toBe(429);
    expect(result.retryable).toBe(false);
  });

  it("LangChain's InsufficientQuotaError wrapper (name only, no code) is billing", () => {
    const wrapped = new Error(
      '429 You exceeded your current quota, please check your plan and billing details.',
    );
    wrapped.name = 'InsufficientQuotaError';
    expect(classifyLlmError(wrapped).kind).toBe('billing');
  });

  it('Anthropic credit exhaustion hides behind a 400 — wording wins over status', () => {
    const result = classifyLlmError(
      sdkError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
        {
          status: 400,
          error: {
            type: 'invalid_request_error',
            message:
              'Your credit balance is too low to access the Anthropic API.',
          },
        },
      ),
      { byoProvider: 'anthropic' },
    );
    expect(result.kind).toBe('billing');
    expect(result.providerLabel).toBe('Anthropic API');
  });

  it('DeepSeek balance exhaustion (402 Insufficient Balance) is billing', () => {
    const result = classifyLlmError(
      sdkError('402 Insufficient Balance', { status: 402 }),
      { byoProvider: 'deepseek' },
    );
    expect(result.kind).toBe('billing');
    expect(result.retryable).toBe(false);
  });

  it('Anthropic rate_limit_error type maps to rate_limit', () => {
    const result = classifyLlmError(
      sdkError(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit."}}',
        {
          status: 429,
          error: { type: 'rate_limit_error', message: 'rate limited' },
        },
      ),
      { byoProvider: 'anthropic' },
    );
    expect(result.kind).toBe('rate_limit');
    expect(result.retryable).toBe(true);
  });

  it('ChatGPT backend empty-body 429 still classifies via status prefix in the message', () => {
    // The Codex backend reports errors with an empty body; the SDK throws
    // with no `status` field populated on some paths — the "429 " message
    // prefix is all there is.
    const result = classifyLlmError(sdkError('429 status code (no body)'), {
      byoProvider: 'chatgpt',
    });
    expect(result.kind).toBe('rate_limit');
    expect(result.status).toBe(429);
    expect(result.provider).toBe('chatgpt');
    expect(result.message).toMatch(/ChatGPT plan/);
  });

  it('invalid API keys classify as auth for OpenAI and Anthropic shapes', () => {
    expect(
      classifyLlmError(
        sdkError('401 Incorrect API key provided: sk-proj-***.', {
          status: 401,
          code: 'invalid_api_key',
        }),
        { byoProvider: 'openai' },
      ).kind,
    ).toBe('auth');
    expect(
      classifyLlmError(
        sdkError(
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
          {
            status: 401,
            error: {
              type: 'authentication_error',
              message: 'invalid x-api-key',
            },
          },
        ),
        { byoProvider: 'anthropic' },
      ).kind,
    ).toBe('auth');
  });

  it('Anthropic overloaded_error (529) maps to server and is retryable', () => {
    const result = classifyLlmError(
      sdkError(
        '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        {
          status: 529,
          error: { type: 'overloaded_error', message: 'Overloaded' },
        },
      ),
      { byoProvider: 'anthropic' },
    );
    expect(result.kind).toBe('server');
    expect(result.retryable).toBe(true);
  });

  it('timeouts and network failures classify without any status', () => {
    expect(classifyLlmError(sdkError('Request timed out.')).kind).toBe(
      'timeout',
    );
    expect(classifyLlmError(sdkError('fetch failed')).kind).toBe('network');
    expect(classifyLlmError(sdkError('read ECONNRESET')).kind).toBe('network');
  });

  it('platform turns (no BYO provider) report source platform without provider fields', () => {
    const result = classifyLlmError(
      sdkError('429 Provider returned error', { status: 429 }),
    );
    expect(result.source).toBe('platform');
    expect(result.provider).toBeUndefined();
    expect(result.providerLabel).toBeUndefined();
  });

  it('degrades to unknown while preserving the raw text as detail', () => {
    const result = classifyLlmError(sdkError('something inexplicable'));
    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.detail).toBe('something inexplicable');
  });

  it('never throws on non-Error inputs', () => {
    expect(classifyLlmError('plain string').kind).toBe('unknown');
    expect(classifyLlmError(null).kind).toBe('unknown');
    expect(classifyLlmError(undefined).kind).toBe('unknown');
    expect(classifyLlmError({ weird: true }).kind).toBe('unknown');
  });
});

describe('buildByoFallbackNotice', () => {
  it('carries the byo_fallback kind, the provider, and a reconnect hint', () => {
    const notice = buildByoFallbackNotice('reconnect_required', 'chatgpt');
    expect(notice.kind).toBe(BYO_FALLBACK_KIND);
    expect(notice.source).toBe('byo');
    expect(notice.provider).toBe('chatgpt');
    expect(notice.retryable).toBe(false);
    expect(notice.error).toMatch(/platform model/);
    expect(notice.error).toMatch(/Reconnect/);
  });

  it('handles the providerless degradation case', () => {
    const notice = buildByoFallbackNotice('error');
    expect(notice.provider).toBeUndefined();
    expect(notice.error).toMatch(/platform model/);
  });
});
