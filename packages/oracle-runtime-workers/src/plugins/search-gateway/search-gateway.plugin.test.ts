import { describe, expect, it } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  SEARCH_AUTHORIZATION_SANDBOX_PATH,
  SearchGatewayPlugin,
} from './search-gateway.plugin';

const RD = 'a'.repeat(64);
const GATEWAY_DID = 'did:web:devnet.search.ixo.earth';

function context(overrides: {
  signingKey?: boolean;
  mint?: RuntimeContext['ucan']['mintInvocation'];
  grants?: Awaited<ReturnType<RuntimeContext['ucan']['listAudienceGrants']>>;
}) {
  const base = makeRuntimeContext();
  const calls: Record<string, unknown[]> = { mint: [], grants: [], put: [] };
  const blobs = new Map<string, string>();
  const ctx: RuntimeContext = {
    ...base,
    config: { NETWORK: 'devnet' },
    user: { ...base.user, did: 'did:ixo:ixo1user' },
    ucan: {
      ...base.ucan,
      hasSigningKey: () => overrides.signingKey ?? true,
      resolveServiceDid: async () => GATEWAY_DID,
      mintInvocation:
        overrides.mint ??
        (async (target, opts) => {
          calls.mint?.push({ target, opts });
          return 'INVOCATION';
        }),
      listAudienceGrants: async (did, opts) => {
        calls.grants?.push({ did, opts });
        return overrides.grants ?? { tokens: ['GRANT1', 'GRANT2'] };
      },
    },
    blobStore: {
      ...base.blobStore,
      put: async (params) => {
        calls.put?.push(params);
        blobs.set('blob_0123456789abcdef', params.value);
        return 'blob_0123456789abcdef';
      },
    },
  };
  return { ctx, calls, blobs };
}

function authorizeTool(ctx: RuntimeContext) {
  const tools = new SearchGatewayPlugin().getRequestTools(ctx);
  return tools.find((t) => t.name === 'search_gateway_authorize');
}

describe('SearchGatewayPlugin', () => {
  it('contributes nothing without a signing key', () => {
    const { ctx } = context({ signingKey: false });
    expect(new SearchGatewayPlugin().getRequestTools(ctx)).toEqual([]);
  });

  it('mints an rd-bound search/authenticate invocation and stores the Bearer as a blob', async () => {
    const { ctx, calls, blobs } = context({});
    const result = JSON.parse(
      String(await authorizeTool(ctx)?.handler({ requestDigest: RD }, ctx)),
    );
    expect(result).toEqual({
      success: true,
      blobId: 'blob_0123456789abcdef',
      writeTo: SEARCH_AUTHORIZATION_SANDBOX_PATH,
      audience: GATEWAY_DID,
      grantCount: 2,
    });
    expect(calls.mint?.[0]).toMatchObject({
      target: { did: GATEWAY_DID, capability: 'ixo:search' },
      opts: { can: 'search/authenticate', facts: { rd: RD } },
    });
    expect(calls.grants?.[0]).toEqual({
      did: 'did:ixo:ixo1user',
      opts: { storeUrl: expect.any(String), audienceDid: GATEWAY_DID },
    });
    // The credential only ever lives in the blob store, never in the tool output.
    expect(blobs.get('blob_0123456789abcdef')).toBe('INVOCATION.GRANT1.GRANT2');
    expect(JSON.stringify(result)).not.toContain('INVOCATION');
  });

  it('rejects a malformed request digest', async () => {
    const { ctx } = context({});
    await expect(
      authorizeTool(ctx)?.handler({ requestDigest: 'not-a-digest' }, ctx),
    ).rejects.toThrow();
  });

  it('explains missing delegation and missing grants', async () => {
    const noDelegation = context({
      mint: async () => {
        throw new Error('No delegation');
      },
    });
    const first = JSON.parse(
      String(
        await authorizeTool(noDelegation.ctx)?.handler(
          { requestDigest: RD },
          noDelegation.ctx,
        ),
      ),
    );
    expect(first.success).toBe(false);
    expect(first.error).toContain('search/authenticate');

    const noGrants = context({ grants: { tokens: [] } });
    const second = JSON.parse(
      String(
        await authorizeTool(noGrants.ctx)?.handler(
          { requestDigest: RD },
          noGrants.ctx,
        ),
      ),
    );
    expect(second.success).toBe(false);
    expect(second.error).toContain('no search grants');
  });
});
