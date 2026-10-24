import type { HostFacts } from '@ixo/agent-tools';
import type { SourceAuthority, SourceConfig } from '@ixo/agent-tools-sources';
import type { RuntimeContext, UcanDelegation } from '../plugin-api/types';

export function createIxoSourceAuthority(input: {
  ucan: RuntimeContext['ucan'];
  context: HostFacts;
  origins: SourceConfig['origins'];
  storeUrl: string;
  currentDelegation: () => Promise<UcanDelegation | null>;
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
  async function turnInvocation(
    candidate: HostFacts,
    service: 'subscriptions' | 'memory' | 'yellowcard',
    capability: { can: string; with: string },
  ): Promise<string | null> {
    requireContext(candidate);
    if (!input.ucan.hasSigningKey()) return null;
    const delegation = await input.currentDelegation();
    if (!delegation?.raw) return null;
    const result = await input.ucan.createInvocationFromDelegation(
      delegation.raw,
      audiences[service],
      capability,
      { maxTtlSeconds: 60 },
    );
    if ('error' in result) throw new Error('IXO source invocation unavailable');
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
      if (
        !input.ucan.hasSigningKey() ||
        !(await input.currentDelegation())?.raw
      )
        return null;
      const can = action === 'list' ? 'fs/list' : 'fs/read';
      if ((await input.ucan.resolveServiceDid(storeUrl)) !== storeAudience)
        throw new Error('VFS delegation audience mismatch');
      const delegation = await input.ucan.getServiceDelegation(
        context.userDid,
        {
          storeUrl,
          resource: 'ixo:filesystem',
          requiredAbility: can,
          fresh: true,
        },
      );
      if ('error' in delegation) {
        if (delegation.error === 'no-delegation') return null;
        throw new Error('VFS delegation unavailable');
      }
      if (delegation.with !== 'ixo:filesystem') return null;
      const result = await input.ucan.createInvocationFromDelegation(
        delegation.token,
        audiences.vfs,
        { can, with: 'ixo:filesystem' },
        { maxTtlSeconds: 60 },
      );
      if ('error' in result)
        throw new Error('VFS source invocation unavailable');
      return result.invocation;
    },
  };
  return Object.freeze(authority);
}
