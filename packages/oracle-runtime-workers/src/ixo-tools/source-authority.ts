import type { HostFacts } from '@ixo/agent-tools';
import type { SourceAuthority, SourceConfig } from '@ixo/agent-tools-sources';
import { abilityCovers, resourceCovers } from '../core/runtime-context';
import type { DelegatedCapability } from '../do/ucan-service';
import type { RuntimeContext } from '../plugin-api/types';

export type IxoSourceUcan = Pick<
  RuntimeContext['ucan'],
  | 'hasSigningKey'
  | 'createInvocationFromDelegation'
  | 'resolveServiceDid'
  | 'getServiceDelegation'
>;
export type CurrentSourceDelegation = Readonly<{
  raw: string;
  revision?: object;
  expiration?: number;
  capabilities: readonly DelegatedCapability[];
}>;

export function createIxoSourceAuthority(input: {
  ucan: IxoSourceUcan;
  context: HostFacts;
  origins: SourceConfig['origins'];
  storeUrl: string;
  currentDelegation: () => Promise<CurrentSourceDelegation | null>;
}): SourceAuthority {
  const context = Object.freeze({ ...input.context });
  const origins = Object.freeze({ ...input.origins });
  const storeUrl = input.storeUrl;
  function requireContext(candidate: HostFacts): void {
    if (
      !Object.entries(context).every(
        ([key, value]) => Reflect.get(candidate, key) === value,
      )
    )
      throw new Error('IXO source context mismatch');
  }
  function audience(origin: string): string {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Invalid IXO source origin');
    return `did:web:${url.host.replaceAll(':', '%3A')}`;
  }
  const audiences = Object.freeze({
    subscriptions: audience(origins.subscriptions),
    memory: audience(origins.memory),
    vfs: audience(origins.vfs),
    yellowcard: audience(origins.yellowcard),
  });
  const storeAudience = audience(storeUrl);
  function mintOptions(delegation: CurrentSourceDelegation) {
    if (
      delegation.expiration !== undefined &&
      (!Number.isFinite(delegation.expiration) ||
        delegation.expiration <= Date.now() / 1000)
    )
      return null;
    return {
      maxTtlSeconds: 60,
      ...(delegation.expiration !== undefined
        ? { expiresAt: delegation.expiration }
        : {}),
    };
  }
  async function stillCurrent(
    before: CurrentSourceDelegation,
  ): Promise<boolean> {
    const after = await input.currentDelegation();
    return after?.raw === before.raw && after.revision === before.revision;
  }
  async function turnInvocation(
    candidate: HostFacts,
    service: 'subscriptions' | 'memory' | 'yellowcard',
    capability: { can: string; with: string },
  ): Promise<string | null> {
    requireContext(candidate);
    if (!input.ucan.hasSigningKey()) return null;
    const delegation = await input.currentDelegation();
    if (
      !delegation?.raw ||
      !delegation.capabilities.some(
        (grant) =>
          resourceCovers(grant.with, capability.with) &&
          abilityCovers(grant.can, capability.can),
      )
    )
      return null;
    const options = mintOptions(delegation);
    if (!options) return null;
    const result = await input.ucan.createInvocationFromDelegation(
      delegation.raw,
      audiences[service],
      capability,
      options,
    );
    if ('error' in result) throw new Error('IXO source invocation unavailable');
    if (!(await stillCurrent(delegation))) return null;
    return result.invocation;
  }
  const authority: SourceAuthority = {
    subscriptions: (candidate) =>
      turnInvocation(candidate, 'subscriptions', {
        can: 'subscriptions/read',
        with: 'ixo:subscriptions',
      }),
    memory: (candidate) =>
      turnInvocation(candidate, 'memory', {
        can: 'memory/search',
        with: 'ixo:memory',
      }),
    yellowcard: (candidate, action) =>
      turnInvocation(candidate, 'yellowcard', {
        can:
          action === 'read'
            ? 'yellowcard/agent-read'
            : 'yellowcard/agent-quote',
        with: 'ixo:yellowcard',
      }),
    vfs: async (candidate, action) => {
      requireContext(candidate);
      if (!input.ucan.hasSigningKey()) return null;
      const current = await input.currentDelegation();
      if (!current?.raw) return null;
      const can = action === 'list' ? 'fs/list' : 'fs/read';
      if ((await input.ucan.resolveServiceDid(storeUrl)) !== storeAudience)
        throw new Error('VFS delegation audience mismatch');
      if (!(await stillCurrent(current))) return null;
      const delegation = await input.ucan.getServiceDelegation(
        context.userDid,
        {
          storeUrl,
          resource: 'ixo:filesystem',
          requiredAbility: can,
          fresh: true,
        },
      );
      if (!(await stillCurrent(current))) return null;
      if ('error' in delegation) {
        if (delegation.error === 'no-delegation') return null;
        throw new Error('VFS delegation unavailable');
      }
      if (delegation.with !== 'ixo:filesystem') return null;
      const options = mintOptions(current);
      if (!options) return null;
      const result = await input.ucan.createInvocationFromDelegation(
        delegation.token,
        audiences.vfs,
        { can, with: 'ixo:filesystem' },
        options,
      );
      if ('error' in result)
        throw new Error('VFS source invocation unavailable');
      if (!(await stillCurrent(current))) return null;
      return result.invocation;
    },
  };
  return Object.freeze(authority);
}
