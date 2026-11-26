import type { EncodeObject } from '@cosmjs/proto-signing';
import { getIxoSdk } from './ixo-sdk';

/** A chain coin — micro-units as a decimal string. */
export interface Coin {
  denom: string;
  amount: string;
}

/**
 * `MsgExec{ MsgClaimIntent }`: the agent reserves `amount` from the
 * collection's payment account into escrow before starting paid work. The
 * agent acts as the `SubmitClaimAuthorization` grantee, so the inner msg is
 * authz-wrapped with the agent itself as grantee.
 */
export async function claimIntentExec(input: {
  agentAddress: string;
  collectionId: string;
  amount: Coin[];
}): Promise<EncodeObject> {
  const { MsgExec, MsgClaimIntent } = await getIxoSdk();
  return {
    typeUrl: '/cosmos.authz.v1beta1.MsgExec',
    value: MsgExec.fromPartial({
      grantee: input.agentAddress,
      msgs: [
        {
          typeUrl: '/ixo.claims.v1beta1.MsgClaimIntent',
          value: MsgClaimIntent.encode(
            MsgClaimIntent.fromPartial({
              agentAddress: input.agentAddress,
              agentDid: `did:ixo:${input.agentAddress}`,
              collectionId: input.collectionId,
              amount: input.amount,
            }),
          ).finish(),
        },
      ],
    }),
  };
}

/**
 * `MsgExec{ MsgSubmitClaim }` for a claim body already saved by the claim
 * bot (`claimId` is the bot's cid). `useIntent` settles against the escrow
 * reserved by {@link claimIntentExec}; `amount` is then the escrowed amount.
 */
export async function submitClaimExec(input: {
  agentAddress: string;
  adminAddress: string;
  collectionId: string;
  claimId: string;
  useIntent: boolean;
  amount?: Coin[];
}): Promise<EncodeObject> {
  const { MsgExec, MsgSubmitClaim } = await getIxoSdk();
  return {
    typeUrl: '/cosmos.authz.v1beta1.MsgExec',
    value: MsgExec.fromPartial({
      grantee: input.agentAddress,
      msgs: [
        {
          typeUrl: '/ixo.claims.v1beta1.MsgSubmitClaim',
          value: MsgSubmitClaim.encode(
            MsgSubmitClaim.fromPartial({
              adminAddress: input.adminAddress,
              agentAddress: input.agentAddress,
              agentDid: `did:ixo:${input.agentAddress}`,
              claimId: input.claimId,
              collectionId: input.collectionId,
              useIntent: input.useIntent,
              ...(input.amount !== undefined && { amount: input.amount }),
            }),
          ).finish(),
        },
      ],
    }),
  };
}
