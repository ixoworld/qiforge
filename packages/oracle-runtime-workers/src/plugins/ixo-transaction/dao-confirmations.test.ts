/**
 * The DAO DAO confirmation record over the in-memory `ctx.kv`: a preview
 * is confirmed only from a later request and only once, per user and
 * session; a group is sent once, and an unknown outcome holds it for a
 * bounded time.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryUserKv } from '../../core/user-kv';
import {
  GROUP_ATTEMPT_HOLD_MS,
  KvDaoConfirmationStore,
  MAX_PREVIEWS,
} from './dao-confirmations';

const USER = 'did:ixo:ixo1user';
const SESSION = 'session-1';
const SHOWN = { digest: 'd1', requestId: 'req-shown' };
const CONFIRMED = { digest: 'd1', requestId: 'req-confirmed' };

function storeAt(start = 1_000_000) {
  let now = start;
  const kv = createMemoryUserKv({ now: () => now });
  const store = new KvDaoConfirmationStore(kv, () => now);
  return {
    store,
    kv,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('KvDaoConfirmationStore: previews', () => {
  it('confirms a preview from a later request once, and never from the request that showed it', async () => {
    const { store } = storeAt();
    await expect(store.claim(USER, SESSION, CONFIRMED)).resolves.toBe(
      'not-previewed',
    );
    await store.preview(USER, SESSION, SHOWN);
    await expect(store.claim(USER, SESSION, SHOWN)).resolves.toBe(
      'same-request',
    );
    // A same-request refusal keeps the preview for the user's answer.
    await expect(store.claim(USER, SESSION, CONFIRMED)).resolves.toBe('ok');
    // Spent: the next signing needs a preview of its own.
    await expect(store.claim(USER, SESSION, CONFIRMED)).resolves.toBe(
      'not-previewed',
    );
  });

  it('keeps previews per user and session, and per digest', async () => {
    const { store } = storeAt();
    await store.preview(USER, SESSION, SHOWN);
    await expect(
      store.claim('did:ixo:ixo1other', SESSION, CONFIRMED),
    ).resolves.toBe('not-previewed');
    await expect(store.claim(USER, 'session-2', CONFIRMED)).resolves.toBe(
      'not-previewed',
    );
    await expect(
      store.claim(USER, SESSION, { ...CONFIRMED, digest: 'd2' }),
    ).resolves.toBe('not-previewed');
    await expect(store.claim(USER, SESSION, CONFIRMED)).resolves.toBe('ok');
  });

  it('keeps the newest previews only, and a new preview of a digest replaces its request', async () => {
    const { store } = storeAt();
    for (let index = 0; index <= MAX_PREVIEWS; index += 1)
      await store.preview(USER, SESSION, {
        digest: `d${index}`,
        requestId: 'req-shown',
      });
    await expect(
      store.claim(USER, SESSION, { digest: 'd0', requestId: 'req-later' }),
    ).resolves.toBe('not-previewed');
    await expect(
      store.claim(USER, SESSION, {
        digest: `d${MAX_PREVIEWS}`,
        requestId: 'req-later',
      }),
    ).resolves.toBe('ok');

    await store.preview(USER, SESSION, SHOWN);
    await store.preview(USER, SESSION, { ...SHOWN, requestId: 'req-again' });
    await expect(
      store.claim(USER, SESSION, { ...SHOWN, requestId: 'req-again' }),
    ).resolves.toBe('same-request');
  });
});

describe('KvDaoConfirmationStore: one creation per group', () => {
  it('records a claimed group as sending, and refuses it again until it is released', async () => {
    const { store } = storeAt();
    await expect(store.claimGroup(USER, SESSION, CONFIRMED)).resolves.toEqual({
      status: 'not-previewed',
    });
    await store.preview(USER, SESSION, SHOWN);
    await expect(store.claimGroup(USER, SESSION, SHOWN)).resolves.toEqual({
      status: 'same-request',
    });
    await expect(store.claimGroup(USER, SESSION, CONFIRMED)).resolves.toEqual({
      status: 'ok',
    });
    await store.preview(USER, SESSION, SHOWN);
    await expect(
      store.claimGroup(USER, SESSION, CONFIRMED),
    ).resolves.toMatchObject({
      status: 'attempted',
      attempt: { digest: 'd1', state: 'sending' },
    });

    await store.settleGroup(USER, SESSION, 'd1', { state: 'released' });
    await expect(
      store.groupAttempt(USER, SESSION, 'd1'),
    ).resolves.toBeUndefined();
    await expect(store.claimGroup(USER, SESSION, CONFIRMED)).resolves.toEqual({
      status: 'ok',
    });
  });

  it('holds a created group for good and an unknown outcome for its hold only', async () => {
    const { store, advance } = storeAt();
    for (const digest of ['created', 'unknown']) {
      await store.preview(USER, SESSION, { digest, requestId: 'req-shown' });
      await store.claimGroup(USER, SESSION, {
        digest,
        requestId: 'req-confirmed',
      });
    }
    await store.settleGroup(USER, SESSION, 'created', {
      state: 'created',
      txHash: 'A'.repeat(64),
      coreAddress: 'ixo1core',
    });
    await store.settleGroup(USER, SESSION, 'unknown', { state: 'unknown' });
    await expect(
      store.groupAttempt(USER, SESSION, 'created'),
    ).resolves.toMatchObject({
      state: 'created',
      txHash: 'A'.repeat(64),
      coreAddress: 'ixo1core',
    });
    await expect(
      store.groupAttempt(USER, SESSION, 'unknown'),
    ).resolves.toMatchObject({ state: 'unknown' });

    advance(GROUP_ATTEMPT_HOLD_MS - 1);
    await expect(
      store.groupAttempt(USER, SESSION, 'unknown'),
    ).resolves.toMatchObject({ state: 'unknown' });
    advance(1);
    await expect(
      store.groupAttempt(USER, SESSION, 'unknown'),
    ).resolves.toBeUndefined();
    await expect(
      store.groupAttempt(USER, SESSION, 'created'),
    ).resolves.toMatchObject({ state: 'created' });
  });
});
