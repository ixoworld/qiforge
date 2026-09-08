/**
 * LLM error classification — the port of the Node runtime's classifier that
 * shapes the SSE `error` payload (kind / source / retryable / redaction).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyLlmError,
  isOperatorFault,
  redactOperatorFault,
} from './provider-error';

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
