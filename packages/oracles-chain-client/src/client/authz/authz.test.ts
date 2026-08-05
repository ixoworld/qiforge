/* eslint-disable no-console */
import { cosmos, ixo, utils } from '@ixo/impactxclient-sdk';
import { claimsClient } from '../claims/claims.js';
import { Client } from '../client.js';
import { Authz } from './authz.js';
const client = Client.getInstance();

const userAddress = 'ixo1xpww6379u29ydvh54vmn6na2eyxyp8rk7fsrr0';
const oracleAddress = 'ixo1qlmum93dly86yhlm9hundtz2kw5l2spgeuslzj';

const claims = claimsClient;

describe('Authz', () => {
  let authz: Authz;

  beforeAll(() => {
    authz = new Authz({
      oracleName: 'test',
      granteeAddress: oracleAddress,
      requiredPermissions: ['/ixo.claims.v1beta1.SubmitClaimAuthorization'],
      granterAddress: userAddress,
    });
  });

  it('Should fail to submit intent without permission', async () => {
    const Promise = claims.sendClaimIntent({
      amount: [{ denom: 'upay', amount: '1000' }],
      userClaimCollection: '138',
    });
    await expect(Promise).rejects.toThrow();
  });

  // eslint-disable-next-line vitest/expect-expect
  it('should list intents', async () => {
    await client.init();
    //  const Promise = claims.sendClaimIntent({
    //    amount: [{ denom: 'upay', amount: '1000' }],
    //    granteeAddress: oracleAddress,
    //    userAddress,
    //  });
    //  await expect(Promise).resolves.toBeDefined();
    const intents = await client.queryClient.ixo.claims.v1beta1.intentList({});
    console.log('🚀 ~ Authz ~ it.only ~ intents:', intents);
  }, 1000_000);

  it('Should successfully update payment', async () => {
    const message1 = {
      typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
      value: ixo.entity.v1beta1.MsgGrantEntityAccountAuthz.fromPartial({
        id: 'did:ixo:entity:2595cbf3ccb447e2c33bc28375393cb4',
        ownerAddress: userAddress,
        name: 'admin',
        granteeAddress: userAddress,
        grant: cosmos.authz.v1beta1.Grant.fromPartial({
          authorization: {
            typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
            value: cosmos.authz.v1beta1.GenericAuthorization.encode(
              cosmos.authz.v1beta1.GenericAuthorization.fromPartial({
                msg: '/ixo.claims.v1beta1.MsgUpdateCollectionState',
              }),
            ).finish(),
          },
          expiration: utils.proto.toTimestamp(
            new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
          ), // 30 days
        }),
      }),
    };
    const txPromise1 = client.signAndBroadcast(
      [message1],
      'Grant entity account authz',
    );
    await expect(txPromise1).resolves.toBeDefined();

    const message = {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: cosmos.authz.v1beta1.MsgExec.fromPartial({
        grantee: userAddress,
        msgs: [
          {
            typeUrl: '/ixo.claims.v1beta1.MsgUpdateCollectionState',
            value: ixo.claims.v1beta1.MsgUpdateCollectionState.encode(
              ixo.claims.v1beta1.MsgUpdateCollectionState.fromPartial({
                adminAddress: 'ixo166gq6ma93wsjtmgf6sp5j0wp349xg6xx9rwks3',
                collectionId: '138',
                state: ixo.claims.v1beta1.CollectionState.OPEN,
              }),
            ).finish(),
          },
        ],
      }),
    };
    const txPromise = client.signAndBroadcast(
      [message],
      'Update collection payments',
    );
    await expect(txPromise).resolves.toBeDefined();
  }, 1000_000);
  // eslint-disable-next-line vitest/expect-expect
  it('Should successfully submit intent with permission', async () => {
    await client.init();
    let intentList = await client.queryClient.ixo.claims.v1beta1.intentList({});
    console.log('🚀 ~ Authz ~ it.only ~ intentList:', intentList.intents);
    if (intentList.intents.length) {
      await claims.submitClaim({
        claimId: Math.random().toString(36).substring(2, 15),
        useIntent: true,
        collectionId: '138',
      });
    }
    await claims.sendClaimIntent({
      amount: [{ denom: 'upay', amount: '1000' }],
      userClaimCollection: '138',
    });
    intentList = await client.queryClient.ixo.claims.v1beta1.intentList({});
    console.log('🚀 ~ Authz ~ it.only ~ intentList:', intentList.intents);
    await claims.submitClaim({
      claimId: Math.random().toString(36).substring(2, 15),
      useIntent: true,
      collectionId: '138',
    });
    await claims.sendClaimIntent({
      amount: [{ denom: 'upay', amount: '478' }],
      userClaimCollection: '138',
    });
    // await expect(Promise).resolves.toBeDefined();
    intentList = await client.queryClient.ixo.claims.v1beta1.intentList({});
    console.log('🚀 ~ Authz ~ it.only ~ intentList:', intentList.intents);

    // const permissions = await authz.checkPermissions();
    // console.log('🚀 ~ Authz ~ it.only ~ permissions:', permissions);
    await claims.submitClaim({
      claimId: '1',
      amount: [{ denom: 'upay', amount: '1000' }],
      useIntent: true,
      collectionId: '138',
    });
    // console.log(tx);
    // expect(tx).toBeDefined();
  }, 1000_000);

  it('should approve claim', async () => {
    //  ev
    const message = {
      typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
      value: ixo.entity.v1beta1.MsgGrantEntityAccountAuthz.fromPartial({
        id: 'did:ixo:entity:2595cbf3ccb447e2c33bc28375393cb4',
        ownerAddress: userAddress,
        name: 'admin',
        granteeAddress: userAddress,
        grant: cosmos.authz.v1beta1.Grant.fromPartial({
          authorization: {
            typeUrl: '/ixo.claims.v1beta1.EvaluateClaimAuthorization',
            value: ixo.claims.v1beta1.EvaluateClaimAuthorization.encode(
              ixo.claims.v1beta1.EvaluateClaimAuthorization.fromPartial({
                admin: 'ixo166gq6ma93wsjtmgf6sp5j0wp349xg6xx9rwks3',
                constraints: [
                  ixo.claims.v1beta1.EvaluateClaimConstraints.fromPartial({
                    collectionId: '138',
                    agentQuota: utils.proto.numberToLong(10),
                    // if want to do custom amount, must be within allowed authz if through authz
                    maxCustomAmount: [
                      cosmos.base.v1beta1.Coin.fromPartial({
                        amount: '30000000',
                        denom: 'upay',
                      }),
                    ],
                  }),
                ],
              }),
            ).finish(),
          },
        }),
      }),
    };
    await client.init();
    const tx = await client.signAndBroadcast([message], 'Evaluate claim');
    console.log('🚀 ~ Authz ~ it.only ~ tx:', tx);
    expect(tx).toBeDefined();

    const message2 = {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: cosmos.authz.v1beta1.MsgExec.fromPartial({
        grantee: userAddress,
        msgs: [
          {
            typeUrl: '/ixo.claims.v1beta1.MsgEvaluateClaim',
            value: ixo.claims.v1beta1.MsgEvaluateClaim.encode(
              ixo.claims.v1beta1.MsgEvaluateClaim.fromPartial({
                adminAddress: 'ixo166gq6ma93wsjtmgf6sp5j0wp349xg6xx9rwks3',
                agentAddress: userAddress,
                agentDid:
                  'did:x:zQ3shY2jRreDd6WfGA3PJdhzHhfC3Uknb6TvPcKriSSmePNks',
                oracle:
                  'did:x:zQ3shY2jRreDd6WfGA3PJdhzHhfC3Uknb6TvPcKriSSmePNks',
                claimId: '1',
                reason: 1,
                collectionId: 'sqws4gefv',
                status: ixo.claims.v1beta1.EvaluationStatus.APPROVED,

                verificationProof: 'cid of verificationProof',
                // if want to do custom amount, must be within allowed authz if through authz
                // amount: customAmount,
                // cw20Payment: customCW20Payment,
              }),
            ).finish(),
          },
        ],
      }),
    };
    const tx2 = await client.signAndBroadcast([message2], 'Evaluate claim');
    expect(tx2).toBeDefined();
  }, 1000_000);

  it('should grant claim submit authorization - success', async () => {
    const claimCollectionId =
      (await claims.getUserOraclesClaimCollection(userAddress)) ?? '';
    let hasPermission = await authz.hasPermission(
      '/ixo.claims.v1beta1.SubmitClaimAuthorization',
      claimCollectionId,
    );
    const tx = await authz.grantClaimSubmitAuthorization(
      {
        claimCollectionId,
        adminAddress: userAddress,
        oracleAddress,
        accountAddress: userAddress,
        oracleName: 'test',
        agentQuota: 1000,
      },
      (msgs, memo) => client.signAndBroadcast(msgs, memo),
    );
    console.log(tx);
    expect(tx).toBeDefined();
    hasPermission = await authz.hasPermission(
      '/ixo.claims.v1beta1.SubmitClaimAuthorization',
      claimCollectionId,
    );
    expect(hasPermission).toBe(true);
  }, 1000_000);

  it('should check if user has permission to submit claim - success', async () => {
    const claimCollectionId =
      (await claims.getUserOraclesClaimCollection(userAddress)) ?? '';
    const hasPermission = await authz.hasPermission(
      '/ixo.claims.v1beta1.MsgSubmitClaim',
      claimCollectionId,
    );
    expect(hasPermission).toBe(true);
  }, 1000_000);
});
