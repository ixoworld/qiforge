import { signerFromMnemonic } from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShell } from '../shell/app';
import fixture from './fixtures/v1.json';
import {
  ORACLE_DID,
  ORACLE_MNEMONIC,
  USER_DID,
  USER_MNEMONIC,
  signedFixture,
} from './fixtures/signed';

afterEach(() => vi.restoreAllMocks());
const env = {
  ORGANISATION_MEMORY_IMPORT_ENABLED: 'true',
  ORACLE_DID,
  ORACLE_ENTITY_DID: fixture.body.oracleEntityDid,
  NETWORK: 'testnet',
  BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.test/graphql',
  MEMORY_MCP_URL: 'https://memory.test/mcp',
  ORACLE_SIGNING_MNEMONIC: ORACLE_MNEMONIC,
  UCAN_ALLOW_BARE_DELEGATION_AUTH: 'true',
};
describe('fixed organisation memory HTTP routes', () => {
  it('advertises the disabled descriptor by default without authenticating or booting a user', async () => {
    const response = await createShell().request(
      '/memory/imports/capabilities',
      {},
      { ...env, ORGANISATION_MEMORY_IMPORT_ENABLED: undefined },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      enabled: false,
      network: 'testnet',
      oracleEntityDid: fixture.body.oracleEntityDid,
      oracleDid: ORACLE_DID,
      storageScope: 'oracle',
      limits: { maxChunks: 25, maxChunkBytes: 12000, maxBodyBytes: 262144 },
    });
  });
  it('fails closed when enabled without a signing key, entity or usable memory URL', async () => {
    for (const changed of [
      { ORACLE_ENTITY_DID: '' },
      { ORACLE_SIGNING_MNEMONIC: undefined },
      { MEMORY_MCP_URL: undefined },
      { MEMORY_MCP_URL: 'http://localhost:8000/mcp' },
    ]) {
      const response = await createShell().request(
        '/memory/imports/capabilities',
        {},
        { ...env, ...changed },
      );
      expect(await response.json()).toMatchObject({ enabled: false });
    }
  });
  it('uses the env schema default network when NETWORK is unset', async () => {
    const response = await createShell().request(
      '/memory/imports/capabilities',
      {},
      { ...env, NETWORK: undefined },
    );
    expect(await response.json()).toMatchObject({
      enabled: true,
      network: 'mainnet',
    });
  });
  it('asks the gateway for its signer once, not on every public probe', async () => {
    let checks = 0;
    const gatewayEnv = {
      ...env,
      ORACLE_DID: 'did:ixo:ixo1gatewaysigner',
      ORACLE_SIGNING_MNEMONIC: undefined,
      MATRIX_GATEWAY: {
        idFromName: () => 'gateway',
        get: () => ({
          getOracleSigningMnemonic: async () => {
            checks++;
            return 'account room mnemonic';
          },
        }),
      },
    };
    for (let probe = 0; probe < 3; probe++) {
      const response = await createShell().request(
        '/memory/imports/capabilities',
        {},
        gatewayEnv,
      );
      expect(await response.json()).toMatchObject({ enabled: true });
    }
    expect(checks).toBe(1);
  });
  it('gates submits before body parsing or any network work', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const response = await createShell().request(
      '/memory/imports',
      { method: 'POST', body: 'not json' },
      { ...env, ORGANISATION_MEMORY_IMPORT_ENABLED: undefined },
    );
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never accepts a bare delegation even with legacy chat auth enabled', async () => {
    const response = await createShell().request(
      '/memory/imports',
      {
        method: 'POST',
        headers: { 'x-ucan-delegation': 'some-bare-grant' },
        body: fixture.rawBody,
      },
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'invocation_required' });
  });
  it('answers status from the receipt without re-reading the domain or oracle', async () => {
    const f = await signedFixture({ operation: 'status' });
    f.headers.delete('x-ucan-delegation');
    // Blocksync serves only the two signers' keys; any entity query fails.
    const keys = new Map([
      [USER_DID, (await signerFromMnemonic(USER_MNEMONIC)).did],
      [ORACLE_DID, (await signerFromMnemonic(ORACLE_MNEMONIC)).did],
    ]);
    const queries: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const query = JSON.parse(String(init?.body));
      queries.push(query.query);
      const id: string = query.variables?.id;
      const key = keys.get(id);
      return Response.json({
        data: {
          iids: {
            nodes: key
              ? [
                  {
                    id,
                    verificationMethod: [
                      {
                        id: `${id}#key-1`,
                        type: 'Ed25519VerificationKey2020',
                        controller: id,
                        publicKeyMultibase: key.slice('did:key:'.length),
                      },
                    ],
                  },
                ]
              : [],
          },
        },
      });
    });
    const calls: unknown[] = [];
    const response = await createShell().request(
      '/memory/imports/status',
      { method: 'POST', headers: f.headers, body: f.raw },
      {
        ...env,
        USER_ORACLE: {
          idFromName: (name: string) => name,
          get: () => ({
            organisationMemoryImport: async (...args: unknown[]) => {
              calls.push(args);
              return {
                ok: true,
                result: {
                  version: 1,
                  requestId: fixture.statusBody.requestId,
                  requestDigest: fixture.statusBody.requestDigest,
                  outcome: 'unknown',
                  code: 'not_found',
                },
              };
            },
          }),
        },
      },
    );
    expect(await response.json()).toEqual({ code: 'not_found' });
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(queries.some((query) => query.includes('MemoryImportEntity'))).toBe(
      false,
    );
  });
  it('rejects malformed UTF-8 and oversized bytes before authentication', async () => {
    const invalid = await createShell().request(
      '/memory/imports',
      { method: 'POST', body: new Uint8Array([0xff]) },
      env,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: 'invalid_utf8_body' });
    const large = await createShell().request(
      '/memory/imports',
      { method: 'POST', body: 'a'.repeat(262145) },
      env,
    );
    expect(large.status).toBe(413);
  });
});
