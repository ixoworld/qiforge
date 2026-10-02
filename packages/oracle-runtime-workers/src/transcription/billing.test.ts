import { describe, expect, it, vi } from 'vitest';
import {
  createTranscriptionBilling,
  parseTranscriptionBillingMeter,
  type TranscriptionBillingAdmission,
  type TranscriptionBillingMeter,
} from './billing';

const NOW = Date.parse('2026-10-02T05:00:00.000Z');
const METER: TranscriptionBillingMeter = {
  serviceSlug: 'dictation',
  productSlug: 'audio',
  metricSlug: 'audio.seconds',
  eventType: 'audio.transcribed',
  quantityProperty: 'audio_seconds',
  unit: 'second',
  denom: 'uixo',
  unitPrice: '7',
  rateCardSlug: 'standard-v1',
  filters: { model: 'approved-model' },
};
const INPUT = {
  userDid: 'did:ixo:alice',
  sourceInvocation: 'verified-source-token',
  sessionId: 'session_12345678',
  maxAudioSeconds: 60,
};
const RESERVATION_ID = `transcription:${INPUT.sessionId}`;

function catalog() {
  return {
    services: [
      {
        slug: METER.serviceSlug,
        products: [
          {
            slug: METER.productSlug,
            unit: 'second',
            billable_metric: {
              slug: METER.metricSlug,
              event_type: METER.eventType,
              aggregation: 'sum',
              aggregation_property: METER.quantityProperty,
              filters: { model: 'approved-model' },
            },
            rate: {
              rate_card_slug: METER.rateCardSlug,
              unit_price: METER.unitPrice,
              currency: METER.denom,
            },
          },
        ],
      },
    ],
  };
}

function reservation() {
  return {
    reservation_id: RESERVATION_ID,
    customer_id: 'customer-alice',
    did: INPUT.userDid,
    service_slug: METER.serviceSlug,
    product_slug: METER.productSlug,
    billable_metric_slug: METER.metricSlug,
    event_type: METER.eventType,
    max_quantity: '60',
    unit_price: METER.unitPrice,
    amount: '420',
    denom: METER.denom,
    expires_at: new Date(NOW + 900_000).toISOString(),
    settle_by: new Date(NOW + 900_000 + 86_400_000).toISOString(),
    status: 'held',
    idempotent: false,
  };
}

function admission(): TranscriptionBillingAdmission {
  const receipt = reservation();
  return {
    reservationId: RESERVATION_ID,
    sessionId: INPUT.sessionId,
    userDid: INPUT.userDid,
    customerId: receipt.customer_id,
    maxAudioSeconds: INPUT.maxAudioSeconds,
    maxQuantity: receipt.max_quantity,
    maxCharge: receipt.amount,
    expiresAt: receipt.expires_at,
    settleBy: receipt.settle_by,
    meter: { ...METER, filters: { ...METER.filters } },
  };
}

function charge() {
  return {
    event_id: 'event-audio',
    customer_id: 'customer-alice',
    service_slug: METER.serviceSlug,
    charge: {
      id: 'charge-audio',
      product_slug: METER.productSlug,
      billable_metric_slug: METER.metricSlug,
      quantity: '13',
      unit_price: METER.unitPrice,
      amount: '91',
      denom: METER.denom,
      ledger_entry_id: 'ledger-audio',
    },
    rated: true,
    idempotent: false,
  };
}

