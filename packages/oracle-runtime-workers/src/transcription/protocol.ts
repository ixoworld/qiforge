/** Browser-facing dictation protocol. No provider events are accepted from clients. */
export const PCM_RATE = 24_000;
export const PCM_BYTES_PER_SECOND = PCM_RATE * 2;
export const MAX_FRAME_BYTES = 24_000;
export const MAX_QUEUED_BYTES = 96_000;
export const TICKET_TTL_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 10_000;
export const FINAL_TIMEOUT_MS = 15_000;

export type TranscriptionEvent =
  | { type: 'ready' }
  | { type: 'delta'; text: string }
  | { type: 'completed'; text: string }
  | { type: 'error'; code: string };

export class TranscriptionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 503,
  ) {
    super(code);
  }
}

export interface TranscriptionLimits {
  maxDurationMs: number;
  maxDailyAudioMs: number;
  allowedOrigins: string[];
}

export function readTranscriptionLimits(env: {
  TRANSCRIPTION_ENABLED?: string;
  TRANSCRIPTION_ALLOWED_ORIGINS?: string;
  TRANSCRIPTION_MAX_SECONDS?: string;
  TRANSCRIPTION_DAILY_SECONDS?: string;
}): TranscriptionLimits {
  if (env.TRANSCRIPTION_ENABLED !== 'true')
    throw new TranscriptionError('disabled', 404);
  const maxSeconds = Number(env.TRANSCRIPTION_MAX_SECONDS ?? '60');
  const dailySeconds = Number(env.TRANSCRIPTION_DAILY_SECONDS);
  const origins = (env.TRANSCRIPTION_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !Number.isSafeInteger(maxSeconds) ||
    maxSeconds < 1 ||
    maxSeconds > 300 ||
    !Number.isSafeInteger(dailySeconds) ||
    dailySeconds < maxSeconds ||
    dailySeconds > 86400 ||
    !origins.length ||
    origins.some((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol !== 'https:' || url.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    throw new TranscriptionError('not_configured');
  return {
    maxDurationMs: maxSeconds * 1000,
    maxDailyAudioMs: dailySeconds * 1000,
    allowedOrigins: origins,
  };
}

export function assertOrigin(
  origin: string | null,
  limits: TranscriptionLimits,
): string {
  if (!origin || !limits.allowedOrigins.includes(origin))
    throw new TranscriptionError('origin_forbidden', 403);
  return origin;
}

export async function ticketDigest(ticket: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(ticket),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function jsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TranscriptionError('invalid_message', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TranscriptionError('invalid_message', 400);
  return value as Record<string, unknown>;
}

/** Preserve the oracle SDK's RequestError shape, while exposing safe codes only. */
export function transcriptionHttpError(code: string, status: number): Response {
  return Response.json(
    { code, error: code, statusCode: status, message: code },
    {
      status,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
