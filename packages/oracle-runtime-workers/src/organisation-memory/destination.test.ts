import { describe, expect, it } from 'vitest';
import { verifyDestination } from './destination';
import { parseImportBody, sha256 } from './contract';
import { publicUrl } from './network';
import fixture from './fixtures/v1.json';

const body = await parseImportBody(fixture.rawBody);
const config = {
  oracleDid: body.oracleDid,
  oracleEntityDid: body.oracleEntityDid,
  network: body.network,
  blocksyncUrl: 'https://blocksync.test/graphql',
};
async function chainFixture(
  options: {
    owner?: string;
    controller?: string[];
    linkedOracle?: string;
    proof?: string;
    account?: string;
    redirect?: boolean;
    duplicate?: boolean;
    changedBytes?: boolean;
  } = {},
) {
  const raw = JSON.stringify({
    granteeAddress: options.account ?? 'ixo1oraclefixture',
  });
  const resource = {
    id: '{id}#orz',
    type: 'oracleAuthZConfig',
    serviceEndpoint: 'https://config.test/authz.json',
    proof: options.proof ?? (await sha256(raw)),
  };
  const entities = [
    {
      id: body.domainDid,
      type: 'dao',
      owner: options.owner ?? 'ixo1ownerfixture',
      controller: options.controller ?? [],
      linkedEntity: [
        {
          id: options.linkedOracle ?? body.oracleEntityDid,
          type: 'oracle/oracle',
        },
      ],
      linkedResource: [],
      service: [],
    },
    {
      id: body.oracleEntityDid,
      type: 'oracle/oracle',
      owner: 'ixo1other',
      controller: [],
      linkedEntity: [],
      linkedResource: options.duplicate ? [resource, resource] : [resource],
      service: [
        {
          id: '{id}#api',
          type: 'oracleService',
          serviceEndpoint: 'https://oracle.test',
        },
      ],
    },
  ];
  const fetcher: typeof fetch = async (url, init) => {
    expect(init?.redirect).toBe('manual');
    if (String(url) === config.blocksyncUrl) {
      const query = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          entity: entities.find((entity) => entity.id === query.variables.id),
        },
      });
    }
    expect(String(url)).toBe(resource.serviceEndpoint);
    return options.redirect
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://other.test/config' },
        })
      : new Response(raw + (options.changedBytes ? ' ' : ''));
  };
  return fetcher;
}
describe('current exact-domain authority', () => {
  it('checks the current exact domain, association and hash-verified oracle account', async () => {
    await expect(
      verifyDestination(body, config, await chainFixture()),
    ).resolves.toBeUndefined();
    await expect(
      verifyDestination(
        body,
        config,
        await chainFixture({ owner: 'ixo1other', controller: [body.userDid] }),
      ),
    ).resolves.toBeUndefined();
  });
  it.each([
    { owner: 'ixo1other' },
    { linkedOracle: 'did:ixo:entity:other' },
    { proof: '' },
    { changedBytes: true },
    { account: 'ixo1anotheroracle' },
    { duplicate: true },
    { redirect: true },
  ])(
    'refuses another domain, altered proof, wrong account or redirect %j',
    async (options) => {
      await expect(
        verifyDestination(body, config, await chainFixture(options)),
      ).rejects.toThrow();
    },
  );
  it('rejects network/entity/account deployment mismatch before fetching', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('must not fetch');
    };
    await expect(
      verifyDestination({ ...body, network: 'devnet' }, config, fetcher),
    ).rejects.toThrow('deployment_mismatch');
    await expect(
      verifyDestination(
        { ...body, oracleDid: 'did:ixo:ixo1other' },
        config,
        fetcher,
      ),
    ).rejects.toThrow('deployment_mismatch');
  });
  it.each([
    'http://oracle.test',
    'https://localhost',
    'https://127.0.0.1',
    'https://2130706433',
    'https://[::1]',
    'https://user@oracle.test',
    'https://foo.internal',
    'https://foo.local',
    'https://oracle.test?q=1',
    'https://oracle.test/#fragment',
  ])('rejects unsafe endpoint %s', (value) => {
    expect(() => publicUrl(value)).toThrow();
  });
});
