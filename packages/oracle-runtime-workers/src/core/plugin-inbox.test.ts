import { describe, expect, it } from 'vitest';
import {
  deliverToPluginInbox,
  openPluginInbox,
  PLUGIN_INBOX_MAX_BODY_LENGTH,
  readPluginInbox,
} from './plugin-inbox';
import { createMemoryUserKv } from './user-kv';

describe('plugin inbox', () => {
  it('accepts deliveries only into an open row, up to its size', async () => {
    let now = 1_000;
    const kv = createMemoryUserKv({ now: () => now });
    // No row: nothing is created.
    expect(await deliverToPluginInbox(kv, 'p', 'inbox:a', 'x', now)).toBe(
      false,
    );
    expect(await kv.get('p', 'inbox:a')).toBeUndefined();

    await openPluginInbox(kv, 'p', 'inbox:a', {
      expiresAt: 10_000,
      max: 2,
      now,
    });
    expect(await deliverToPluginInbox(kv, 'p', 'inbox:a', 'one', now)).toBe(
      true,
    );
    expect(await deliverToPluginInbox(kv, 'p', 'inbox:a', 'two', now)).toBe(
      true,
    );
    expect(await deliverToPluginInbox(kv, 'p', 'inbox:a', 'three', now)).toBe(
      false,
    );
    expect(await readPluginInbox(kv, 'p', 'inbox:a')).toEqual(['one', 'two']);

    await openPluginInbox(kv, 'p', 'inbox:b', { expiresAt: 2_000, now });
    now = 2_500;
    expect(await deliverToPluginInbox(kv, 'p', 'inbox:b', 'late', now)).toBe(
      false,
    );
  });

  it('refuses empty and oversized bodies', async () => {
    const kv = createMemoryUserKv();
    await openPluginInbox(kv, 'p', 'inbox:a', {
      expiresAt: Date.now() + 60_000,
    });
    expect(await deliverToPluginInbox(kv, 'p', 'inbox:a', '')).toBe(false);
    expect(
      await deliverToPluginInbox(
        kv,
        'p',
        'inbox:a',
        'x'.repeat(PLUGIN_INBOX_MAX_BODY_LENGTH + 1),
      ),
    ).toBe(false);
    expect(await readPluginInbox(kv, 'p', 'inbox:a')).toEqual([]);
  });
});
