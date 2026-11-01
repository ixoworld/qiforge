import { afterEach, describe, expect, it, vi } from 'vitest';
import { broadcastWithSequenceHeal } from './signer';

describe('broadcastWithSequenceHeal', () => {
  afterEach(() => vi.useRealTimers());

  it('resets the sequence keeper when the counter ran ahead of the chain', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const res = await broadcastWithSequenceHeal({ fetch }, async () => ({
      code: 32,
      rawLog:
        'account sequence mismatch, expected 7, got 9: incorrect account sequence',
    }));
    expect(res.code).toBe(32);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits a block instead of resetting when our own tx is still in flight', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('ok'));
    const pending = broadcastWithSequenceHeal({ fetch }, async () => {
      throw new Error('account sequence mismatch, expected 9, got 8');
    });
    // Settle into a value first so the pending rejection is never unhandled
    // while the fake clock runs the one-block wait.
    const settled = pending.then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(String(await settled)).toMatch(/expected 9, got 8/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
