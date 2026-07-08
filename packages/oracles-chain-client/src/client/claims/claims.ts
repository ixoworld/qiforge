import { type Coin } from '@cosmjs/proto-signing';
import { cosmos, ixo } from '@ixo/impactxclient-sdk';
import { type ICreateVerifiableCredentialArgs } from '@veramo/core';
import { MatrixBotService } from 'src/matrix-bot/matrix-bot.service.js';
import { createUcanTokenProvider } from 'src/matrix-bot/ucan-token-provider.js';
import { setupClaimSigningMnemonics } from 'src/matrix-bot/setup-claim-signing-mnemonics.js';
import { gqlClient } from '../../gql/index.js';
import { ValidationError } from '../../utils/validation-error.js';
import { walletClient } from '../client.js';
import { createCredential, createVeramoAgent } from '../create-credentials.js';
import { Entities } from '../entities/entity.js';

export class Claims {
  private static instance: Claims;
  constructor(private readonly client = walletClient) {}

  public static getInstance(): Claims {
    if (!Claims.instance) {
      Claims.instance = new Claims();
    }
    return Claims.instance;
  }
  public async getUserOraclesClaimCollection(
    _userAddress: string,
  ): Promise<string | undefined> {
    if (process.env.NODE_ENV === 'production') {
      return undefined;
    }

    throw new Error('getUserOraclesClaimCollection is not implemented');
  }

  public async sendClaimIntent({
    amount,
    userClaimCollection,
  }: {
    amount: Coin[];
    userClaimCollection: string;
  }) {
    if (!userClaimCollection) {
      throw new ValidationError('Claim collection ID not found');
    }
    return this.client.runWithInitiatedClient(async (client) => {
      const message = {
        typeUrl: '/cosmos.authz.v1beta1.MsgExec',
        value: cosmos.authz.v1beta1.MsgExec.fromPartial({
          grantee: client.address,
          msgs: [
            {
              typeUrl: '/ixo.claims.v1beta1.MsgClaimIntent',
              value: ixo.claims.v1beta1.MsgClaimIntent.encode(
                ixo.claims.v1beta1.MsgClaimIntent.fromPartial({
                  agentAddress: client.address,
                  agentDid: `did:ixo:${client.address}`,
                  collectionId: userClaimCollection,
                  amount,
                }),
              ).finish(),
            },
          ],
        }),
      };
      const tx = await client.signAndBroadcast([message]);
      return tx;
    });
  }

  public async submitClaim({
    claimId,
    collectionId,
    useIntent = false,
    amount,
  }: {
    claimId: string;
    collectionId: string;
    useIntent?: boolean;
    amount?: Coin[];
  }) {
    if (!collectionId) {
      throw new ValidationError('Claim collection ID not found');
    }

    const collection = await Entities.getClaimCollection(collectionId);
    if (!collection) {
      throw new ValidationError('Claim collection not found');
    }

    const adminAddress = collection.admin;
    const message = {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: cosmos.authz.v1beta1.MsgExec.fromPartial({
        grantee: this.client.address,
        msgs: [
          {
            typeUrl: '/ixo.claims.v1beta1.MsgSubmitClaim',
            value: ixo.claims.v1beta1.MsgSubmitClaim.encode(
              ixo.claims.v1beta1.MsgSubmitClaim.fromPartial({
                adminAddress,
                agentAddress: this.client.address,
                agentDid: `did:ixo:${this.client.address}`,
                claimId,
                collectionId,
                useIntent,
                amount,
              }),
            ).finish(),
          },
        ],
      }),
    };
    return this.client.runWithInitiatedClient(async (client) => {
      const tx = await client.signAndBroadcast([message]);
      return tx;
    });
  }

  public async listClaims(params: {
    oracleAddress: string;
    userAddress: string;
    collectionId: string;
  }) {
    const claimsList = await gqlClient.Claims({
      agentAddress: params.oracleAddress,
      collectionId: params.collectionId,
    });
    return claimsList;
  }

