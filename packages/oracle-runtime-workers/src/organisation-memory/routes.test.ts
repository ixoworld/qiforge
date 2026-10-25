import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShell } from '../shell/app';
import fixture from './fixtures/v1.json';
import { ORACLE_DID, ORACLE_MNEMONIC } from './fixtures/signed';

afterEach(() => vi.restoreAllMocks());
const env = {
  ORGANISATION_MEMORY_IMPORT_ENABLED: 'true',
  ORACLE_DID,
  ORACLE_ENTITY_DID: fixture.body.oracleEntityDid,
  NETWORK: 'testnet',
  BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.test/graphql',
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
  it('fails closed when enabled without a signing key or entity', async () => {
    for (const changed of [
      { ORACLE_ENTITY_DID: '' },
      { ORACLE_SIGNING_MNEMONIC: undefined },
    ]) {
      const response = await createShell().request(
        '/memory/imports/capabilities',
        {},
        { ...env, ...changed },
      );
      expect(await response.json()).toMatchObject({ enabled: false });
    }
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
