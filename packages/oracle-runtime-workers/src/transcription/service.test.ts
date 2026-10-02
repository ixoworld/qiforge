import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TranscriptionBillingError,
  type TranscriptionBilling,
  type TranscriptionBillingAdmission,
} from './billing';
import type { ProviderCallbacks } from './provider';
import {
  TranscriptionService,
  TRANSCRIPTION_JOURNAL_KEY,
  type ClientSink,
  type TranscriptionJournal,
  type TranscriptionStore,
} from './service';
import type { TranscriptionEvent } from './protocol';

class MemoryStore implements TranscriptionStore {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
}
const origin = 'https://portal.example';
function harness(store = new MemoryStore()) {
  let callbacks: ProviderCallbacks | undefined;
  const admission: TranscriptionBillingAdmission = {
    reservationId: 'r1',
    sessionId: 'sessionid',
    userDid: 'did:ixo:user',
    customerId: 'c1',
    maxAudioSeconds: 60,
    maxQuantity: '60',
    maxCharge: '600',
    expiresAt: '2026-10-02T06:00:00Z',
    settleBy: '2026-10-03T06:00:00Z',
    meter: {
      serviceSlug: 'voice',
      productSlug: 'dictation',
      metricSlug: 'seconds',
      eventType: 'dictation',
      quantityProperty: 'seconds',
      unit: 'second',
      denom: 'uixo',
      unitPrice: '10',
      rateCardSlug: 'test-rate',
    },
  };
  const billing: TranscriptionBilling = {
    admit: vi.fn(async (input) => ({
      ...admission,
      sessionId: input.sessionId,
      userDid: input.userDid,
    })),
    settle: vi.fn(async () => ({
      eventId: 'e1',
      chargeId: 'c1',
      amount: '10',
      denom: 'uixo',
      idempotent: false,
    })),
    release: vi.fn(async () => undefined),
  };
  const provider = { append: vi.fn(), commit: vi.fn(), close: vi.fn() };
  const events: TranscriptionEvent[] = [];
  const sink: ClientSink = {
    send: (event) => events.push(event),
    close: vi.fn(),
  };
  const schedule = vi.fn(async () => undefined);
  const options = {
    store,
    billing,
    limits: {
      maxDurationMs: 60000,
      maxDailyAudioMs: 120000,
      allowedOrigins: [origin],
    },
    connect: vi.fn(async (cb: ProviderCallbacks) => {
      callbacks = cb;
      return provider;
    }),
    schedule,
  };
  const service = new TranscriptionService(options);
  return {
    service,
    store,
    billing,
    provider,
    events,
    sink,
    schedule,
    options,
    callbacks: () => {
      if (!callbacks) throw new Error('provider not connected');
      return callbacks;
    },
    async start() {
      const session = await service.create(
        'did:ixo:user',
        'private-source',
        origin,
        'https://oracle.example',
      );
      await service.attach(session.sessionId, session.ticket, origin, sink);
      return session;
    },
    async audio(id: string) {
      await service.audio(id, new ArrayBuffer(24000));
      await service.audio(id, new ArrayBuffer(24000));
    },
    journal: () => store.get<TranscriptionJournal>(TRANSCRIPTION_JOURNAL_KEY),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T05:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('billable transcription session', () => {
  it('reserves for the authenticated user before issuing a secret one-use ticket', async () => {
    const h = harness();
    const session = await h.start();
    expect(h.billing.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        userDid: 'did:ixo:user',
        sourceInvocation: 'private-source',
        maxAudioSeconds: 60,
      }),
    );
    expect(session.websocketUrl).not.toContain(session.ticket);
    expect(JSON.stringify([...h.store.data])).not.toContain('private-source');
    expect(JSON.stringify([...h.store.data])).not.toContain(session.ticket);
    expect(h.events).toEqual([{ type: 'ready' }]);
    await expect(
      h.service.attach(session.sessionId, session.ticket, origin, h.sink),
    ).rejects.toMatchObject({ code: 'invalid_ticket' });
  });
  it('requires approved origins before making a reservation', async () => {
    const h = harness();
    await expect(
      h.service.create(
        'did:ixo:user',
        'source',
        'https://evil.example',
        'https://oracle.example',
      ),
    ).rejects.toMatchObject({ code: 'origin_forbidden' });
    expect(h.billing.admit).not.toHaveBeenCalled();
  });
  it('serializes concurrent starts and never opens two paid sessions', async () => {
    const h = harness();
    const result = await Promise.allSettled(
      [1, 2].map(() =>
        h.service.create(
          'did:ixo:user',
          'source',
          origin,
          'https://oracle.example',
        ),
      ),
    );
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.billing.admit).toHaveBeenCalledTimes(1);
  });
  it('keeps partial text volatile, commits only on stop, settles provider seconds exactly once', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    h.callbacks().delta('hello partial');
    expect(JSON.stringify([...h.store.data])).not.toContain('hello');
    expect(h.provider.commit).not.toHaveBeenCalled();
    await h.service.stop(s.sessionId, false);
    await h.service.stop(s.sessionId, false);
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
    h.callbacks().completed('hello final', 1);
    h.callbacks().completed('hello final', 1);
    await h.service.tick();
    expect(h.events.filter((e) => e.type === 'completed')).toEqual([
      { type: 'completed', text: 'hello final' },
    ]);
    expect(h.billing.settle).toHaveBeenCalledTimes(1);
    expect(h.billing.settle).toHaveBeenCalledWith(
      expect.objectContaining({ measuredAudioSeconds: 1 }),
    );
    expect(JSON.stringify([...h.store.data])).not.toContain('hello');
    expect((await h.journal())?.phase).toBe('settled');
  });
  it('cancel discards text but commits/settles audio already processed', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.stop(s.sessionId, true);
    h.callbacks().completed('discard me', 1);
    await h.service.tick();
    expect(h.events.some((e) => e.type === 'completed')).toBe(false);
    expect(h.billing.settle).toHaveBeenCalledTimes(1);
    expect(h.billing.release).not.toHaveBeenCalled();
  });
  it('a different unauthenticated socket cannot cancel the admitted session', async () => {
    const h = harness();
    const s = await h.start();
    await h.service.disconnect(s.sessionId, {
      send: () => undefined,
      close: () => undefined,
    });
    expect(h.provider.close).not.toHaveBeenCalled();
    expect((await h.journal())?.phase).toBe('listening');
  });
  it('disconnect still finalizes processed usage without emitting text', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.disconnect(s.sessionId, h.sink);
    h.callbacks().completed('never insert', 1);
    await h.service.tick();
    expect(h.events.some((e) => e.type === 'completed')).toBe(false);
    expect(h.billing.settle).toHaveBeenCalledTimes(1);
  });
  it('empty stop and expired unused ticket release once without provider charges', async () => {
    const h = harness();
    const s = await h.start();
    await h.service.stop(s.sessionId, false);
    await h.service.tick();
    expect(h.billing.release).toHaveBeenCalledTimes(1);
    expect(h.provider.commit).not.toHaveBeenCalled();
    await h.service.create(
      'did:ixo:user',
      'source',
      origin,
      'https://oracle.example',
    );
    vi.setSystemTime(Date.now() + 31000);
    await h.service.tick();
    expect(h.billing.release).toHaveBeenCalledTimes(2);
  });
  it.each([0, 1, 24002])(
    'rejects malformed/oversized PCM length %s before forwarding',
    async (bytes) => {
      const h = harness();
      const s = await h.start();
      await expect(
        h.service.audio(s.sessionId, new ArrayBuffer(bytes)),
      ).rejects.toMatchObject({ code: 'invalid_audio' });
      expect(h.provider.append).not.toHaveBeenCalled();
    },
  );
  it('bounds faster-than-realtime input as well as the total sample limit', async () => {
    const h = harness();
    const s = await h.start();
    for (let i = 0; i < 4; i++)
      await h.service.audio(s.sessionId, new ArrayBuffer(24000));
    await expect(
      h.service.audio(s.sessionId, new ArrayBuffer(24000)),
    ).rejects.toMatchObject({ code: 'audio_limit' });
  });
  it('a lost provider result retains the hold and requires reconciliation, never a guessed charge/refund', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.fail(s.sessionId, 'provider_unavailable');
    expect((await h.journal())?.phase).toBe('reconciliation_required');
    expect(h.billing.settle).not.toHaveBeenCalled();
    expect(h.billing.release).not.toHaveBeenCalled();
    await expect(
      h.service.create(
        'did:ixo:user',
        'source',
        origin,
        'https://oracle.example',
      ),
    ).rejects.toMatchObject({ code: 'session_or_billing_pending' });
  });
  it('rejects duration exceeding server-observed samples', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.stop(s.sessionId, false);
    h.callbacks().completed('text', 9);
    await h.service.tick();
    expect((await h.journal())?.phase).toBe('reconciliation_required');
    expect(h.billing.settle).not.toHaveBeenCalled();
  });
  it('retries a durable pending event after restart without double charging or storing a token', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.stop(s.sessionId, false);
    vi.mocked(h.billing.settle).mockRejectedValueOnce(
      new Error('engine unavailable'),
    );
    h.callbacks().completed('final', 1);
    await h.service.tick();
    expect((await h.journal())?.phase).toBe('pending');
    const first = vi.mocked(h.billing.settle).mock.calls[0]?.[0];
    vi.setSystemTime(Date.now() + 61000);
    const reboot = new TranscriptionService(h.options);
    await reboot.tick();
    expect(vi.mocked(h.billing.settle).mock.calls[1]?.[0]).toEqual(first);
    expect((await h.journal())?.phase).toBe('settled');
    await reboot.tick();
    expect(h.billing.settle).toHaveBeenCalledTimes(2);
  });
  it('crash recovery does not silently release audio without final usage', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await new TranscriptionService(h.options).tick();
    expect((await h.journal())?.phase).toBe('reconciliation_required');
    expect(h.billing.release).not.toHaveBeenCalled();
  });
  it('stops retrying permanent billing failures and retains reconciliation evidence', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.stop(s.sessionId, false);
    vi.mocked(h.billing.settle).mockRejectedValue(
      new TranscriptionBillingError('BILLING_CONFLICT', 'Conflict', 409, false),
    );
    h.callbacks().completed('final', 1);
    await h.service.tick();
    expect((await h.journal())?.phase).toBe('reconciliation_required');
    expect((await h.journal())?.retryAt).toBeUndefined();
    await h.service.tick();
    expect(h.billing.settle).toHaveBeenCalledTimes(1);
  });
  it('stops retries at the engine settlement deadline without dropping usage', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.stop(s.sessionId, false);
    vi.mocked(h.billing.settle).mockRejectedValueOnce(new Error('network'));
    h.callbacks().completed('final', 1);
    await h.service.tick();
    vi.setSystemTime(new Date('2026-10-03T06:00:01Z'));
    await h.service.tick();
    expect((await h.journal())?.phase).toBe('reconciliation_required');
    expect((await h.journal())?.durationSeconds).toBe(1);
    expect(h.billing.settle).toHaveBeenCalledTimes(1);
  });
  it('enforces the daily server allowance before billing admission', async () => {
    const h = harness();
    await h.store.put('transcription:daily', {
      day: '2026-10-02',
      milliseconds: 120000,
    });
    await expect(
      h.service.create(
        'did:ixo:user',
        'source',
        origin,
        'https://oracle.example',
      ),
    ).rejects.toMatchObject({ code: 'daily_limit' });
    expect(h.billing.admit).not.toHaveBeenCalled();
  });
  it('a finalization timeout releases connections but preserves uncertain accounting', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    await h.service.stop(s.sessionId, false);
    await vi.advanceTimersByTimeAsync(15001);
    await h.service.tick();
    expect((await h.journal())?.phase).toBe('reconciliation_required');
    expect(h.provider.close).toHaveBeenCalled();
    h.callbacks().completed('too late', 1);
    await h.service.tick();
    expect(h.events.some((e) => e.type === 'completed')).toBe(false);
  });
  it('keeps a durable watchdog after the original ticket alarm fires during recording', async () => {
    const h = harness();
    const s = await h.start();
    vi.setSystemTime(Date.now() + 31000);
    await h.audio(s.sessionId);
    expect(await h.service.tick()).toBeGreaterThan(Date.now());
    await h.service.stop(s.sessionId, false);
    vi.mocked(h.billing.settle).mockImplementationOnce(async () => {
      const journal = await h.journal();
      expect(journal?.phase).toBe('pending');
      expect(journal?.retryAt).toBeGreaterThan(Date.now());
      expect(h.schedule).toHaveBeenCalledWith(journal?.retryAt);
      throw new Error('simulate lost reply before instance restart');
    });
    h.callbacks().completed('final', 1);
    await h.service.tick();
    vi.setSystemTime(Date.now() + 61000);
    await new TranscriptionService(h.options).tick();
    expect((await h.journal())?.phase).toBe('settled');
  });
  it('disconnect during ticket persistence never opens the provider', async () => {
    const h = harness();
    const s = await h.service.create(
      'did:ixo:user',
      'source',
      origin,
      'https://oracle.example',
    );
    let closed = false;
    h.sink.isClosed = () => closed;
    const put = h.store.put.bind(h.store);
    vi.spyOn(h.store, 'put').mockImplementation(async (key, value) => {
      await put(key, value);
      if (key === TRANSCRIPTION_JOURNAL_KEY) closed = true;
    });
    await expect(
      h.service.attach(s.sessionId, s.ticket, origin, h.sink),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.options.connect).not.toHaveBeenCalled();
    expect(h.billing.release).toHaveBeenCalledTimes(1);
  });
  it('stop persistence failure closes upstream instead of leaving a timerless connection', async () => {
    const h = harness();
    const s = await h.start();
    await h.audio(s.sessionId);
    vi.spyOn(h.store, 'put').mockRejectedValueOnce(
      new Error('storage failure'),
    );
    await expect(h.service.stop(s.sessionId, false)).rejects.toThrow(
      'storage failure',
    );
    expect(h.provider.close).toHaveBeenCalled();
    expect(h.sink.close).toHaveBeenCalled();
    await new TranscriptionService(h.options).tick();
    expect((await h.journal())?.phase).toBe('reconciliation_required');
  });
  it('provider close failure cannot retain the live session or skip browser cleanup', async () => {
    const h = harness();
    const s = await h.start();
    h.provider.close.mockImplementation(() => {
      throw new Error('already gone');
    });
    await h.service.stop(s.sessionId, true);
    expect(h.sink.close).toHaveBeenCalled();
    expect((await h.journal())?.phase).toBe('settled');
    await expect(
      h.service.create(
        'did:ixo:user',
        'source',
        origin,
        'https://oracle.example',
      ),
    ).resolves.toHaveProperty('ticket');
  });
  it('a lost admission response is retried with the same durable reservation identity', async () => {
    const h = harness();
    vi.mocked(h.billing.admit).mockRejectedValueOnce(
      new Error('response lost'),
    );
    await expect(
      h.service.create(
        'did:ixo:user',
        'source-one',
        origin,
        'https://oracle.example',
      ),
    ).rejects.toThrow('response lost');
    const first = vi.mocked(h.billing.admit).mock.calls[0]?.[0];
    const reboot = new TranscriptionService(h.options);
    await reboot.create(
      'did:ixo:user',
      'fresh-source-two',
      origin,
      'https://oracle.example',
    );
    expect(vi.mocked(h.billing.admit).mock.calls[1]?.[0].sessionId).toBe(
      first?.sessionId,
    );
    expect(JSON.stringify([...h.store.data])).not.toContain('source-one');
    expect(JSON.stringify([...h.store.data])).not.toContain('fresh-source-two');
  });
  it('persists only sanitized provider correlation identifiers for reconciliation', async () => {
    const h = harness();
    const s = await h.start();
    h.callbacks().identified?.({
      providerSessionId: 'sess_123',
      providerItemId: 'item_abc',
      providerRequestId: 'req_abc',
    });
    await h.service.tick();
    expect(await h.journal()).toMatchObject({
      providerSessionId: 'sess_123',
      providerItemId: 'item_abc',
      providerRequestId: 'req_abc',
    });
    await h.service.stop(s.sessionId, true);
  });
});
