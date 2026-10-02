import { parseTranscriptionBillingMeter } from './billing';
import { readTranscriptionLimits, TranscriptionError } from './protocol';
import type { TranscriptionJournal } from './service';

export interface TranscriptionEnvironment {
  TRANSCRIPTION_ENABLED?: string;
  TRANSCRIPTION_ALLOWED_ORIGINS?: string;
  TRANSCRIPTION_MAX_SECONDS?: string;
  TRANSCRIPTION_DAILY_SECONDS?: string;
  TRANSCRIPTION_OPENAI_API_KEY?: string;
  TRANSCRIPTION_BILLING_METER?: string;
  BILLING_ENGINE_URL?: string;
}

/** The admission kill switch must never strand previously accepted usage. */
export function transcriptionRuntimeConfig(
  env: TranscriptionEnvironment,
  recovery?: TranscriptionJournal,
) {
  const apiKey = env.TRANSCRIPTION_OPENAI_API_KEY;
  const engineUrl = env.BILLING_ENGINE_URL;
  if (!engineUrl) throw new TranscriptionError('billing_unavailable');
  if (!recovery && !apiKey) throw new TranscriptionError('not_configured');
  let limits;
  try {
    limits = readTranscriptionLimits(env);
  } catch (error) {
    if (!recovery) throw error;
    limits = {
      maxDurationMs: recovery.reservedMs,
      maxDailyAudioMs: recovery.reservedMs,
      allowedOrigins: [recovery.origin],
    };
  }
  let meter;
  try {
    meter = parseTranscriptionBillingMeter(
      env.TRANSCRIPTION_BILLING_METER ?? '',
    );
  } catch (error) {
    if (!recovery) throw error;
    meter = recovery.admission.meter;
  }
  return { apiKey, engineUrl, limits, meter };
}
