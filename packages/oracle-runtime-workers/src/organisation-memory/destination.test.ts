import { describe, expect, it } from 'vitest';
import { verifyDestination } from './destination';
import { ImportError, parseImportBody, sha256 } from './contract';
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
    missing?: string;
    rawConfig?: string;
    serviceEndpoint?: string;
    domainType?: string;
  } = {},
) {
  const raw =
    options.rawConfig ??
    JSON.stringify({
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
      type: options.domainType ?? 'dao',
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
          serviceEndpoint: options.serviceEndpoint ?? 'https://oracle.test',
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
          entity:
            query.variables.id === options.missing
              ? null
              : entities.find((entity) => entity.id === query.variables.id),
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
  it('accepts an oracle linked from a domain that is itself an oracle, as the Portal does', async () => {
    await expect(
      verifyDestination(
        body,
        config,
        await chainFixture({ domainType: 'oracle/oracle' }),
      ),
    ).resolves.toBeUndefined();
  });
  it('reads a config document saved with a BOM, as the Portal does', async () => {
    await expect(
      verifyDestination(
        body,
        config,
        await chainFixture({
          rawConfig: `\ufeff${JSON.stringify({ granteeAddress: 'ixo1oraclefixture' })}`,
        }),
      ),
    ).resolves.toBeUndefined();
  });
  it('accepts an oracle service registered with a trailing slash, as the Portal does', async () => {
    await expect(
      verifyDestination(
        body,
        config,
        await chainFixture({ serviceEndpoint: 'https://oracle.test/' }),
      ),
    ).resolves.toBeUndefined();
  });
  it.each([
    [{ owner: 'ixo1other' }, 'exact_domain_control_required'],
    [{ linkedOracle: 'did:ixo:entity:other' }, 'oracle_not_associated'],
    [{ proof: '' }, 'oracle_config_proof_required'],
    [{ changedBytes: true }, 'oracle_config_hash_mismatch'],
    [{ account: 'ixo1anotheroracle' }, 'oracle_account_mismatch'],
    [{ duplicate: true }, 'oracle_config_proof_required'],
    [{ redirect: true }, 'redirect_refused'],
    [{ missing: body.domainDid }, 'exact_domain_control_required'],
    [{ missing: body.oracleEntityDid }, 'not_an_oracle'],
    [{ rawConfig: 'not json' }, 'oracle_account_mismatch'],
    [{ serviceEndpoint: 'https://oracle.test/api' }, 'invalid_destination_url'],
  ] satisfies [Parameters<typeof chainFixture>[0], string][])(
    'refuses %j with %s',
    async (options, code) => {
      const refusal = verifyDestination(
        body,
        config,
        await chainFixture(options),
      );
      await expect(refusal).rejects.toBeInstanceOf(ImportError);
      await expect(refusal).rejects.toThrow(code);
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
