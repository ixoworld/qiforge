import { describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_RETRY_DELAYS_MS,
  isTransientGatewayError,
  retryGateway,
} from './gateway-retry';

describe('retryGateway', () => {
  it('retries transient failures with the configured delays and returns the result', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const out = await retryGateway(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('Network connection lost.');
        return 'ok';
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual(GATEWAY_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('gives up after the last delay and rethrows', async () => {
    const onRetry = vi.fn();
    await expect(
      retryGateway(
        async () => {
          throw new Error('Durable Object reset');
        },
        {
          delaysMs: [1, 1],
          sleep: async () => undefined,
          onRetry,
        },
      ),
    ).rejects.toThrow('Durable Object reset');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    await expect(
      retryGateway(
        async () => {
          calls += 1;
          throw new Error('M_FORBIDDEN: not in room');
        },
        {
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow('M_FORBIDDEN');
    expect(calls).toBe(1);
  });

  it('classifies transport and not-started errors as transient', () => {
    expect(isTransientGatewayError(new Error('Network connection lost.'))).toBe(
      true,
    );
    expect(
      isTransientGatewayError(
        new Error('Timed out waiting for the Matrix client to start'),
      ),
    ).toBe(true);
    expect(isTransientGatewayError(new Error('M_LIMIT_EXCEEDED'))).toBe(false);
  });
});
