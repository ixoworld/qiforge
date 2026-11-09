import { CredentialsServiceError, type CredentialsService } from './errors';

/** Longest one call to a service may take (headers and body). */
export const SERVICE_TIMEOUT_MS = 10_000;
/** Longest wait before the one retry; a longer `Retry-After` is not waited out. */
export const MAX_RETRY_WAIT_MS = 5_000;
/** Wait before retrying a 5xx that named no `Retry-After`. */
const DEFAULT_RETRY_WAIT_MS = 500;
/** Largest answer body read from a service. */
const MAX_ANSWER_BYTES = 256 * 1024;

export type FetchLike = (request: Request) => Promise<Response>;

export interface ServiceCall {
  service: CredentialsService;
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  /**
   * The headers and body of ONE attempt. Called again for the retry: a UCAN
   * invocation is single use, so every attempt carries a fresh one.
   */
  prepare: () => Promise<{ headers: Record<string, string>; body?: string }>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Injected for tests (no real waiting). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ServiceAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `Retry-After` in seconds (delta form only; a date is ignored). */
export function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBody(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_ANSWER_BYTES) return null;
  const text = await response.text();
  if (!text || text.length > MAX_ANSWER_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function attempt(call: ServiceCall): Promise<Response> {
  const { headers, body } = await call.prepare();
  const request = new Request(call.url, {
    method: call.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(call.timeoutMs ?? SERVICE_TIMEOUT_MS),
    redirect: 'manual',
  });
  try {
    return await (call.fetchImpl ? call.fetchImpl(request) : fetch(request));
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new CredentialsServiceError({
      service: call.service,
      status: 0,
      code: timedOut ? 'timeout' : 'unreachable',
    });
  }
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * One call, retried once on a 5xx or 429 (after its `Retry-After`, when that
 * is at most {@link MAX_RETRY_WAIT_MS}). A timeout or a network failure is
 * not retried: a POST may have landed. Resolves with any 2xx answer; rejects
 * with {@link CredentialsServiceError} for everything else.
 */
export async function callService(call: ServiceCall): Promise<ServiceAnswer> {
  const sleep = call.sleep ?? defaultSleep;
  let response = await attempt(call);
  if (retryable(response.status)) {
    const after = retryAfterSeconds(response);
    const waitMs = after !== undefined ? after * 1000 : DEFAULT_RETRY_WAIT_MS;
    if (waitMs <= MAX_RETRY_WAIT_MS) {
      // Drain the first answer before the second request.
      await response.body?.cancel().catch(() => undefined);
      await sleep(waitMs);
      response = await attempt(call);
    }
  }
  const body = await readBody(response);
  if (response.status >= 200 && response.status < 300)
    return { status: response.status, body };
  const after = retryAfterSeconds(response);
  throw new CredentialsServiceError({
    service: call.service,
    status: response.status,
    code:
      typeof body?.error === 'string' ? body.error : `http_${response.status}`,
    ...(after !== undefined ? { retryAfterSeconds: after } : {}),
    ...(body ? { body } : {}),
  });
}