  public async getClaim(claimId: string) {
    const claim = await gqlClient.ClaimById({ claimId });
    return claim;
  }

  public async saveSignedClaimToMatrix({
    claim,
    collectionId,
    accessToken,
    matrixRoomId,
    secpMnemonic,
    matrixValuePin,
    oracleDid,
    network,
    decryptedSigningMnemonic: precomputedSigningMnemonic,
  }: SubmitAndSaveSignedClaimParams) {
    const credentialArgs: ICreateVerifiableCredentialArgs = {
      credential: {
        // The inline @vocab context maps every credentialSubject field to an
        // IRI. Without it, JSON-LD canonicalization drops the claim fields as
        // undefined terms — jsonld-signatures >= 10 runs in safe mode and
        // throws ("Safe mode validation error") instead of signing a
        // credential the signature wouldn't actually cover.
        '@context': [
          'https://www.w3.org/2018/credentials/v1',
          { '@vocab': 'https://w3id.org/ixo/vocab#' },
        ],
        type: ['VerifiableCredential'],
        credentialSubject: claim.body,
        issuer: '', // This will be set by the createCredential function
      },
      proofFormat: 'lds',
    };
    // Callers that already resolved the signing mnemonic at boot pass it in
    // here so we skip the per-claim HTTP GET + AES decrypt against the
    // oracle's Matrix account room state. Falls back to the original lookup
    // when the caller didn't provide one.
    const decryptedSigningMnemonic =
      precomputedSigningMnemonic ??
      (await setupClaimSigningMnemonics({
        matrixRoomId,
        matrixAccessToken: accessToken,
        walletMnemonic: secpMnemonic,
        pin: matrixValuePin,
        signerDid: oracleDid,
        network,
      }));

    // The oracle authenticates to the matrix bots as itself: a self-issued
    // UCAN invocation signed with the derived claim-signing mnemonic (its
    // ed25519 key is the verification method registered on the oracle DID —
    // NOT the secp wallet mnemonic). This mirrors apps/app's UcanService,
    // which signs with the same setupClaimSigningMnemonics output.
    const matrixBotService = new MatrixBotService(
      accessToken,
      createUcanTokenProvider({
        mnemonic: decryptedSigningMnemonic,
        did: oracleDid,
      }),
    );

    const agent = await createVeramoAgent(network);
    if (!agent || !agent.verifyCredential) {
      throw new Error('Agent not found');
    }

    const claimCredentials = await createCredential({
      credential: credentialArgs,
      mnemonic: decryptedSigningMnemonic,
      issuerDid: oracleDid,
      agent,
    });

    // Verify the credential
    const verificationResult = await agent.verifyCredential({
      credential: claimCredentials,
    });

    if (!verificationResult?.verified)
      throw new Error('Claim verification failed');

    await matrixBotService.sourceRoomAndJoinWithDid(oracleDid);

    if (!collectionId) {
      throw new ValidationError('Collection ID not found');
    }

    const {
      data: { cid },
    } = await matrixBotService.saveClaimToMatrixWithDid(
      oracleDid,
      collectionId,
      {
        ...claim.body,
        credentials: claimCredentials,
      },
    );

    return cid;
  }
}

type SubmitAndSaveSignedClaimParams = {
  claim: {
    body: object;
    amount: Coin[];
  };
  accessToken: string;
  matrixRoomId: string;
  secpMnemonic: string;
  collectionId: string;
  matrixValuePin: string;
  oracleDid: string;
  network: 'devnet' | 'testnet' | 'mainnet';
  /**
   * Pre-decrypted Ed25519 signing mnemonic. When provided, the function
   * skips `setupClaimSigningMnemonics` and uses this directly to sign the
   * verifiable credential. Hosts that already resolve the mnemonic once at
   * boot (e.g. oracle-runtime via `UcanService`) should pass it so the
   * per-claim Matrix state-event GET + AES decrypt is avoided.
   */
  decryptedSigningMnemonic?: string;
};

export const claimsClient = Claims.getInstance();
