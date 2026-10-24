import { z } from 'zod';
import type { Adapter, HostFacts, ResourceReceipt } from '@ixo/agent-tools';
import {
  available,
  digest,
  evidence,
  guarded,
  instant,
  revision,
  SourceFailure,
  type SourceHttp,
} from './http.js';

const response = z.strictObject({
  representation: z.literal(1),
  scope: z.strictObject({ userDid: z.string(), network: z.string() }),
  observedAt: instant,
  revision,
  value: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
});
const quote = z.strictObject({
  quoteId: z.string().min(1),
  quoteScope: z.literal('corridor'),
  asset: z.literal('USDC'),
  corridor: z.string(),
  amount: z.string(),
  payoutAmount: z.string(),
  payoutCurrency: z.string(),
  rate: z.string(),
  fee: z.string(),
  denomination: z.literal('USDC'),
  expiresAt: instant,
});
const operation = z.strictObject({
  operationId: z.string(),
  state: z.enum(['pending', 'completed', 'failed', 'unknown']),
});
const error = z.strictObject({
  errorId: z.string(),
  explanation: z.string(),
  permittedNextSteps: z.array(z.string()),
});
const options = z.strictObject({
  eligibility: z.enum(['eligible', 'ineligible', 'unknown']),
  corridors: z.array(z.string()).max(100),
});
const PUBLIC_ERRORS = [
  {
    code: 'INSUFFICIENT_FUNDS',
    explanation:
      'The operation requires more available funds than the selected account currently has.',
    next: [
      'Read the current balance and fee estimate before reviewing the operation again.',
    ],
  },
  {
    code: 'UNAUTHORIZED',
    explanation: 'The service did not authorize this request.',
    next: ['Review the account and delegated permissions in the Portal.'],
  },
  {
    code: 'RATE_LIMITED',
    explanation: 'The service has temporarily limited the request rate.',
    next: ['Wait before retrying the read.'],
  },
] as const;
export function yellowcardAdapters(http: SourceHttp) {
  async function read(
    context: HostFacts,
    path: string,
    body?: unknown,
    action: 'read' | 'quote' = 'read',
  ) {
    const data = response.parse(
      await http.request('yellowcard', context, path, body, action),
    );
    if (
      data.scope.userDid !== context.userDid ||
      data.scope.network !== context.network
    )
      throw new SourceFailure('unauthorized');
    return data;
  }
  const ixo_offramp_options: Adapter<'ixo_offramp_options'> = ({
    context,
    input,
  }) =>
    guarded(async () => {
      const data = await read(
        context,
        `/agent/options${input.country ? `?country=${encodeURIComponent(input.country)}` : ''}`,
      );
      if (
        data.metadata.eligibilityScope !== 'corridor' ||
        data.metadata.kycEligibility !== 'unknown' ||
        data.metadata.country !== (input.country ?? null)
      )
        throw new SourceFailure('unavailable');
      const value = options.parse(data.value);
      if (value.eligibility === 'eligible' && data.metadata.source !== 'live')
        throw new SourceFailure('unavailable');
      return available(context, value, [
        evidence(
          'offramp',
          `yellowcard:options:${input.country ?? 'all'}`,
          data.revision,
          data.observedAt,
        ),
      ]);
    });
  const quoteInvoke: Adapter<'ixo_offramp_quote'> = ({ context, input }) =>
    guarded(async () => {
      const data = await read(context, '/agent/quote', input, 'quote');
      const value = quote.parse(data.value);
      if (
        data.metadata.kind !== 'estimate' ||
        data.metadata.settlementLocked !== false ||
        data.metadata.cryptoNetwork !== 'BASE'
      )
        throw new SourceFailure('unavailable');
      return available(context, value, [
        evidence('offramp', value.quoteId, data.revision, data.observedAt),
      ]);
    });
  const ixo_operation_get: Adapter<'ixo_operation_get'> = ({
    context,
    input,
  }) =>
    guarded(async () => {
      const data = await read(
        context,
        `/agent/operations/${encodeURIComponent(input.operationId)}`,
      );
      const value = operation.parse(data.value);
      return available(context, value, [
        evidence(
          'operation',
          value.operationId,
          data.revision,
          data.observedAt,
        ),
      ]);
    });
  const ixo_error_explain: Adapter<'ixo_error_explain'> = ({
    context,
    input,
  }) =>
    guarded(async () => {
      if ('errorText' in input) {
        const known = PUBLIC_ERRORS.find(
          (entry) => entry.code === input.errorText,
        );
        const value = {
          errorText: input.errorText,
          explanation:
            known?.explanation ??
            'This supplied error text has no reviewed IXO explanation. Its cause has not been established.',
          permittedNextSteps: known
            ? [...known.next]
            : [
                'Read the owned operation status or consult the service support channel with the error reference.',
              ],
        };
        return available(context, value, [
          evidence(
            'error_catalog',
            'ixo:error-catalog:v1',
            await digest(JSON.stringify(PUBLIC_ERRORS)),
            new Date().toISOString(),
          ),
        ]);
      }
      const data = await read(
        context,
        `/agent/errors/${encodeURIComponent(input.errorId)}`,
      );
      const value = error.parse(data.value);
      return available(context, value, [
        evidence(
          'operation_error',
          value.errorId,
          data.revision,
          data.observedAt,
        ),
      ]);
    });
  async function current(
    context: HostFacts,
    receipt: ResourceReceipt,
  ): Promise<boolean> {
    const path =
      receipt.source === 'operation' ? '/agent/operations/' : '/agent/errors/';
    const data = await read(
      context,
      `${path}${encodeURIComponent(receipt.reference)}`,
    );
    const value =
      receipt.source === 'operation'
        ? operation.parse(data.value)
        : error.parse(data.value);
    const id = 'operationId' in value ? value.operationId : value.errorId;
    return id === receipt.reference && data.revision === receipt.revision;
  }
  return {
    adapters: {
      ixo_offramp_options,
      ixo_offramp_quote: { reviewed: true as const, invoke: quoteInvoke },
      ixo_operation_get,
      ixo_error_explain,
    },
    current,
  };
}
