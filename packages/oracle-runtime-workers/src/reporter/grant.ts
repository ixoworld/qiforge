import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { listDelegationCapabilities } from '../do/ucan-service';

const identitySchema = z.object({
  userDid: z.string().min(1),
  ucanDelegation: z.string().min(1),
  ucanDelegationExpiration: z.number().int(),
});
const abilities = new Set(['fs/list', 'fs/read', 'fs/write', 'fs/delete']);
export async function reporterGrant(rawIdentity: string | null) {
  try {
    const identity = identitySchema.parse(JSON.parse(rawIdentity ?? 'null'));
    const now = Math.floor(Date.now() / 1000);
    if (
      identity.ucanDelegationExpiration <= now ||
      identity.ucanDelegationExpiration > now + 60
    )
      return null;
    const grants = await listDelegationCapabilities(identity.ucanDelegation);
    if (
      !grants.length ||
      grants.some(
        (g) =>
          !abilities.has(g.can) ||
          g.with !== 'ixo:filesystem/.oracles' ||
          !g.nb ||
          JSON.stringify(g.nb.hidden) !== '["/.oracles"]',
      )
    )
      return null;
    if ([...abilities].some((a) => !grants.some((g) => g.can === a)))
      return null;
    return identity;
  } catch {
    return null;
  }
}

export class ReporterAuthority {
  private readonly scope = new AsyncLocalStorage<{ raw: string }>();
  getStore() {
    return this.scope.getStore();
  }
  run<T>(grant: { raw: string }, callback: () => T): T {
    return this.scope.run(grant, callback);
  }
  ownerDelegation(shared: () => string | undefined): string | undefined {
    const local = this.scope.getStore();
    return local ? local.raw : shared();
  }
}
