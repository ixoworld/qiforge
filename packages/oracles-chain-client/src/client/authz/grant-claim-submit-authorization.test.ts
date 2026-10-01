import { type EncodeObject } from '@cosmjs/proto-signing';
import { cosmos, ixo, type QueryClient } from '@ixo/impactxclient-sdk';
import { type MsgCreateClaimAuthorization } from '@ixo/impactxclient-sdk/codegen/ixo/claims/v1beta1/tx';
import { Authz, DEFAULT_INTENT_DURATION_NS } from './authz.js';
import {
  type GrantClaimSubmitAuthorizationParams,
  type TransactionFn,
} from './types.js';

const userAddress = 'ixo1xpww6379u29ydvh54vmn6na2eyxyp8rk7fsrr0';
const oracleAddress = 'ixo1qlmum93dly86yhlm9hundtz2kw5l2spgeuslzj';

const baseParams: GrantClaimSubmitAuthorizationParams = {
  claimCollectionId: '138',
  accountAddress: userAddress,
  oracleAddress,
  agentQuota: 1000,
  oracleName: 'test',
  adminAddress: userAddress,
};

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function createAuthz(): Authz {
  return new Authz(
    {
      oracleName: 'test',
      granteeAddress: oracleAddress,
      requiredPermissions: ['/ixo.claims.v1beta1.SubmitClaimAuthorization'],
      granterAddress: userAddress,
    },
    // Never resolves: granting builds and signs a message without querying.
    new Promise<QueryClient>(() => undefined),
    silentLogger,
  );
}

/**
 * Runs a grant through `authz` and returns the decoded
 * MsgCreateClaimAuthorization that would have been broadcast, without touching
 * the chain.
 */
async function buildClaimAuthorization(
  params: GrantClaimSubmitAuthorizationParams,
  grant: (
    authz: Authz,
    params: GrantClaimSubmitAuthorizationParams,
    sign: TransactionFn,
  ) => Promise<unknown> = (authz, p, sign) =>
    authz.grantClaimSubmitAuthorization(p, sign),
): Promise<MsgCreateClaimAuthorization> {
  let captured: readonly EncodeObject[] = [];
  const sign: TransactionFn = (messages) => {
    captured = messages;
    return Promise.resolve(undefined);
  };

  await grant(createAuthz(), params, sign);

  expect(captured).toHaveLength(1);
  expect(captured[0]?.typeUrl).toBe('/cosmos.authz.v1beta1.MsgExec');

  const exec = cosmos.authz.v1beta1.MsgExec.fromPartial(captured[0]?.value);
  expect(exec.msgs).toHaveLength(1);
  expect(exec.msgs[0]?.typeUrl).toBe(
    '/ixo.claims.v1beta1.MsgCreateClaimAuthorization',
  );

  return ixo.claims.v1beta1.MsgCreateClaimAuthorization.decode(
    exec.msgs[0]?.value ?? new Uint8Array(),
  );
}

describe('Authz.grantClaimSubmitAuthorization intent duration', () => {
  it('exports a three-hour default expressed in nanoseconds', () => {
    expect(DEFAULT_INTENT_DURATION_NS).toBe('10800000000000');
  });

  it('defaults the intent duration to three hours when the param is omitted', async () => {
    const msg = await buildClaimAuthorization(baseParams);

    expect(msg.intentDurationNs?.seconds.toString()).toBe('10800');
    expect(msg.intentDurationNs?.nanos).toBe(0);
  });

  it('honours an explicit intent duration override', async () => {
    // 6 hours
    const sixHoursNs = (1_000_000_000 * 60 * 60 * 6).toString();
    const msg = await buildClaimAuthorization({
      ...baseParams,
      intentDurationNs: sixHoursNs,
    });

    expect(msg.intentDurationNs?.seconds.toString()).toBe('21600');
    expect(msg.intentDurationNs?.nanos).toBe(0);
  });

  it('keeps the rest of the authorization intact', async () => {
    const msg = await buildClaimAuthorization(baseParams);

    expect(msg.creatorAddress).toBe(userAddress);
    expect(msg.creatorDid).toBe(`did:ixo:${userAddress}`);
    expect(msg.adminAddress).toBe(userAddress);
    expect(msg.granteeAddress).toBe(oracleAddress);
    expect(msg.collectionId).toBe('138');
    expect(msg.agentQuota.toString()).toBe('1000');
    expect(msg.authType).toBe(
      ixo.claims.v1beta1.CreateClaimAuthorizationType.SUBMIT,
    );
  });

  it('passes the intent duration through contractOracle untouched', async () => {
    // 2 hours
    const twoHoursNs = (1_000_000_000 * 60 * 60 * 2).toString();
    const msg = await buildClaimAuthorization(
      { ...baseParams, intentDurationNs: twoHoursNs },
      (authz, params, sign) => authz.contractOracle(params, sign),
    );

    expect(msg.intentDurationNs?.seconds.toString()).toBe('7200');
  });
});
