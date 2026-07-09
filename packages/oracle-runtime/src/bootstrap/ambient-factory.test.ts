import { describe, expect, it, vi } from 'vitest';
import { BlobStoreService } from '../modules/blob-store/blob-store.service.js';
import { UcanService } from '../modules/ucan/ucan.service.js';
import type { OracleIdentity } from '../plugin-api/types.js';
import { buildAmbientServices } from './ambient-factory.js';

/**
 * The factory is wired into `createOracleApp` after Nest creates the DI
 * container. We don't spin a real Nest here — stub `nestApp.get` to return
 * fakes for the services the factory pulls (UcanService, BlobStoreService)
 * — enough to exercise the shape of every adapter the factory builds.
 */
function makeFakeUcanService(): UcanService {
  return {
    resolveServiceDid: vi.fn().mockResolvedValue('did:web:service.test'),
    mintInvocationForServiceDid: vi.fn().mockResolvedValue('inv-token'),
    hasSigningKey: vi.fn().mockReturnValue(true),
    createInvocationFromDelegation: vi
      .fn()
      .mockResolvedValue({ invocation: 'inv-car' }),
    mintSelfSignedInvocation: vi
      .fn()
      .mockResolvedValue({ invocation: 'inv-car' }),
    getServiceDelegation: vi
      .fn()
      .mockResolvedValue({ error: 'no-delegation' }),
  } as unknown as UcanService;
}

function makeFakeBlobStoreService(): BlobStoreService {
  return {
    put: vi.fn().mockResolvedValue('blob_0000000000000000'),
    get: vi.fn().mockResolvedValue(null),
    isValidBlobId: vi.fn().mockReturnValue(true),
  } as unknown as BlobStoreService;
}

function makeNestAppStub(ucan: UcanService, blobStore: BlobStoreService) {
  return {
    get(token: unknown): unknown {
      if (token === UcanService) return ucan;
      if (token === BlobStoreService) return blobStore;
      throw new Error(`unexpected DI lookup for ${String(token)}`);
    },
  } as Parameters<typeof buildAmbientServices>[0]['nestApp'];
}

const IDENTITY: OracleIdentity = {
  name: 'TestOracle',
  org: 'IXO',
  description: 'unit-test oracle',
  entityDid: 'did:ixo:test-oracle',
};

describe('buildAmbientServices', () => {
  it('returns an AmbientServices bag with every adapter populated', () => {
    const ucan = makeFakeUcanService();
    const ambient = buildAmbientServices({
      nestApp: makeNestAppStub(ucan, makeFakeBlobStoreService()),
      config: { NETWORK: 'devnet' },
      identity: IDENTITY,
      availablePlugins: new Set(['memory']),
      logger: console,
    });

    expect(ambient.config).toEqual({ NETWORK: 'devnet' });
    expect(ambient.identity).toBe(IDENTITY);
    expect(ambient.availablePlugins.has('memory')).toBe(true);
    expect(typeof ambient.ucan.mintInvocation).toBe('function');
    expect(typeof ambient.ucan.resolveServiceDid).toBe('function');
    expect(typeof ambient.ucan.hasCapability).toBe('function');
    expect(typeof ambient.ucan.requireCapability).toBe('function');
    expect(typeof ambient.matrix.postToRoom).toBe('function');
    expect(typeof ambient.matrix.getRoomState).toBe('function');
    expect(typeof ambient.matrix.getEventById).toBe('function');
    expect(typeof ambient.secrets.getIndex).toBe('function');
    expect(typeof ambient.secrets.getValues).toBe('function');
    expect(typeof ambient.blobStore.put).toBe('function');
    expect(typeof ambient.blobStore.get).toBe('function');
    expect(typeof ambient.blobStore.isValidBlobId).toBe('function');
    expect(typeof ambient.ucan.hasSigningKey).toBe('function');
    expect(typeof ambient.ucan.createInvocationFromDelegation).toBe('function');
    expect(typeof ambient.ucan.mintSelfSignedInvocation).toBe('function');
    expect(typeof ambient.ucan.getServiceDelegation).toBe('function');
    expect(typeof ambient.llm.get).toBe('function');
    expect(typeof ambient.emit.emit).toBe('function');
  });

  it('UcanAdapter.hasCapability/requireCapability scan the delegation array', () => {
    const ambient = buildAmbientServices({
      nestApp: makeNestAppStub(
        makeFakeUcanService(),
        makeFakeBlobStoreService(),
      ),
      config: {},
      identity: IDENTITY,
      availablePlugins: new Set(),
      logger: console,
    });

    const delegation = {
      capabilities: [{ resource: 'ixo:memory', action: 'read' }] as const,
    };
    expect(ambient.ucan.hasCapability(delegation, 'ixo:memory', 'read')).toBe(
      true,
    );
    expect(ambient.ucan.hasCapability(delegation, 'ixo:memory', 'write')).toBe(
      false,
    );
    expect(() =>
      ambient.ucan.requireCapability(delegation, 'ixo:memory', 'read'),
    ).not.toThrow();
    expect(() =>
      ambient.ucan.requireCapability(delegation, 'ixo:memory', 'write'),
    ).toThrow(/missing/i);
  });

  it('UcanAdapter.mintInvocation delegates to UcanService and throws on null', async () => {
    const ucan = makeFakeUcanService();
    const ambient = buildAmbientServices({
      nestApp: makeNestAppStub(ucan, makeFakeBlobStoreService()),
      config: {},
      identity: IDENTITY,
      availablePlugins: new Set(),
      logger: console,
    });

    const token = await ambient.ucan.mintInvocation('did:ixo:user', {
      did: 'did:web:service.test',
      capability: 'ixo:memory',
    });
    expect(token).toBe('inv-token');
    expect(ucan.mintInvocationForServiceDid).toHaveBeenCalledWith(
      'did:ixo:user',
      'did:web:service.test',
      'ixo:memory',
      undefined,
    );

    vi.mocked(ucan.mintInvocationForServiceDid).mockResolvedValueOnce(null);
    await expect(
      ambient.ucan.mintInvocation('did:ixo:user', {
        did: 'did:web:service.test',
        capability: 'ixo:memory',
      }),
    ).rejects.toThrow(/mint returned null/i);
  });

  it('LlmAdapter.get resolves a chat model for a known role', () => {
    const ambient = buildAmbientServices({
      nestApp: makeNestAppStub(
        makeFakeUcanService(),
        makeFakeBlobStoreService(),
      ),
      config: {},
      identity: IDENTITY,
      availablePlugins: new Set(),
      logger: console,
    });

    const model = ambient.llm.get('subagent');
    expect(model).toBeDefined();
    expect(typeof model.invoke).toBe('function');
  });
});
