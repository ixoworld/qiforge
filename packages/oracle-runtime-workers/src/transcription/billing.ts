/** Direct-user billing. The service must be allowlisted in `direct` charge mode. */
export interface TranscriptionBillingMeter {
  serviceSlug: string;
  productSlug: string;
  metricSlug: string;
  eventType: string;
  quantityProperty: string;
  unit: 'second';
  denom: string;
  unitPrice: string;
  rateCardSlug: string;
  filters?: Record<string, string | number | boolean>;
}

/** Safe to persist in the server's durable session journal; contains no token. */
export interface TranscriptionBillingAdmission {
  reservationId: string;
  sessionId: string;
  userDid: string;
  customerId: string;
  maxAudioSeconds: number;
  maxQuantity: string;
  maxCharge: string;
  expiresAt: string;
  settleBy: string;
  meter: TranscriptionBillingMeter;
}

export interface TranscriptionUsageReceipt {
  eventId: string;
  chargeId: string;
  amount: string;
  denom: string;
  idempotent: boolean;
}

export interface TranscriptionBilling {
  admit(input: {
    /** Recovered by shell authentication, never taken from the request body. */
    userDid: string;
    /** The shell-verified user invocation; used only during this request. */
    sourceInvocation: string;
    sessionId: string;
    maxAudioSeconds: number;
  }): Promise<TranscriptionBillingAdmission>;
  settle(input: {
    admission: TranscriptionBillingAdmission;
    /** Provider-reported duration, checked against server-observed sample limits. */
    measuredAudioSeconds: number;
    occurredAt: string;
  }): Promise<TranscriptionUsageReceipt>;
  /** Only for sessions with confirmed zero provider usage. */
  release(input: { admission: TranscriptionBillingAdmission }): Promise<void>;
}

export interface TranscriptionBillingOptions {
  engineUrl: string;
  meter: TranscriptionBillingMeter;
  /** Mint a NEW self-issued ixo:billing-engine UCAN on EVERY attempt. */
  mintSubmitterInvocation(): Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}

export class TranscriptionBillingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 503,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TranscriptionBillingError';
  }
}

type JsonObject = Record<string, unknown>;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const SESSION_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const MAX_AUDIO_SECONDS = 600;
const MAX_AMOUNT = 2n ** 62n;

