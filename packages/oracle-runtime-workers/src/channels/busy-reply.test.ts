import { describe, expect, it, vi } from 'vitest';
import { attachModelCall } from '../llm/model-call';
import {
  CHANNEL_BUSY_REPLY_COOLDOWN_MS,
  CHANNEL_BUSY_REPLY_DEFAULT,
  busyReplyDue,
  busyReplyText,
  modelFailureOf,
} from './busy-reply';

describe('modelFailureOf', () => {
  it('reads the failed call off the error or its causes', () => {
    const error = new Error('402 requires more credits');
    attachModelCall(error, {
      role: 'main',
      requestedModel: 'openai/gpt-5.6-luna',
      fallback: false,
      modelFallback: false,
      providerFallback: false,
      durationMs: 5,
      ok: false,
      errorKind: 'billing',
      errorStatus: 402,
    });
    expect(modelFailureOf(new Error('wrapped', { cause: error }))).toEqual({
      kind: 'billing',
      status: 402,
    });
    expect(modelFailureOf(new Error('a tool failed'))).toBeNull();
  });
});

describe('busyReplyDue', () => {
  it('allows one reply per ten minutes', () => {
    const now = 1_000_000_000;
    expect(busyReplyDue(undefined, now)).toBe(true);
    expect(busyReplyDue(now - CHANNEL_BUSY_REPLY_COOLDOWN_MS + 1, now)).toBe(
      false,
    );
    expect(busyReplyDue(now - CHANNEL_BUSY_REPLY_COOLDOWN_MS, now)).toBe(true);
  });
});

describe('busyReplyText', () => {
  it("takes the first plugin's text, then the deployment's, then the default", async () => {
    const warn = vi.fn();
    expect(
      await busyReplyText(
        [
          () => {
            throw new Error('no language');
          },
          () => undefined,
          async () => '  Ngiyaxolisa, ngimatasa manje.  ',
        ],
        'Configured',
        warn,
      ),
    ).toBe('Ngiyaxolisa, ngimatasa manje.');
    expect(warn).toHaveBeenCalledOnce();
    expect(await busyReplyText([() => ''], 'Configured', warn)).toBe(
      'Configured',
    );
    expect(await busyReplyText([], undefined, warn)).toBe(
      CHANNEL_BUSY_REPLY_DEFAULT,
    );
  });
});
