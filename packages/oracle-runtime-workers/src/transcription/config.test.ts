import { describe, expect, it } from 'vitest';
import { transcriptionRuntimeConfig } from './config';
import type { TranscriptionJournal } from './service';
const meter = {
  serviceSlug: 'voice',
  productSlug: 'dictation',
  metricSlug: 'seconds',
  eventType: 'dictation',
  quantityProperty: 'seconds',
  unit: 'second' as const,
  denom: 'uixo',
  unitPrice: '10',
  rateCardSlug: 'test-rate',
};
const journal: TranscriptionJournal = {
  sessionId: 'session_1',
  userDid: 'did:ixo:user',
  origin: 'https://portal.example',
  ticketHash: '',
  ticketExpiresAt: 1,
  phase: 'pending',
  createdAt: 0,
  day: '2026-10-02',
  reservedMs: 60000,
  audioBytes: 48000,
  durationSeconds: 1,
  occurredAt: '2026-10-02T00:00:00Z',
  admission: {
    reservationId: 'transcription:session_1',
    sessionId: 'session_1',
    userDid: 'did:ixo:user',
    customerId: 'c1',
    maxAudioSeconds: 60,
    maxQuantity: '60',
    maxCharge: '600',
    expiresAt: '2026-10-02T00:15:00Z',
    settleBy: '2026-10-03T00:15:00Z',
    meter,
  },
};
const env = {
  TRANSCRIPTION_ENABLED: 'true',
  TRANSCRIPTION_OPENAI_API_KEY: 'test-key',
  BILLING_ENGINE_URL: 'https://billing.example',
  TRANSCRIPTION_ALLOWED_ORIGINS: 'https://portal.example',
  TRANSCRIPTION_DAILY_SECONDS: '600',
  TRANSCRIPTION_BILLING_METER: JSON.stringify(meter),
};
describe('dictation admission and recovery configuration', () => {
  it('requires enabled, fully configured admission', () => {
    expect(transcriptionRuntimeConfig(env).limits.maxDailyAudioMs).toBe(600000);
    expect(() =>
      transcriptionRuntimeConfig({ ...env, TRANSCRIPTION_ENABLED: 'false' }),
    ).toThrow('disabled');
    expect(() =>
      transcriptionRuntimeConfig({
        ...env,
        TRANSCRIPTION_OPENAI_API_KEY: undefined,
      }),
    ).toThrow('not_configured');
    expect(() =>
      transcriptionRuntimeConfig({
        ...env,
        TRANSCRIPTION_BILLING_METER: undefined,
      }),
    ).toThrow();
  });
  it('continues pending billing recovery with kill switch off and provider/origin/tariff config removed', () => {
    const recovered = transcriptionRuntimeConfig(
      {
        TRANSCRIPTION_ENABLED: 'false',
        BILLING_ENGINE_URL: 'https://billing.example',
      },
      journal,
    );
    expect(recovered.apiKey).toBeUndefined();
    expect(recovered.meter).toEqual(meter);
    expect(recovered.limits.maxDurationMs).toBe(60000);
  });
  it('requires the central billing destination even for recovery', () => {
    expect(() => transcriptionRuntimeConfig({}, journal)).toThrow(
      'billing_unavailable',
    );
  });
  it('uses current valid limits for subsequent admission after a cold recovery', () => {
    expect(
      transcriptionRuntimeConfig(env, journal).limits.maxDailyAudioMs,
    ).toBe(600000);
  });
});
