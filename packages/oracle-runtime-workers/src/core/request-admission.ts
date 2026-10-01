import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import type { MergedConfig } from '../plugin-api/types';
import { baseEnvSchema } from './env';
import type {
  RequestAdmissionContext,
  RequestAdmissionResult,
} from '../plugin-api/request-admission';

export function admissionMetadata(
  json: string | undefined,
): Record<string, unknown> | undefined {
  if (!json || json.length > 16_384) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return { ...parsed };
  } catch {
    return undefined;
  }
  return undefined;
}

/** Per-handler time limit when `REQUEST_ADMISSION_TIMEOUT_MS` is unset. */
export const REQUEST_ADMISSION_TIMEOUT_MS_DEFAULT = 2_000;

/**
 * Core env keys that hold credentials. They never reach an admission handler:
 * the provider keys would let it run inference, the Matrix ones act as the bot.
 */
const CORE_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'OPEN_ROUTER_API_KEY',
  'MATRIX_ORACLE_ADMIN_PASSWORD',
  'MATRIX_RECOVERY_PHRASE',
  'CLOUDFLARE_API_TOKEN',
]);

/**
 * The config one plugin's admission handler sees: the core settings without
 * credentials plus the keys the plugin's own `configSchema` declares. Other
 * plugins' keys (and their secrets) are left out.
 */
export function admissionConfig(
  env: MergedConfig,
  plugin: OraclePlugin,
): MergedConfig {
  const own = new Set(Object.keys(plugin.configSchema?.shape ?? {}));
  const core = new Set(Object.keys(baseEnvSchema.shape));
  const config: MergedConfig = {};
  for (const [key, value] of Object.entries(env)) {
    if (CORE_CREDENTIAL_KEYS.has(key)) continue;
    if (own.has(key) || core.has(key)) config[key] = value;
  }
  return config;
}

export interface AdmitRequestOptions {
  /** The validated merged env; each handler gets its `admissionConfig` slice. */
  env: MergedConfig;
  /** A handler that has not answered by then counts as `pass`. */
  timeoutMs: number;
  warn: (message: string) => void;
}

/** Thrown when a handler fails or returns an invalid answer; the message is for logs only. */
export class RequestAdmissionError extends Error {
  constructor(
    readonly pluginName: string,
    cause: unknown,
  ) {
    super(
      `request admission by ${pluginName} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'RequestAdmissionError';
  }
}

const TIMED_OUT = Symbol('timed-out');

async function askHandler(
  plugin: OraclePlugin,
  context: RequestAdmissionContext,
  timeoutMs: number,
): Promise<RequestAdmissionResult | undefined | typeof TIMED_OUT> {
  const timeout = new AbortController();
  const turn = context.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve, reject) => {
    timer = setTimeout(() => {
      timeout.abort(new Error('request admission timed out'));
      resolve(TIMED_OUT);
    }, timeoutMs);
    onAbort = () =>
      reject(
        turn.reason instanceof Error
          ? turn.reason
          : new Error('request admission aborted', { cause: turn.reason }),
      );
    turn.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      (async () =>
        plugin.getRequestAdmission?.({
          ...context,
          signal: AbortSignal.any([turn, timeout.signal]),
        }))(),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) turn.removeEventListener('abort', onAbort);
  }
}

export async function admitRequest(
  plugins: readonly OraclePlugin[],
  context: Omit<RequestAdmissionContext, 'config'>,
  options: AdmitRequestOptions,
): Promise<RequestAdmissionResult> {
  for (const plugin of plugins) {
    if (!plugin.getRequestAdmission) continue;
    context.signal.throwIfAborted();
    let result: Awaited<ReturnType<typeof askHandler>>;
    try {
      result = await askHandler(
        plugin,
        { ...context, config: admissionConfig(options.env, plugin) },
        options.timeoutMs,
      );
    } catch (error) {
      context.signal.throwIfAborted();
      throw new RequestAdmissionError(plugin.name, error);
    }
    context.signal.throwIfAborted();
    if (result === TIMED_OUT) {
      options.warn(
        `request admission by ${plugin.name} timed out after ${options.timeoutMs} ms; continuing as pass`,
      );
      continue;
    }
    if (result?.kind === 'handled') {
      if (
        !result.text.trim() ||
        !result.title.trim() ||
        result.title.length > 200 ||
        result.text.length > 100_000
      ) {
        throw new RequestAdmissionError(
          plugin.name,
          new Error('invalid direct-read response'),
        );
      }
      return result;
    }
  }
  return { kind: 'pass' };
}
