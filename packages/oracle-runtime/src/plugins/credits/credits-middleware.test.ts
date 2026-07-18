import { describe, expect, it, vi } from 'vitest';
import {
  createCreditsMiddleware,
  type CreditLimiter,
} from './credits-middleware.js';
import { makePlugin } from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';

function limiterMock(remaining: number): {
  limiter: CreditLimiter;
  getRemaining: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
} {
  const getRemaining = vi.fn().mockResolvedValue(remaining);
  const limit = vi.fn().mockResolvedValue({ allowed: true });
  return {
    limiter: {
      getRemaining,
      limit,
      creditsForUsage: vi.fn().mockReturnValue(1),
    },
    getRemaining,
    limit,
  };
}

async function invoke(
  limiter: CreditLimiter,
  mode: string | undefined,
): Promise<{ before?: unknown; after?: unknown }> {
  const rt = await createTestRuntime({
    plugins: [
      makePlugin({
        name: 'credits-under-test',
        getMiddlewares: () => [createCreditsMiddleware({ limiter })],
      }),
    ],
  });
  try {
    return await rt.invokeMiddleware(
      'TokenLimiterMiddleware',
      { messages: [] },
      {
        context: {
          user: { did: 'did:ixo:user1' },
          session: { id: 's', client: 'matrix', requestId: 'r', mode },
        },
      },
    );
  } finally {
    await rt.close();
  }
}

describe('credits middleware — concierge pass-through', () => {
  it('skips the balance gate and never bills on concierge turns', async () => {
    const { limiter, getRemaining, limit } = limiterMock(0);

    const { before, after } = await invoke(limiter, 'concierge');

    expect(before).toBeUndefined();
    expect(after).toBeUndefined();
    expect(getRemaining).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it('still gates full-mode turns with no remaining balance', async () => {
    const { limiter, getRemaining } = limiterMock(0);

    const { before } = await invoke(limiter, 'full');

    expect(getRemaining).toHaveBeenCalledWith('did:ixo:user1');
    const messages = (before as { messages: Array<{ content: string }> })
      .messages;
    expect(messages.at(-1)?.content).toContain('run out of tokens');
  });

  it('treats an absent mode as full (gate applies, balance permits)', async () => {
    const { limiter, getRemaining } = limiterMock(5);

    const { before } = await invoke(limiter, undefined);

    expect(getRemaining).toHaveBeenCalled();
    expect(before).toBeUndefined();
  });
});
