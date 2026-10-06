import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OracleInteraction } from '@ixo/oracles-events/interactions';
import { InteractionCoordinator, type InteractionRecord } from './coordinator';
import { InteractionProducer } from './producer';
import { TypingLeases } from './typing';
import { reportVerifiedTaskCompletion, withHumanInput } from './host-adapters';

const update = (
  state: OracleInteraction['state'] = 'seen',
  revision = 0,
  requestId = 'request',
): OracleInteraction => ({
  sessionId: '$thread',
  requestId,
  oracleDid: 'did:oracle',
  oracleUserId: '@qi:test',
  oracleName: 'Qi',
  roomId: '!room:test',
  sourceEventId: '$user',
  state,
  revision,
  updatedAt: new Date().toISOString(),
});
function fixture(records = new Map<string, InteractionRecord>()) {
  const send = vi.fn(
    async (_update: OracleInteraction, _emoji: string, txn: string) =>
      `$${txn}`,
  );
  const redact = vi.fn(async () => undefined);
  const warn = vi.fn();
  const create = () =>
    new InteractionCoordinator({
      storage: {
        get: async (key) => structuredClone(records.get(key)),
        put: async (key, value) => {
          records.set(key, structuredClone(value));
        },
        list: async () => structuredClone(records),
      },
      send,
      redact,
      keepAlive: () => undefined,
      warn,
    });
  return { records, send, redact, warn, create };
}
afterEach(() => vi.useRealTimers());
describe('oracle reaction lifecycle', () => {
  it('recovers a send with a lost response before replacing it with a newer outcome', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(
      new Error('Network connection lost after acceptance'),
    );
    const first = f.create();
    await first.update(update('working', 1));
    await first.settle();
    expect([...f.records.values()][0]?.sending).toBeDefined();
    const restored = f.create();
    await restored.update(update('completed', 2));
    await restored.settle();
    expect(f.send.mock.calls.map((call) => call[1])).toEqual([
      '👍',
      '👍',
      '✅',
    ]);
    expect(f.send.mock.calls[0]?.[2]).toBe(f.send.mock.calls[1]?.[2]);
    expect(f.redact).toHaveBeenCalledTimes(1);
    expect([...f.records.values()][0]?.sending).toBeUndefined();
  });
  it('replaces its own annotation, keeps human reactions, and ignores stale updates', async () => {
    const f = fixture();
    const coordinator = f.create();
    await coordinator.update(update());
    await coordinator.settle();
    const first = f.send.mock.results[0];
    expect(first).toBeDefined();
    await coordinator.update(update('working', 2));
    await coordinator.settle();
    await coordinator.update(update('completed', 3));
    await coordinator.settle();
    await coordinator.update(update('working', 2));
    await coordinator.settle();
    expect(f.send.mock.calls.map((call) => call[1])).toEqual([
      '👀',
      '👍',
      '✅',
    ]);
    expect(f.redact).toHaveBeenCalledTimes(2);
    expect(f.redact.mock.calls.flat().join(' ')).not.toContain(
      '$human-reaction',
    );
    expect([...f.records.values()][0]?.update.state).toBe('completed');
  });
  it('reconciles rate-limited delivery after a Worker reset using the same transaction', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('M_LIMIT_EXCEEDED'));
    const first = f.create();
    await first.update(update('achieved', 4));
    await first.settle();
    expect([...f.records.values()][0]?.pending).toBe(true);
    await f.create().reconcilePending();
    expect(f.send.mock.calls[0]?.[2]).toBe(f.send.mock.calls[1]?.[2]);
    expect([...f.records.values()][0]?.pending).toBe(false);
  });
  it('retries a failed redaction before replacing, without deleting another oracle reaction', async () => {
    const f = fixture();
    const coordinator = f.create();
    await coordinator.update(update());
    await coordinator.settle();
    f.redact.mockRejectedValueOnce(new Error('offline'));
    await coordinator.update(update('waiting', 2));
    await coordinator.settle();
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.create().reconcilePending();
    expect(f.send.mock.calls[1]?.[1]).toBe('⏸️');
    expect(f.redact.mock.calls[0]).toEqual(f.redact.mock.calls[1]);
  });
  it('isolates users, requests and oracles sharing a room', async () => {
    const f = fixture();
    const coordinator = f.create();
    await Promise.all([
      coordinator.update(update()),
      coordinator.update(update('working', 1, 'second')),
      coordinator.update({
        ...update(),
        oracleDid: 'did:other',
        oracleUserId: '@other:test',
      }),
    ]);
    await coordinator.settle();
    expect(f.records.size).toBe(3);
    expect(f.redact).not.toHaveBeenCalled();
  });
});
describe('run lifecycle', () => {
  function producer() {
    const emit = vi.fn();
    const publish = vi.fn(async () => undefined);
    const save = vi.fn(async () => undefined);
    return {
      emit,
      publish,
      save,
      producer: new InteractionProducer(update(), {
        emit,
        publish,
        save,
        keepAlive: () => undefined,
        warn: () => undefined,
      }),
    };
  }
  it.each(['completed', 'failed', 'cancelled', 'superseded'] as const)(
    'reports %s truthfully',
    async (state) => {
      const f = producer();
      f.producer.start();
      f.producer.finish(state);
      await f.producer.settle();
      expect(f.producer.snapshot.state).toBe(state);
      expect(f.emit.mock.calls.map((call) => call[0].state)).toEqual([
        'accepted',
        'working',
        state,
      ]);
    },
  );
  it('celebrates persisted host evidence only, and preserves uncertainty and waiting', async () => {
    const f = producer();
    f.producer.start();
    f.producer.verifiedAchievement({
      kind: 'artifact',
      reference: 'artifact-record',
    });
    f.producer.finish('completed');
    await f.producer.settle();
    expect(f.producer.snapshot.state).toBe('achieved');
    const uncertain = producer();
    uncertain.producer.start();
    uncertain.producer.needsAttention();
    uncertain.producer.finish('completed');
    expect(uncertain.producer.snapshot.state).toBe('failed');
    const waiting = producer();
    waiting.producer.start();
    waiting.producer.setWaiting(true);
    waiting.producer.finish('completed');
    expect(waiting.producer.snapshot.state).toBe('waiting');
  });
  it('binds a late confirmed mirror without regressing a terminal state', async () => {
    const f = producer();
    f.producer.finish('completed');
    f.producer.bind('!room:test', 'pending-txn');
    expect(f.producer.snapshot.revision).toBe(1);
    f.producer.bind('!room:test', '$confirmed');
    await f.producer.settle();
    expect(f.producer.snapshot.sourceEventId).toBe('$confirmed');
    expect(f.producer.snapshot.state).toBe('completed');
  });
  it('does not abort work when interaction publication fails', async () => {
    const f = producer();
    f.publish.mockRejectedValue(new Error('offline'));
    f.producer.start();
    f.producer.finish('completed');
    await expect(f.producer.settle()).resolves.toBeUndefined();
    expect(f.producer.snapshot.state).toBe('completed');
  });
  it('requires a verified completion receipt and scopes explicit human waits', async () => {
    const interactions = {
      setWaiting: vi.fn(),
      verifiedAchievement: vi.fn(),
      needsAttention: vi.fn(),
    };
    expect(
      reportVerifiedTaskCompletion(
        { interactions },
        { taskId: 'task', status: 'completed' },
      ),
    ).toBe(false);
    expect(
      reportVerifiedTaskCompletion(
        { interactions },
        { taskId: 'task', status: 'completed', completionReceipt: 'receipt' },
      ),
    ).toBe(true);
    await expect(
      withHumanInput({ interactions }, async () => {
        throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    expect(interactions.setWaiting.mock.calls).toEqual([[true], [false]]);
  });
});
describe('typing leases', () => {
  it('keeps typing until the last overlapping run releases its lease', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const leases = new TypingLeases(send);
    leases.set('a', '!room', true);
    leases.set('b', '!room', true);
    await leases.settle();
    send.mockClear();
    leases.set('a', '!room', false);
    await leases.settle();
    expect(send.mock.calls).toEqual([['!room', true, 30000]]);
    await vi.advanceTimersByTimeAsync(20000);
    await leases.settle();
    expect(send.mock.calls.at(-1)).toEqual(['!room', true, 30000]);
    leases.set('b', '!room', false);
    await leases.settle();
    expect(send.mock.calls.at(-1)).toEqual(['!room', false, 30000]);
    leases.dispose();
  });
  it('expires abandoned leases and restores only their remaining lifetime', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const leases = new TypingLeases(send);
    leases.set('restored', '!room', true, Date.now() + 10000);
    await vi.advanceTimersByTimeAsync(20000);
    await leases.settle();
    expect(send.mock.calls.at(-1)).toEqual(['!room', false, 30000]);
    leases.dispose();
  });
});
