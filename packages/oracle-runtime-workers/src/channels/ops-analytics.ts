/**
 * Operations metrics of the channel routes (`POST /channels/turn`,
 * `/channels/control`, `/channels/history`): one Workers Analytics Engine
 * data point per request, and one structured log line per request the route
 * refused or failed. Layout and queries: docs/operations.md#channel-request-metrics.
 *
 * The points use the layout of the IXO ops datasets (`ixo_yo_ops`: index,
 * kind, name, outcome, status, error, campaign, caller; `double1` ms,
 * `double2` 1), under their own index `oracle-runtime`, so an oracle that
 * binds `OPS_ANALYTICS` to such a dataset gets them next to its own points.
 *
 * Optional: without the `OPS_ANALYTICS` binding nothing is written (the log
 * lines still are). Never in the way: `writeDataPoint` is not awaited and is
 * in a `try`; nothing here throws.
 *
 * PRIVACY: fixed names and codes only. Never a DID, binding id, device id,
 * account id, room id, session id, message text, cursor, URL or error
 * message. The log line may carry the history read's request id, which the
 * gateway makes as `web-history:<random uuid>`; any other request id is left
 * out.
 */

/** The part of the Workers `AnalyticsEngineDataset` binding used here. */
export interface OpsAnalyticsDataset {
  writeDataPoint(point: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

/** `index1` of every point the runtime writes. */
export const OPS_RUNTIME_INDEX = 'oracle-runtime';

export const CHANNEL_ROUTES = [
  'POST /channels/turn',
  'POST /channels/control',
  'POST /channels/history',
] as const;
export type ChannelRouteName = (typeof CHANNEL_ROUTES)[number];

/** The log line's stable event name per route. */
const EVENTS: Record<ChannelRouteName, string> = {
  'POST /channels/turn': 'channels.turn',
  'POST /channels/control': 'channels.control',
  'POST /channels/history': 'channels.history',
};

export type ChannelOpsOutcome =
  | 'ok'
  | 'client_error'
  | 'server_error'
  | 'exception';

/** What one channel request did, filled in by the route as it goes. */
export interface ChannelRequestOp {
  route: ChannelRouteName;
  started: number;
  /** The provider of the parsed body (`web`, `whatsapp`, `telegram`, …). */
  provider?: string;
  /** The refusal code the route answered with (`ChannelError.code`). */
  code?: string;
  /** The class name of an error the route did not expect (it answered 503 `unavailable`). */
  thrown?: string;
  /** `/channels/turn` only: a warm object answered a poll (`poll`), else the turn was admitted (`admit`). */
  phase?: 'poll' | 'admit';
  /** Milliseconds spent waiting on the person's object (its RPC calls). */
  objectMs?: number;
  /** `/channels/history` only: items on the page, items carrying a Reply Plan, turns asked for. */
  items?: number;
  plans?: number;
  limit?: number;
  /** `/channels/history` only: the gateway's request id, kept for the log line when it is `web-history:<uuid>`. */
  requestId?: string;
}

const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/;
const HISTORY_REQUEST_ID =
  /^web-history:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDERS = new Set(['web', 'whatsapp', 'telegram']);

/** The route a request is for, or null when it is not a channel route. */
export function channelRouteName(
  method: string,
  path: string,
): ChannelRouteName | null {
  const name = `${method} ${path}`;
  return CHANNEL_ROUTES.find((route) => route === name) ?? null;
}

export function startChannelOp(route: ChannelRouteName): ChannelRequestOp {
  return { route, started: Date.now() };
}

/** Adds what the route learnt to its op (nothing when there is none). */
export function noteChannelOp(
  op: ChannelRequestOp | undefined,
  patch: Partial<Omit<ChannelRequestOp, 'route' | 'started'>>,
): void {
  if (op) Object.assign(op, patch);
}

/**
 * Times one call to the person's object, made by the caller on the stub
 * inside the thunk (`timedObjectCall(op, () => stub.channelHistory(…))`):
 * never a Proxy around a stub, never a method read off it for later. Adds
 * the wait to `op.objectMs`; returns or rethrows exactly what the call did.
 */
export async function timedObjectCall<T>(
  op: ChannelRequestOp | undefined,
  call: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await call();
  } finally {
    if (op) op.objectMs = (op.objectMs ?? 0) + (Date.now() - started);
  }
}

/** `web`, `whatsapp`, `telegram`; `other` for any other provider id; empty when the body did not parse. */
export function channelOpsProvider(provider: string | undefined): string {
  if (provider === undefined) return '';
  return PROVIDERS.has(provider) ? provider : 'other';
}

/** The class name of a thrown value, never its message. Never throws. */
export function thrownClass(error: unknown): string {
  try {
    const name =
      typeof error === 'object' && error !== null && 'name' in error
        ? error.name
        : undefined;
    return typeof name === 'string' && CODE.test(name) ? name : 'NonError';
  } catch {
    return 'NonError';
  }
}

export function channelOpsOutcome(
  status: number,
  thrown: string | undefined,
): ChannelOpsOutcome {
  if (thrown !== undefined) return 'exception';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'ok';
}

const count = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** The data point of one finished channel request (layout in docs/operations.md). */
export function channelOpsPoint(
  op: ChannelRequestOp,
  status: number,
  ms: number,
) {
  const error = op.thrown ?? op.code;
  return {
    indexes: [OPS_RUNTIME_INDEX],
    blobs: [
      'http', // blob1 kind
      op.route, // blob2 name
      channelOpsOutcome(status, op.thrown), // blob3 outcome
      String(status), // blob4 HTTP status
      error && CODE.test(error) ? error : '', // blob5 refusal code or error class
      '', // blob6 campaign (Yo Rewards only)
      'gateway', // blob7 caller: the channel gateway
      channelOpsProvider(op.provider), // blob8 channel
      op.phase ?? '', // blob9 turn phase
    ],
    doubles: [
      count(ms), // double1 duration ms
      1, // double2
      count(op.items), // double3 history: items on the page
      count(op.plans), // double4 history: items carrying a Reply Plan
      count(op.limit), // double5 history: turns asked for
      count(op.objectMs), // double6 ms waiting on the person's object
    ],
  };
}

/**
 * Writes the request's data point and, for a refusal or failure (status 400
 * or more), one log line:
 * `[channel-request] {"event":"channels.history","status":400,"outcome":"client_error","code":"invalid_cursor","provider":"web","ms":12,"objectMs":9,…}`.
 * Never throws, never waits.
 */
export function finishChannelOp(
  op: ChannelRequestOp,
  status: number,
  dataset: OpsAnalyticsDataset | undefined,
): void {
  try {
    const ms = Math.max(0, Date.now() - op.started);
    const point = channelOpsPoint(op, status, ms);
    if (dataset)
      try {
        dataset.writeDataPoint(point);
      } catch {
        // Metrics must never affect the request they measure.
      }
    if (status < 400) return;
    const line = JSON.stringify({
      event: EVENTS[op.route],
      status,
      outcome: point.blobs[2],
      code: point.blobs[4] || undefined,
      provider: point.blobs[7] || undefined,
      phase: op.phase,
      ms,
      objectMs: op.objectMs,
      ...(op.route === 'POST /channels/history'
        ? {
            limit: op.limit,
            requestId:
              op.requestId && HISTORY_REQUEST_ID.test(op.requestId)
                ? op.requestId
                : undefined,
          }
        : {}),
    });
    // eslint-disable-next-line no-console -- console IS the logger on Workers (Logs/observability).
    (status >= 500 ? console.error : console.warn)(`[channel-request] ${line}`);
  } catch {
    // Never in the way.
  }
}
