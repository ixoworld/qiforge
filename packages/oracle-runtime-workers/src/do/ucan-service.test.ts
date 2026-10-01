/**
 * Regression coverage for `WorkersUcanService.createInvocationFromDelegation`
 * audience resolution: plugins that already resolved a service DID (memory,
 * composio via `mintInvocationSafely`) pass the DID itself as the target —
 * the service must mint straight to it. A DID is not a fetchable URL
 * (`new URL('did:web:x').origin` is `"null"`), so routing it through the
 * did.json lookup silently killed every plugin mint.
 */
import {
  createDelegation,
  serializeDelegation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkersUcanService } from './ucan-service';

// Deterministic BIP39 test vector — never a real account.
const ORACLE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const USER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ORACLE_DID = 'did:ixo:entity:testoracle0000000000000001';
const USER_DID = 'did:ixo:entity:testuser000000000000000001';
const SERVICE_DID = 'did:web:memory.example.com';

async function userDelegationCar(): Promise<string> {
  const { signer } = await signerFromMnemonic(
    USER_MNEMONIC,
    USER_DID as `did:ixo:${string}`,
  );
  const delegation = await createDelegation({
    issuer: signer,
    audience: ORACLE_DID,
    capabilities: [{ can: 'memory/*', with: 'ixo:memory' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  return serializeDelegation(delegation);
}

describe('WorkersUcanService.createInvocationFromDelegation', () => {
  const fetchSpy = vi.fn<typeof fetch>();
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function service(): WorkersUcanService {
    return new WorkersUcanService({
      oracleDid: ORACLE_DID,
      signingMnemonic: ORACLE_MNEMONIC,
    });
  }

  it('mints straight to a did: target without any did.json fetch', async () => {
    const car = await userDelegationCar();
    const result = await service().createInvocationFromDelegation(
      car,
      SERVICE_DID,
      { can: 'memory/*', with: 'ixo:memory' },
    );
    if ('error' in result) throw new Error(`mint failed: ${result.error}`);
    expect(result.invocation.length).toBeGreaterThan(100);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still resolves a URL target through /.well-known/did.json', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: SERVICE_DID }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const car = await userDelegationCar();
    const result = await service().createInvocationFromDelegation(
      car,
      'https://memory.example.com/mcp',
      { can: 'memory/*', with: 'ixo:memory' },
    );
    expect(result).toHaveProperty('invocation');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://memory.example.com/.well-known/did.json',
    );
  });
});
