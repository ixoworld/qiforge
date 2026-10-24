import { z } from 'zod';
import type { Adapter, HostFacts } from '@ixo/agent-tools';
import {
  available,
  digest,
  evidence,
  guarded,
  instant,
  SourceFailure,
  type SourceHttp,
} from './http.js';

const scope = z.strictObject({
  userDid: z.string(),
  userAddress: z.string(),
  network: z.enum(['devnet', 'testnet', 'mainnet']),
});
const account = z.strictObject({
  representation: z.literal(1),
  scope,
  address: z.string().min(1),
  addressType: z.literal('ixo_account'),
  binding: z.literal('verified_root_did'),
  observedAt: instant,
});
const balance = z.strictObject({
  availability: z.literal('available'),
  ledger: z.strictObject({
    kind: z.literal('subscription_credits'),
    denom: z.literal('upay'),
    baseUnitsPerCredit: z.literal('1000'),
    presentationUnit: z.literal('credits'),
  }),
  account: z.strictObject({
    role: z.literal('subscription_admin'),
    address: z.string().min(1),
  }),
  amountBaseUnits: z
    .string()
    .max(100)
    .regex(/^(0|[1-9][0-9]*)$/),
  credits: z
    .string()
    .max(105)
    .regex(/^(0|[1-9][0-9]*)\.[0-9]{3}$/),
  observedAt: instant,
  source: z.strictObject({
    kind: z.literal('cosmos_bank'),
    chainFreshness: z.literal('unknown'),
  }),
});
const subscription = z.object({ representation: z.literal(2), scope, balance });
function checkScope(source: z.output<typeof scope>, context: HostFacts): void {
  if (
    source.userDid !== context.userDid ||
    source.network !== context.network ||
    context.userDid !== `did:ixo:${source.userAddress}`
  )
    throw new SourceFailure('unauthorized');
}
export function subscriptionAdapters(http: SourceHttp) {
  const ixo_account_get: Adapter<'ixo_account_get'> = ({ context }) =>
    guarded(async () => {
      const data = account.parse(
        await http.request(
          'subscriptions',
          context,
          `/api/v1/subscriptions/account?network=${encodeURIComponent(context.network)}`,
        ),
      );
      checkScope(data.scope, context);
      if (data.address !== data.scope.userAddress)
        throw new SourceFailure('unauthorized');
      return available(
        context,
        {
          address: data.address,
          addressType: data.addressType,
          network: data.scope.network,
          binding: data.binding,
        },
        [
          evidence(
            'account_binding',
            `subscriptions:account:${data.address}`,
            await digest(JSON.stringify(data)),
            data.observedAt,
          ),
        ],
      );
    });
  const ixo_credits_get: Adapter<'ixo_credits_get'> = ({ context }) =>
    guarded(async () => {
      const data = subscription.parse(
        await http.request(
          'subscriptions',
          context,
          `/api/v1/subscriptions?representation=2&network=${encodeURIComponent(context.network)}`,
        ),
      );
      checkScope(data.scope, context);
      const b = data.balance;
      const units = BigInt(b.amountBaseUnits);
      if (
        `${units / 1000n}.${(units % 1000n).toString().padStart(3, '0')}` !==
        b.credits
      )
        throw new SourceFailure('unavailable');
      return available(
        context,
        {
          lookupStatus: 'confirmed',
          amount: b.amountBaseUnits,
          denomination: 'upay',
          decimals: 3,
          ledger: b.ledger.kind,
          network: data.scope.network,
        },
        [
          evidence(
            'subscriptions',
            `subscriptions:balance:${b.account.address}`,
            await digest(JSON.stringify(data)),
            b.observedAt,
          ),
        ],
      );
    });
  return { ixo_account_get, ixo_credits_get };
}
