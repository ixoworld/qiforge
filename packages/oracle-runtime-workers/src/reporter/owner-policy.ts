import { z } from 'zod';
import type { WorkersUcanService } from '../do/ucan-service';
import { ReporterError } from './contracts';

const policySchema = z.strictObject({
  version: z.literal(1),
  privateOwnerState: z.literal(true),
  root: z.literal('/.oracles'),
});
export async function requirePrivateOwnerState(
  ucan: WorkersUcanService,
  delegation: string,
  baseUrl: string,
): Promise<void> {
  const minted = await ucan.createInvocationFromDelegation(
    delegation,
    baseUrl,
    {
      can: 'fs/list',
      with: 'ixo:filesystem/.oracles',
      nb: { hidden: ['/.oracles'] },
    },
    { maxTtlSeconds: 60 },
  );
  if ('error' in minted)
    throw new ReporterError(403, 'Private owner state authority unavailable');
  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/v1/reporter/owner-state-policy`,
    {
      headers: {
        authorization: `Bearer ${minted.invocation}`,
        'x-auth-type': 'ucan',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok || !policySchema.safeParse(await response.json()).success)
    throw new ReporterError(503, 'Private owner state policy unavailable');
}
