import { describe, expect, it, vi } from 'vitest';
import { mintVfsBearerFor, type VfsDelegationMinter } from './vfs-auth.js';

const URLS = {
  VFS_BASE_URL: 'https://devnet.vfs.ixo.earth',
  UCAN_STORE_URL: 'https://devnet.store.ucan.ixo.earth',
};

function minter(
  overrides: Partial<VfsDelegationMinter> = {},
): VfsDelegationMinter {
  return {
    getServiceDelegation: vi.fn(async () => ({
      token: 'CAR',
      with: 'ixo:filesystem/oracle-data/did:ixo:entity:abc',
    })),
    createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'INV' })),
    ...overrides,
  };
}

describe('mintVfsBearerFor', () => {
  it('mints an invocation attenuated to the granted resource', async () => {
    const m = minter();
    const result = await mintVfsBearerFor(m, 'did:ixo:user', URLS, 'fs/write');
    expect(result).toEqual({ bearer: 'INV' });
    expect(m.getServiceDelegation).toHaveBeenCalledWith('did:ixo:user', {
      storeUrl: URLS.UCAN_STORE_URL,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/write',
    });
    expect(m.createInvocationFromDelegation).toHaveBeenCalledWith(
      'CAR',
      URLS.VFS_BASE_URL,
      {
        can: 'fs/write',
        with: 'ixo:filesystem/oracle-data/did:ixo:entity:abc',
      },
      { maxTtlSeconds: 60 },
    );
  });

  it('passes a no-delegation result through untouched', async () => {
    const m = minter({
      getServiceDelegation: vi.fn(async () => ({
        error: 'no-delegation' as const,
      })),
    });
    expect(await mintVfsBearerFor(m, 'did:ixo:user', URLS, 'fs/read')).toEqual({
      error: 'no-delegation',
    });
    expect(m.createInvocationFromDelegation).not.toHaveBeenCalled();
  });

  it('maps a mint failure to mint-failed with the detail', async () => {
    const m = minter({
      createInvocationFromDelegation: vi.fn(async () => ({ error: 'no key' })),
    });
    expect(await mintVfsBearerFor(m, 'did:ixo:user', URLS, 'fs/read')).toEqual({
      error: 'mint-failed',
      detail: 'no key',
    });
  });
});
