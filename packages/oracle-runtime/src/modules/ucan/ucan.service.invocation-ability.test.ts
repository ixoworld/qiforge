/**
 * The ability (`can`) a downstream invocation declares must be the ability the
 * user's delegation actually grants.
 *
 * ucanto resolves a claim against a proof only when the delegated ability is
 * `'*'`, equals the claimed ability, or is a `prefix/*` covering it — so a
 * `'*'` claim is satisfiable ONLY by a `'*'` grant. Claiming `'*'` against a
 * narrow grant (e.g. the portal's `subscriptions/read`) is an over-claim the
 * service refuses.
 *
 * `@ixo/ucan` is mocked here: these assertions are about which capability the
 * service asks for, not about real Ed25519 signing.
 */
import type { Cache } from 'cache-manager';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationStore } from './delegation-store.js';
import { UcanService } from './ucan.service.js';

const { createInvocationMock } = vi.hoisted(() => ({
  createInvocationMock: vi.fn(),
}));

vi.mock('@ixo/ucan', () => ({
  signerFromMnemonic: vi.fn(async () => ({ signer: { id: 'signer' } })),
  parseDelegation: vi.fn(async () => ({ expiration: Infinity })),
  createInvocation: createInvocationMock,
  serializeInvocation: vi.fn(async () => 'serialized-invocation'),
}));

vi.mock('@ixo/matrix', () => ({
  MatrixManager: { getInstance: () => ({}) },
}));

vi.mock('@ixo/oracles-chain-client', () => ({
  getMatrixHomeServerCroppedForDid: vi.fn(),
}));

const ORACLE_DID = 'did:ixo:oracle1';
const USER_DID = 'did:ixo:user1';
const SERVICE_DID = 'did:web:subscriptions.example';

function makeCache(): Cache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  } as unknown as Cache & { store: Map<string, unknown> };
}

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: vi.fn(<T>(key: string): T | undefined => values[key] as T | undefined),
    getOrThrow: vi.fn(<T>(key: string): T => values[key] as T),
  } as unknown as ConfigService;
}

describe('UcanService — invocation ability', () => {
  let svc: UcanService;
  let cache: Cache & { store: Map<string, unknown> };

  beforeEach(async () => {
    createInvocationMock.mockReset();
    createInvocationMock.mockResolvedValue({ cid: 'bafy-test' });
    cache = makeCache();
    svc = new UcanService(
      makeConfig({ ORACLE_ENTITY_DID: ORACLE_DID }),
      cache,
      { read: vi.fn(), write: vi.fn() } as unknown as DelegationStore,
    );
    svc.setSigningMnemonic('seed words here', ORACLE_DID);
    await svc.cacheDelegation(USER_DID, 'raw-delegation');
  });

  afterEach(() => {
    svc.onModuleDestroy();
    vi.restoreAllMocks();
  });

  function mintedCapability(): { can: string; with: string } {
    return createInvocationMock.mock.calls.at(-1)?.[0].capability;
  }

  it('claims the requested ability rather than the wildcard', async () => {
    await svc.mintInvocationForServiceDid(
      USER_DID,
      SERVICE_DID,
      'ixo:subscriptions',
      { can: 'subscriptions/read' },
    );

    expect(mintedCapability()).toEqual({
      can: 'subscriptions/read',
      with: 'ixo:subscriptions',
    });
  });

  it("defaults to '*' so existing callers are unchanged", async () => {
    await svc.mintInvocationForServiceDid(USER_DID, SERVICE_DID, 'ixo:memory');

    expect(mintedCapability()).toEqual({ can: '*', with: 'ixo:memory' });
  });

  it('does not serve a cached invocation minted for a different ability', async () => {
    await svc.mintInvocationForServiceDid(
      USER_DID,
      SERVICE_DID,
      'ixo:subscriptions',
      { can: 'subscriptions/read' },
    );
    expect(createInvocationMock).toHaveBeenCalledTimes(1);

    // Same user + service, different ability: must mint afresh. Sharing the
    // cache entry would hand back a read-scoped invocation for a '*' claim.
    await svc.mintInvocationForServiceDid(
      USER_DID,
      SERVICE_DID,
      'ixo:subscriptions',
      { can: '*' },
    );

    expect(createInvocationMock).toHaveBeenCalledTimes(2);
    expect(mintedCapability()).toEqual({
      can: '*',
      with: 'ixo:subscriptions',
    });
  });

  it('still reuses the cached invocation for a repeated ability', async () => {
    const opts = { can: 'subscriptions/read' };
    await svc.mintInvocationForServiceDid(
      USER_DID,
      SERVICE_DID,
      'ixo:subscriptions',
      opts,
    );
    await svc.mintInvocationForServiceDid(
      USER_DID,
      SERVICE_DID,
      'ixo:subscriptions',
      opts,
    );

    expect(createInvocationMock).toHaveBeenCalledTimes(1);
  });
});