function record(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new TranscriptionBillingError(
    'BILLING_PROTOCOL_ERROR',
    'The billing service returned an inconsistent response; reconciliation is required.',
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function amount(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 19 &&
    INTEGER.test(value) &&
    BigInt(value) <= MAX_AMOUNT
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function snapshotMeter(
  meter: TranscriptionBillingMeter,
): TranscriptionBillingMeter {
  const required = [
    meter.serviceSlug,
    meter.productSlug,
    meter.metricSlug,
    meter.eventType,
    meter.quantityProperty,
    meter.denom,
    meter.rateCardSlug,
  ];
  if (
    required.some((field) => !nonempty(field) || field.length > 160) ||
    meter.unit !== 'second' ||
    !amount(meter.unitPrice) ||
    BigInt(meter.unitPrice) <= 0n ||
    ['__proto__', 'constructor', 'prototype'].includes(meter.quantityProperty)
  ) {
    throw new TranscriptionBillingError(
      'INVALID_CONFIGURATION',
      'An approved transcription tariff is required.',
    );
  }
  const filters = { ...meter.filters };
  if (
    Object.hasOwn(filters, meter.quantityProperty) ||
    Object.keys(filters).length > 12 ||
    Object.entries(filters).some(
      ([key, value]) =>
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (typeof value === 'string' && value.length > 160),
    )
  ) {
    throw new TranscriptionBillingError(
      'INVALID_CONFIGURATION',
      'Invalid transcription meter filters.',
    );
  }
  return { ...meter, filters };
}

/** Parse operator-approved configuration; no fallback tariff is invented. */
export function parseTranscriptionBillingMeter(
  raw: string,
): TranscriptionBillingMeter {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TranscriptionBillingError(
      'INVALID_CONFIGURATION',
      'Transcription billing meter must be valid JSON.',
    );
  }
  if (!record(value)) {
    throw new TranscriptionBillingError(
      'INVALID_CONFIGURATION',
      'Transcription billing meter must be an object.',
    );
  }
  const allowed = new Set([
    'serviceSlug',
    'productSlug',
    'metricSlug',
    'eventType',
    'quantityProperty',
    'unit',
    'denom',
    'unitPrice',
    'rateCardSlug',
    'filters',
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.unit !== 'second'
  ) {
    throw new TranscriptionBillingError(
      'INVALID_CONFIGURATION',
      'Transcription billing meter contains unsupported fields or units.',
    );
  }
  const readString = (key: string): string => {
    const field = value[key];
    if (!nonempty(field)) {
      throw new TranscriptionBillingError(
        'INVALID_CONFIGURATION',
        `Transcription billing meter requires ${key}.`,
      );
    }
    return field;
  };
  const filters: Record<string, string | number | boolean> = {};
  if (value.filters !== undefined) {
    if (!record(value.filters)) {
      throw new TranscriptionBillingError(
        'INVALID_CONFIGURATION',
        'Transcription billing filters must be an object.',
      );
    }
    for (const [key, field] of Object.entries(value.filters)) {
      if (
        typeof field !== 'string' &&
        typeof field !== 'number' &&
        typeof field !== 'boolean'
      ) {
        throw new TranscriptionBillingError(
          'INVALID_CONFIGURATION',
          'Transcription billing filters must be primitive values.',
        );
      }
      Object.defineProperty(filters, key, {
        value: field,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return snapshotMeter({
    serviceSlug: readString('serviceSlug'),
    productSlug: readString('productSlug'),
    metricSlug: readString('metricSlug'),
    eventType: readString('eventType'),
    quantityProperty: readString('quantityProperty'),
    unit: 'second',
    denom: readString('denom'),
    unitPrice: readString('unitPrice'),
    rateCardSlug: readString('rateCardSlug'),
    filters,
  });
}

function sameFilters(a: JsonObject, b: JsonObject): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => b[key] === value)
  );
}

function eventProperties(
  meter: TranscriptionBillingMeter,
  seconds: number,
): JsonObject {
  return { ...meter.filters, [meter.quantityProperty]: Math.ceil(seconds) };
}

export function createTranscriptionBilling(
  options: TranscriptionBillingOptions,
): TranscriptionBilling {
  let engine: URL;
  try {
    engine = new URL(options.engineUrl);
  } catch {
    throw new TranscriptionBillingError(
      'INVALID_CONFIGURATION',
      'A billing service HTTPS origin is required.',
    );
  }
  if (
    engine.protocol !== 'https:' ||
    engine.username ||
    engine.password ||
    engine.search ||
    engine.hash ||
    (engine.pathname !== '/' && engine.pathname !== '') ||
    typeof options.mintSubmitterInvocation !== 'function'
  ) {
    throw new TranscriptionBillingError(
      'INVALID_CONFIGURATION',
      'A billing service HTTPS origin and signer are required.',
    );
  }
  const origin = engine.origin;
  const meter = snapshotMeter(options.meter);
  const requestFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  async function request(
    path: string,
    body?: JsonObject,
    sourceInvocation?: string,
  ): Promise<JsonObject> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      let token: string;
      try {
        token = await options.mintSubmitterInvocation();
      } catch {
        throw new TranscriptionBillingError(
          'BILLING_AUTHORIZATION_FAILED',
          'Could not authorize the billing service request.',
        );
      }
      if (!nonempty(token)) {
        throw new TranscriptionBillingError(
          'BILLING_AUTHORIZATION_FAILED',
          'Could not authorize the billing service request.',
        );
      }
      headers.Authorization = `Bearer ${token}`;
      headers['Content-Type'] = 'application/json';
      if (sourceInvocation) headers['X-Source-Invocation'] = sourceInvocation;
    }
    let response: Response;
    try {
      response = await requestFetch(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TranscriptionBillingError(
        'BILLING_UNAVAILABLE',
        'The billing service is unavailable. Retry with the same session identifier.',
        503,
        true,
      );
    }
    if (!response.ok) {
      const status = response.status;
      const code =
        status === 402
          ? 'INSUFFICIENT_CREDITS'
          : status === 401 || status === 403
            ? 'BILLING_AUTHORIZATION_FAILED'
            : status === 409
              ? 'BILLING_CONFLICT'
              : 'BILLING_UNAVAILABLE';
      throw new TranscriptionBillingError(
        code,
        status === 402
          ? 'There are insufficient credits for transcription.'
          : 'The billing service could not accept this request.',
        status === 402 || status === 409 ? status : 503,
        status === 402 || status === 429 || status >= 500,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return invalidResponse();
    }
    if (!record(value)) return invalidResponse();
    return value;
  }

  async function checkCatalog(): Promise<void> {
    const catalog = await request('/v1/services');
    if (!Array.isArray(catalog.services)) return invalidResponse();
    const service = catalog.services.find(
      (item: unknown) => record(item) && item.slug === meter.serviceSlug,
    );
    if (!record(service) || !Array.isArray(service.products)) {
      throw new TranscriptionBillingError(
        'TARIFF_UNAVAILABLE',
        'The approved transcription service is not configured.',
      );
    }
    const product = service.products.find(
      (item: unknown) => record(item) && item.slug === meter.productSlug,
    );
    if (
      !record(product) ||
      !record(product.billable_metric) ||
      !record(product.rate)
    ) {
      throw new TranscriptionBillingError(
        'TARIFF_UNAVAILABLE',
        'The approved transcription tariff is not configured.',
      );
    }
    const metric = product.billable_metric;
    const rate = product.rate;
    if (
      product.unit !== meter.unit ||
      metric.slug !== meter.metricSlug ||
      metric.event_type !== meter.eventType ||
      metric.aggregation !== 'sum' ||
      metric.aggregation_property !== meter.quantityProperty ||
      !record(metric.filters) ||
      !sameFilters(metric.filters, meter.filters ?? {}) ||
      rate.rate_card_slug !== meter.rateCardSlug ||
      rate.unit_price !== meter.unitPrice ||
      rate.currency !== meter.denom
    ) {
      throw new TranscriptionBillingError(
        'TARIFF_CHANGED',
        'The configured transcription tariff no longer matches the billing catalog.',
      );
    }
  }

  function verifyAdmission(admission: TranscriptionBillingAdmission): void {
    if (
      !SESSION_ID.test(admission.sessionId) ||
      admission.reservationId !== `transcription:${admission.sessionId}` ||
      !nonempty(admission.userDid) ||
      !nonempty(admission.customerId) ||
      !Number.isInteger(admission.maxAudioSeconds) ||
      admission.maxAudioSeconds < 1 ||
      admission.maxAudioSeconds > MAX_AUDIO_SECONDS ||
      admission.maxQuantity !== String(admission.maxAudioSeconds) ||
      !amount(admission.maxCharge) ||
      !timestamp(admission.expiresAt) ||
      !timestamp(admission.settleBy) ||
      Date.parse(admission.settleBy) <= Date.parse(admission.expiresAt)
    )
      return invalidResponse();
    snapshotMeter(admission.meter);
  }

  return {
    async admit(input) {
      if (
        !SESSION_ID.test(input.sessionId) ||
        !/^did:ixo:[a-zA-Z0-9:-]+$/.test(input.userDid) ||
        !nonempty(input.sourceInvocation) ||
        !Number.isInteger(input.maxAudioSeconds) ||
        input.maxAudioSeconds < 1 ||
        input.maxAudioSeconds > MAX_AUDIO_SECONDS
      ) {
        throw new TranscriptionBillingError(
          'INVALID_REQUEST',
          'A verified user and bounded transcription session are required.',
          400,
        );
      }
      await checkCatalog();
      const reservationId = `transcription:${input.sessionId}`;
      const response = await request(
        '/v1/reservations',
        {
          reservation_id: reservationId,
          event_type: meter.eventType,
          properties: eventProperties(meter, input.maxAudioSeconds),
          expected: {
            product_slug: meter.productSlug,
            billable_metric_slug: meter.metricSlug,
            unit_price: meter.unitPrice,
            denom: meter.denom,
          },
        },
        input.sourceInvocation,
      );
      if (
        response.reservation_id !== reservationId ||
        response.did !== input.userDid ||
        !nonempty(response.customer_id) ||
        response.service_slug !== meter.serviceSlug ||
        response.product_slug !== meter.productSlug ||
        response.billable_metric_slug !== meter.metricSlug ||
        response.event_type !== meter.eventType ||
        response.unit_price !== meter.unitPrice ||
        response.denom !== meter.denom ||
        response.max_quantity !== String(input.maxAudioSeconds) ||
        !amount(response.amount) ||
        BigInt(response.amount) >
          BigInt(meter.unitPrice) * BigInt(input.maxAudioSeconds) ||
        !timestamp(response.expires_at) ||
        !timestamp(response.settle_by) ||
        Date.parse(response.settle_by) <= Date.parse(response.expires_at)
      )
        return invalidResponse();
      if (
        response.status !== 'held' ||
        Date.parse(response.expires_at) <= now() + input.maxAudioSeconds * 1000
      ) {
        throw new TranscriptionBillingError(
          'BILLING_CONFLICT',
          'This transcription reservation is no longer available. Start a new session.',
          409,
        );
      }
      return {
        reservationId,
        sessionId: input.sessionId,
        userDid: input.userDid,
        customerId: response.customer_id,
        maxAudioSeconds: input.maxAudioSeconds,
        maxQuantity: response.max_quantity,
        maxCharge: response.amount,
        expiresAt: response.expires_at,
        settleBy: response.settle_by,
        meter: { ...meter, filters: { ...meter.filters } },
      };
    },

    async settle({ admission, measuredAudioSeconds, occurredAt }) {
      verifyAdmission(admission);
      if (
        !Number.isFinite(measuredAudioSeconds) ||
        measuredAudioSeconds <= 0 ||
        measuredAudioSeconds > admission.maxAudioSeconds ||
        !timestamp(occurredAt) ||
        Date.parse(occurredAt) > now() + 60_000
      ) {
        throw new TranscriptionBillingError(
          'INVALID_USAGE',
          'A bounded provider-reported audio duration and occurrence time are required.',
          400,
        );
      }
      const admittedMeter = admission.meter;
      const quantity = String(Math.ceil(measuredAudioSeconds));
      const response = await request('/v1/events', {
        transaction_id: admission.reservationId,
        reservation_id: admission.reservationId,
        occurred_at: occurredAt,
        event_type: admittedMeter.eventType,
        properties: eventProperties(admittedMeter, measuredAudioSeconds),
      });
      if (response.rated !== true || !record(response.charge)) {
        throw new TranscriptionBillingError(
          'UNRATED_USAGE',
          'Transcription usage was not charged; reconciliation is required.',
        );
      }
      const charge = response.charge;
      if (
        !nonempty(response.event_id) ||
        !nonempty(charge.id) ||
        response.customer_id !== admission.customerId ||
        response.service_slug !== admittedMeter.serviceSlug ||
        charge.product_slug !== admittedMeter.productSlug ||
        charge.billable_metric_slug !== admittedMeter.metricSlug ||
        charge.quantity !== quantity ||
        charge.unit_price !== admittedMeter.unitPrice ||
        charge.denom !== admittedMeter.denom ||
        !amount(charge.amount) ||
        BigInt(charge.amount) > BigInt(admission.maxCharge) ||
        !nonempty(charge.ledger_entry_id) ||
        typeof response.idempotent !== 'boolean'
      )
        return invalidResponse();
      return {
        eventId: response.event_id,
        chargeId: charge.id,
        amount: charge.amount,
        denom: admittedMeter.denom,
        idempotent: response.idempotent,
      };
    },

    async release({ admission }) {
      verifyAdmission(admission);
      const response = await request(
        `/v1/reservations/${encodeURIComponent(admission.reservationId)}/release`,
        {},
      );
      if (
        response.reservation_id !== admission.reservationId ||
        !['released', 'expired', 'committed'].includes(
          String(response.status),
        ) ||
        typeof response.idempotent !== 'boolean'
      )
        return invalidResponse();
    },
  };
}
