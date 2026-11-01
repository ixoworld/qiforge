/**
 * Whether an account may log work on a collection: the collection's admin
 * has given it a `SubmitClaimAuthorization` with quota left for that
 * collection. Read from chain REST (`/cosmos/authz/v1beta1/grants`), whose
 * answer for such a grant is
 * `{ "@type": "/ixo.claims.v1beta1.SubmitClaimAuthorization", constraints: [{ collection_id, agent_quota, … }] }`
 * (checked on mainnet, 2026-10-29).
 */
import { IxoAddressSchema } from '@ixo/ixo-transaction';
import { z } from 'zod';
import type { ChainCall, Outcome } from '../ixo-chain/http';
import { restRead } from './reads';

const SUBMIT_AUTHORIZATION = '/ixo.claims.v1beta1.SubmitClaimAuthorization';

const grantsSchema = z.object({
  grants: z
    .array(
      z.object({
        authorization: z
          .object({
            '@type': z.string(),
            constraints: z
              .array(
                z.object({
                  collection_id: z.string().optional(),
                  agent_quota: z.string().optional(),
                }),
              )
              .optional(),
          })
          .passthrough(),
      }),
    )
    .default([]),
});

export async function canLogWork(
  call: ChainCall,
  input: { address: string; admin: string; collectionId: string },
): Promise<Outcome<boolean>> {
  const address = IxoAddressSchema.safeParse(input.address);
  const admin = IxoAddressSchema.safeParse(input.admin);
  if (!address.success || !admin.success) return { ok: true, value: false };
  const read = await restRead(
    call,
    `/cosmos/authz/v1beta1/grants?granter=${admin.data}&grantee=${address.data}&pagination.limit=50`,
    grantsSchema,
    'authz grants',
  );
  if (!read.ok) return read;
  const allowed = read.value.grants.some(
    (grant) =>
      grant.authorization['@type'] === SUBMIT_AUTHORIZATION &&
      (grant.authorization.constraints ?? []).some(
        (c) =>
          c.collection_id === input.collectionId &&
          Number(c.agent_quota ?? 0) > 0,
      ),
  );
  return { ok: true, value: allowed };
}
