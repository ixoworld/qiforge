import { describe, expect, it, vi } from 'vitest';
import { cancelTranscriptionReservation } from './cancellation';
import { transcriptionRuntimeConfig } from './config';
import type { TranscriptionBilling } from './billing';
import {
  TRANSCRIPTION_JOURNAL_KEY,
  TranscriptionService,
  type TranscriptionJournal,
  type TranscriptionStore,
} from './service';

const userDid = 'did:ixo:user';
const origin = 'https://portal.example';
const sessionId = 'session_123';

function harness() {
  const journal: TranscriptionJournal = {
    sessionId,
    userDid,
    origin,
    phase: 'reserved',
    ticketHash: 'unused-hash',
    ticketExpiresAt: Date.now() + 30000,
    createdAt: Date.now(),
    day: '2026-10-02',
    reservedMs: 60000,
    audioBytes: 0,
    admission: {
      reservationId: 'reservation_123',
      sessionId,
      userDid,
      customerId: 'c1',
      maxAudioSeconds: 60,
      maxQuantity: '60',
      maxCharge: '600',
      expiresAt: '2026-10-02T23:00:00Z',
      settleBy: '2026-10-03T23:00:00Z',
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
    },
  };
  const data = new Map<string, unknown>([[TRANSCRIPTION_JOURNAL_KEY, journal]]);
  const store: TranscriptionStore = {
    get: async <T>(key: string) =>
      structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
  };
  const billing: TranscriptionBilling = {
    admit: vi.fn(),
    settle: vi.fn(),
    release: vi.fn(async () => undefined),
  };
  const env = {
    TRANSCRIPTION_ENABLED: 'false',
    TRANSCRIPTION_ALLOWED_ORIGINS: `${origin},https://other-portal.example`,
    BILLING_ENGINE_URL: 'https://billing.example',
  };
  const connect = vi.fn(() => Promise.reject(new Error('must not connect')));
  const ready = vi.fn(async () => undefined);
  const service = vi.fn(async (record: TranscriptionJournal) => {
    const { limits } = transcriptionRuntimeConfig(env, record);
    return new TranscriptionService({
      store,
      billing,
      limits,
      connect,
      schedule: async () => undefined,
    });
  });
  const options = { env, store, ready, service };
  const headers = {
    origin,
    'x-transcription-user': userDid,
    'x-identity': JSON.stringify({ userDid, ucanDelegation: 'fresh-proof' }),
  };
  const request = (overrides: Record<string, string> = {}) =>
    new Request(
      `https://user-oracle/transcription/sessions/${sessionId}/cancel`,
      { method: 'POST', headers: { ...headers, ...overrides }, body: '{}' },
    );
  return { options, request, data, journal, billing, connect, ready, service };
}

describe('authenticated Durable Object cancellation route', () => {
  it('releases and replays with admissions disabled and provider/limit/tariff config removed', async () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
      const response = await cancelTranscriptionReservation(
        h.request(),
        sessionId,
        h.options,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ cancelled: true });
    }
    expect(h.ready).toHaveBeenCalledWith({
      userDid,
      ucanDelegation: 'fresh-proof',
    });
    expect(h.billing.release).toHaveBeenCalledTimes(1);
    expect(h.billing.admit).not.toHaveBeenCalled();
    expect(h.billing.settle).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { 'x-transcription-user': '' },
    { 'x-identity': '{}' },
    { 'x-identity': JSON.stringify({ userDid: 'did:ixo:other' }) },
  ])(
    'rejects missing or inconsistent shell identity before reading a reservation',
    async (headers) => {
      const h = harness();
      const read = vi.spyOn(h.options.store, 'get');
      await expect(
        cancelTranscriptionReservation(
          h.request(headers),
          sessionId,
          h.options,
        ),
      ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
      expect(read).not.toHaveBeenCalled();
      expect(h.ready).not.toHaveBeenCalled();
      expect(h.billing.release).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'https://evil.example'])(
    'still verifies origin for missing-session cleanup: %s',
    async (invalidOrigin) => {
      const h = harness();
      h.data.clear();
      await expect(
        cancelTranscriptionReservation(
          h.request({ origin: invalidOrigin }),
          sessionId,
          h.options,
        ),
      ).rejects.toMatchObject({ code: 'origin_forbidden', status: 403 });
      expect(h.ready).not.toHaveBeenCalled();
      expect(h.service).not.toHaveBeenCalled();
    },
  );

  it('checks the recorded origin as well as the current allowlist', async () => {
    const h = harness();
    await expect(
      cancelTranscriptionReservation(
        h.request({ origin: 'https://other-portal.example' }),
        sessionId,
        h.options,
      ),
    ).rejects.toMatchObject({ code: 'origin_forbidden', status: 403 });
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.service).not.toHaveBeenCalled();
  });

  it.each(['missing', 'newer', 'other-user'])(
    'makes %s reservation cleanup a harmless no-op',
    async (kind) => {
      const h = harness();
      if (kind === 'missing') h.data.clear();
      if (kind === 'newer') h.journal.sessionId = 'newer_session';
      if (kind === 'other-user') h.journal.userDid = 'did:ixo:other';
      const response = await cancelTranscriptionReservation(
        h.request(),
        sessionId,
        h.options,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ cancelled: false });
      expect(h.ready).not.toHaveBeenCalled();
      expect(h.service).not.toHaveBeenCalled();
      expect(h.billing.release).not.toHaveBeenCalled();
    },
  );

  it('leaves an attached zero-audio session to its socket lifecycle', async () => {
    const h = harness();
    h.journal.phase = 'listening';
    await expect(
      cancelTranscriptionReservation(h.request(), sessionId, h.options),
    ).rejects.toMatchObject({ code: 'session_not_cancellable', status: 409 });
    expect(h.billing.release).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
});
