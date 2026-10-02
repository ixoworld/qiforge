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
    connect: vi.fn(async (cb: ProviderCallbacks, _signal: AbortSignal) => {
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

describe('unused admission cancellation', () => {
  const reserve = (h: ReturnType<typeof harness>) =>
    h.service.create(
      'did:ixo:user',
      'source',
      origin,
      'https://oracle.example',
    );

  it('durably releases before an immediate retry without opening the provider', async () => {
    const h = harness();
    const session = await reserve(h);
    vi.mocked(h.billing.release).mockImplementationOnce(async () => {
      const journal = await h.journal();
      expect(journal).toMatchObject({
        sessionId: session.sessionId,
        phase: 'pending',
        durationSeconds: 0,
        audioBytes: 0,
        ticketHash: '',
      });
      expect(journal?.retryAt).toBeGreaterThan(Date.now());
      expect(h.schedule).toHaveBeenLastCalledWith(journal?.retryAt);
    });
    await expect(
      h.service.cancelReservation('did:ixo:user', session.sessionId, origin),
    ).resolves.toEqual({ cancelled: true });
    await expect(
      h.service.cancelReservation('did:ixo:user', session.sessionId, origin),
    ).resolves.toEqual({ cancelled: true });
    expect(h.billing.release).toHaveBeenCalledTimes(1);
    expect(h.billing.settle).not.toHaveBeenCalled();
    expect(h.options.connect).not.toHaveBeenCalled();
    expect(await h.store.get('transcription:daily')).toMatchObject({
      milliseconds: 0,
    });
    const retry = await reserve(h);
    expect(retry.sessionId).not.toBe(session.sessionId);
    await expect(
      h.service.cancelReservation('did:ixo:user', session.sessionId, origin),
    ).resolves.toEqual({ cancelled: false });
    expect((await h.journal())?.sessionId).toBe(retry.sessionId);
    expect((await h.journal())?.phase).toBe('reserved');
    expect(h.billing.release).toHaveBeenCalledTimes(1);
  });

  it('cannot release another user or session, or bypass origin checks on a replay', async () => {
    const h = harness();
    const session = await reserve(h);
    for (const [userDid, sessionId] of [
      ['did:ixo:other', session.sessionId],
      ['did:ixo:user', 'missing_session'],
    ]) {
      await expect(
        h.service.cancelReservation(userDid!, sessionId!, origin),
      ).resolves.toEqual({ cancelled: false });
    }
    for (const invalidOrigin of [null, 'https://evil.example']) {
      await expect(
        h.service.cancelReservation('did:ixo:user', 'missing', invalidOrigin),
      ).rejects.toMatchObject({ code: 'origin_forbidden', status: 403 });
    }
    h.options.limits.allowedOrigins.push('https://other-portal.example');
    await expect(
      h.service.cancelReservation(
        'did:ixo:user',
        session.sessionId,
        'https://other-portal.example',
      ),
    ).rejects.toMatchObject({ code: 'origin_forbidden', status: 403 });
    expect(h.billing.release).not.toHaveBeenCalled();
    expect((await h.journal())?.phase).toBe('reserved');
  });

  it('replays a failed release after restart with the same admission and refunds quota once', async () => {
    const h = harness();
    const session = await reserve(h);
    vi.mocked(h.billing.release).mockRejectedValueOnce(new Error('lost reply'));
    await h.service.cancelReservation(
      'did:ixo:user',
      session.sessionId,
      origin,
    );
    const pending = await h.journal();
    expect(pending?.phase).toBe('pending');
    expect(pending?.durationSeconds).toBe(0);
    const reboot = new TranscriptionService(h.options);
    await reboot.cancelReservation('did:ixo:user', session.sessionId, origin);
    await reboot.cancelReservation('did:ixo:user', session.sessionId, origin);
    expect(h.billing.release).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.billing.release).mock.calls[1]).toEqual(
      vi.mocked(h.billing.release).mock.calls[0],
    );
    expect((await h.journal())?.phase).toBe('settled');
    expect(await h.store.get('transcription:daily')).toMatchObject({
      milliseconds: 0,
    });
    expect(h.options.connect).not.toHaveBeenCalled();
  });

  it('retains failed cancellation for its durable alarm without client replay', async () => {
    const h = harness();
    const session = await reserve(h);
    vi.mocked(h.billing.release).mockRejectedValueOnce(new Error('network'));
    await h.service.cancelReservation(
      'did:ixo:user',
      session.sessionId,
      origin,
    );
    vi.setSystemTime(Date.now() + 61000);
    await new TranscriptionService(h.options).tick();
    expect((await h.journal())?.phase).toBe('settled');
    expect(h.billing.release).toHaveBeenCalledTimes(2);
  });

  it('reports a permanent release failure instead of promising successful cleanup', async () => {
    const h = harness();
    const session = await reserve(h);
    vi.mocked(h.billing.release).mockRejectedValueOnce(
      new TranscriptionBillingError('BILLING_CONFLICT', 'Conflict', 409, false),
    );
    await expect(
      h.service.cancelReservation('did:ixo:user', session.sessionId, origin),
    ).rejects.toMatchObject({
      code: 'session_or_billing_pending',
      status: 409,
    });
    expect((await h.journal())?.phase).toBe('reconciliation_required');
    expect((await h.journal())?.retryAt).toBeUndefined();
    await expect(
      h.service.cancelReservation('did:ixo:user', session.sessionId, origin),
    ).rejects.toMatchObject({ code: 'session_not_cancellable', status: 409 });
    expect(h.billing.release).toHaveBeenCalledTimes(1);
  });

  it.each(['journal', 'alarm'])(
    'never releases before durable %s persistence succeeds',
    async (failure) => {
      const h = harness();
      const session = await reserve(h);
      if (failure === 'journal')
        vi.spyOn(h.store, 'put').mockRejectedValueOnce(new Error('storage'));
      else h.schedule.mockRejectedValueOnce(new Error('storage'));
      await expect(
        h.service.cancelReservation('did:ixo:user', session.sessionId, origin),
      ).rejects.toThrow('storage');
      expect(h.billing.release).not.toHaveBeenCalled();
      await h.service.cancelReservation(
        'did:ixo:user',
        session.sessionId,
        origin,
      );
      expect(h.billing.release).toHaveBeenCalledTimes(1);
      expect((await h.journal())?.phase).toBe('settled');
    },
  );

  it('wins over a queued attach without ever connecting to the provider', async () => {
    const h = harness();
    const session = await reserve(h);
    const cancellation = h.service.cancelReservation(
      'did:ixo:user',
      session.sessionId,
      origin,
    );
    const attaching = h.service.attach(
      session.sessionId,
      session.ticket,
      origin,
      h.sink,
    );
    await expect(cancellation).resolves.toEqual({ cancelled: true });
    await expect(attaching).rejects.toMatchObject({ code: 'invalid_ticket' });
    expect(h.options.connect).not.toHaveBeenCalled();
    expect(h.billing.release).toHaveBeenCalledTimes(1);
  });

  it('cannot cancel an attach that wins the queue even before it receives audio', async () => {
    const h = harness();
    const session = await reserve(h);
    const attaching = h.service.attach(
      session.sessionId,
      session.ticket,
      origin,
      h.sink,
    );
    const cancellation = h.service.cancelReservation(
      'did:ixo:user',
      session.sessionId,
      origin,
    );
    await attaching;
    await expect(cancellation).rejects.toMatchObject({
      code: 'session_not_cancellable',
      status: 409,
    });
    expect(h.billing.release).not.toHaveBeenCalled();
    expect(h.provider.close).not.toHaveBeenCalled();
    expect((await h.journal())?.phase).toBe('listening');
  });

  it('cannot skip an in-flight admission or cancel a newer concurrent reservation', async () => {
    const h = harness();
    const admitted = vi.mocked(h.billing.admit).getMockImplementation()!;
    let begin!: (sessionId: string) => void;
    const admissionStarted = new Promise<string>((resolve) => {
      begin = resolve;
    });
    let finish!: () => void;
    const admissionReady = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(h.billing.admit).mockImplementationOnce(async (input) => {
      begin(input.sessionId);
      await admissionReady;
      return admitted(input);
    });
    const creating = reserve(h);
    const sessionId = await admissionStarted;
    const cancellation = h.service.cancelReservation(
      'did:ixo:user',
      sessionId,
      origin,
    );
    const next = reserve(h);
    finish();
    await creating;
    await expect(cancellation).resolves.toEqual({ cancelled: true });
    const newer = await next;
    expect(newer.sessionId).not.toBe(sessionId);
    expect((await h.journal())?.sessionId).toBe(newer.sessionId);
    expect((await h.journal())?.phase).toBe('reserved');
  });

  it('serializes HTTP cancellation behind provider startup and releases once when the matching socket closes', async () => {
    const h = harness();
    const session = await reserve(h);
    let started!: (signal: AbortSignal) => void;
    const connecting = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    h.options.connect.mockImplementationOnce(
      (_callbacks, signal) =>
        new Promise((_resolve, reject) => {
          started(signal);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const attaching = h.service.attach(
      session.sessionId,
      session.ticket,
      origin,
      h.sink,
    );
    const attachResult = attaching.catch((error: unknown) => error);
    const signal = await connecting;
    await h.service.disconnect(session.sessionId, {
      send: () => undefined,
      close: () => undefined,
    });
    expect(signal.aborted).toBe(false);
    const cancellation = h.service.cancelReservation(
      'did:ixo:user',
      session.sessionId,
      origin,
    );
    expect(h.billing.release).not.toHaveBeenCalled();
    const disconnected = h.service.disconnect(session.sessionId, h.sink);
    await expect(attachResult).resolves.toMatchObject({
      code: 'provider_unavailable',
    });
    await expect(cancellation).resolves.toEqual({ cancelled: true });
    await disconnected;
    expect(signal.aborted).toBe(true);
    expect(h.billing.release).toHaveBeenCalledTimes(1);
    expect(h.billing.settle).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.provider.append).not.toHaveBeenCalled();
    expect((await h.journal())?.phase).toBe('settled');
  });

  it.each<TranscriptionJournal['phase']>([
    'reserved',
    'listening',
    'finalizing',
    'pending',
    'settled',
    'reconciliation_required',
  ])('never releases %s accounting that contains audio', async (phase) => {
    const h = harness();
    const session = await reserve(h);
    const journal = (await h.journal())!;
    await h.store.put(TRANSCRIPTION_JOURNAL_KEY, {
      ...journal,
      phase,
      audioBytes: 48000,
      durationSeconds: 1,
    });
    await expect(
      h.service.cancelReservation('did:ixo:user', session.sessionId, origin),
    ).rejects.toMatchObject({ code: 'session_not_cancellable', status: 409 });
    expect(h.billing.release).not.toHaveBeenCalled();
    expect(h.billing.settle).not.toHaveBeenCalled();
    expect((await h.journal())?.phase).toBe(phase);
  });

  it.each<TranscriptionJournal['phase']>([
    'listening',
    'finalizing',
    'reconciliation_required',
  ])(
    'does not reinterpret unattached %s as an unused reservation after restart',
    async (phase) => {
      const h = harness();
      const session = await reserve(h);
      await h.store.put(TRANSCRIPTION_JOURNAL_KEY, {
        ...(await h.journal()),
        phase,
      });
      await expect(
        new TranscriptionService(h.options).cancelReservation(
          'did:ixo:user',
          session.sessionId,
          origin,
        ),
      ).rejects.toMatchObject({ code: 'session_not_cancellable', status: 409 });
      expect(h.billing.release).not.toHaveBeenCalled();
    },
  );
});