function setup(responses: Response[] = []) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  let nonce = 0;
  const mint = vi.fn(async () => `service-token-${++nonce}`);
  return {
    fetcher,
    mint,
    billing: createTranscriptionBilling({
      engineUrl: 'https://billing.example',
      meter: METER,
      mintSubmitterInvocation: mint,
      fetch: fetcher,
      now: () => NOW,
    }),
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const USAGE = {
  admission: admission(),
  measuredAudioSeconds: 12.25,
  occurredAt: new Date(NOW).toISOString(),
};

describe('transcription billing adapter', () => {
  it('strictly parses the approved operator meter without coercion or unknown fields', () => {
    expect(parseTranscriptionBillingMeter(JSON.stringify(METER))).toEqual(
      METER,
    );
    for (const raw of [
      '',
      '{}',
      'null',
      '[]',
      JSON.stringify({ ...METER, unitPrice: 7 }),
      JSON.stringify({ ...METER, typo: true }),
      JSON.stringify({ ...METER, filters: { nested: {} } }),
      JSON.stringify({ ...METER, filters: { constructor: 'bad' } }),
    ]) {
      expect(() => parseTranscriptionBillingMeter(raw)).toThrow();
    }
  });
  it('checks the catalog and reserves the authenticated user without persisting their token', async () => {
    const { billing, fetcher, mint } = setup([
      json(catalog()),
      json(reservation()),
    ]);
    const result = await billing.admit(INPUT);
    expect(result).toEqual(admission());
    expect(JSON.stringify(result)).not.toContain(INPUT.sourceInvocation);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://billing.example/v1/services',
    );
    const request = fetcher.mock.calls[1]?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get('X-Source-Invocation')).toBe(INPUT.sourceInvocation);
    expect(headers.get('Authorization')).toBe('Bearer service-token-1');
    expect(request?.redirect).toBe('error');
    expect(JSON.parse(String(request?.body))).toEqual({
      reservation_id: RESERVATION_ID,
      event_type: METER.eventType,
      properties: { model: 'approved-model', audio_seconds: 60 },
      expected: {
        product_slug: METER.productSlug,
        billable_metric_slug: METER.metricSlug,
        unit_price: '7',
        denom: 'uixo',
      },
    });
  });

  it('re-admits a stable session with a fresh user proof without changing the reservation request', async () => {
    const { billing, fetcher, mint } = setup([
      json(catalog()),
      json(reservation()),
      json(catalog()),
      json({ ...reservation(), idempotent: true }),
    ]);
    const first = await billing.admit(INPUT);
    const second = await billing.admit({
      ...INPUT,
      sourceInvocation: 'fresh-verified-source-token',
    });
    expect(second).toEqual(first);
    const initial = fetcher.mock.calls[1]?.[1];
    const retry = fetcher.mock.calls[3]?.[1];
    expect(initial?.body).toBe(retry?.body);
    expect(new Headers(initial?.headers).get('X-Source-Invocation')).toBe(
      INPUT.sourceInvocation,
    );
    expect(new Headers(retry?.headers).get('X-Source-Invocation')).toBe(
      'fresh-verified-source-token',
    );
    expect(new Headers(initial?.headers).get('Authorization')).toBe(
      'Bearer service-token-1',
    );
    expect(new Headers(retry?.headers).get('Authorization')).toBe(
      'Bearer service-token-2',
    );
    expect(mint).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(second)).not.toContain('source-token');
  });

  it.each([
    ['wrong payer', { did: 'did:ixo:mallory' }],
    ['wrong service', { service_slug: 'sandbox' }],
    ['wrong quantity', { max_quantity: '61' }],
    ['wrong metric', { billable_metric_slug: 'other' }],
    ['larger charge', { amount: '421' }],
    ['wrong price', { unit_price: '8' }],
    ['wrong currency', { denom: 'uatom' }],
    ['missing settlement deadline', { settle_by: undefined }],
  ])('rejects reservation receipts with %s', async (_reason, change) => {
    const { billing } = setup([
      json(catalog()),
      json({ ...reservation(), ...change }),
    ]);
    await expect(billing.admit(INPUT)).rejects.toMatchObject({
      code: 'BILLING_PROTOCOL_ERROR',
    });
  });

  it.each(['committed', 'released', 'expired'])(
    'does not start on a %s reservation',
    async (status) => {
      const { billing } = setup([
        json(catalog()),
        json({ ...reservation(), status }),
      ]);
      await expect(billing.admit(INPUT)).rejects.toMatchObject({
        code: 'BILLING_CONFLICT',
      });
    },
  );

  it('fails closed before reservation if the approved tariff is unavailable or changes', async () => {
    const absent = setup([json({ services: [] })]);
    await expect(absent.billing.admit(INPUT)).rejects.toMatchObject({
      code: 'TARIFF_UNAVAILABLE',
    });
    expect(absent.mint).not.toHaveBeenCalled();
    const changed = catalog();
    const product = changed.services[0]?.products[0];
    if (!product) throw new Error('Missing fixture product');
    product.rate.unit_price = '8';
    const { billing, mint } = setup([json(changed)]);
    await expect(billing.admit(INPUT)).rejects.toMatchObject({
      code: 'TARIFF_CHANGED',
    });
    expect(mint).not.toHaveBeenCalled();
  });

  it('settles only measured duration against the original reservation and verifies its ledger receipt', async () => {
    const { billing, fetcher } = setup([json(charge())]);
    await expect(billing.settle(USAGE)).resolves.toEqual({
      eventId: 'event-audio',
      chargeId: 'charge-audio',
      amount: '91',
      denom: 'uixo',
      idempotent: false,
    });
    const request = fetcher.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).has('X-Source-Invocation')).toBe(
      false,
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      reservation_id: RESERVATION_ID,
      transaction_id: RESERVATION_ID,
      occurred_at: USAGE.occurredAt,
      event_type: METER.eventType,
      properties: { model: 'approved-model', audio_seconds: 13 },
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(
      INPUT.sourceInvocation,
    );
  });

  it('retries a lost response with the same event and a fresh bearer', async () => {
    const { billing, fetcher, mint } = setup();
    fetcher.mockRejectedValueOnce(new Error('response lost'));
    fetcher.mockResolvedValueOnce(json({ ...charge(), idempotent: true }));
    await expect(billing.settle(USAGE)).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
      retryable: true,
    });
    await expect(billing.settle(USAGE)).resolves.toMatchObject({
      idempotent: true,
    });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      fetcher.mock.calls[1]?.[1]?.body,
    );
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer service-token-1');
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer service-token-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('never treats an unrated event as a successful charge', async () => {
    const { billing } = setup([
      json({ ...charge(), rated: false, charge: null }),
    ]);
    await expect(billing.settle(USAGE)).rejects.toMatchObject({
      code: 'UNRATED_USAGE',
    });
  });

  it.each([
    ['wrong customer', { customer_id: 'other-customer' }, {}],
    ['wrong service', { service_slug: 'sandbox' }, {}],
    ['wrong quantity', {}, { quantity: '14' }],
    ['wrong metric', {}, { billable_metric_slug: 'wrong' }],
    ['wrong price', {}, { unit_price: '8' }],
    ['over reserved amount', {}, { amount: '421' }],
    ['missing ledger entry', {}, { ledger_entry_id: '' }],
  ])(
    'rejects %s in the event receipt',
    async (_reason, change, chargeChange) => {
      const response = charge();
      const { billing } = setup([
        json({
          ...response,
          ...change,
          charge: { ...response.charge, ...chargeChange },
        }),
      ]);
      await expect(billing.settle(USAGE)).rejects.toMatchObject({
        code: 'BILLING_PROTOCOL_ERROR',
      });
    },
  );

  it.each([0, -1, NaN, Infinity, 61])(
    'rejects invalid measured duration %s before a request',
    async (measuredAudioSeconds) => {
      const { billing, fetcher } = setup();
      await expect(
        billing.settle({ ...USAGE, measuredAudioSeconds }),
      ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([0, 0.5, 601, NaN])(
    'rejects invalid maximum duration %s',
    async (maxAudioSeconds) => {
      const { billing, fetcher } = setup();
      await expect(
        billing.admit({ ...INPUT, maxAudioSeconds }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('leaves insufficient-credit settlements retryable and never releases them', async () => {
    const { billing, fetcher } = setup([json({ error: 'usage blocked' }, 402)]);
    await expect(billing.settle(USAGE)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      status: 402,
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['released', 'expired', 'committed'])(
    'accepts an idempotent %s release receipt without user credentials',
    async (status) => {
      const { billing, fetcher } = setup([
        json({ reservation_id: RESERVATION_ID, status, idempotent: true }),
      ]);
      await expect(
        billing.release({ admission: admission() }),
      ).resolves.toBeUndefined();
      expect(fetcher.mock.calls[0]?.[0]).toContain(
        '/v1/reservations/transcription%3Asession_12345678/release',
      );
      expect(
        new Headers(fetcher.mock.calls[0]?.[1]?.headers).has(
          'X-Source-Invocation',
        ),
      ).toBe(false);
    },
  );

  it('rejects unsafe service origins and incomplete or mutable tariff configuration', () => {
    for (const engineUrl of [
      'http://billing.example',
      'https://user:password@billing.example',
      'https://billing.example/other',
      'https://billing.example?token=secret',
    ]) {
      expect(() =>
        createTranscriptionBilling({
          engineUrl,
          meter: METER,
          mintSubmitterInvocation: async () => '',
        }),
      ).toThrow();
    }
    expect(() =>
      createTranscriptionBilling({
        engineUrl: 'https://billing.example',
        meter: { ...METER, unitPrice: '0' },
        mintSubmitterInvocation: async () => '',
      }),
    ).toThrow();
    expect(() =>
      createTranscriptionBilling({
        engineUrl: 'https://billing.example',
        meter: { ...METER, filters: { audio_seconds: 999 } },
        mintSubmitterInvocation: async () => '',
      }),
    ).toThrow();
  });
});
