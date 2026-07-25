import {
  claimsClient,
  createUcanTokenProvider,
  getDefaultClaimBotUrl,
  MATRIX_BOT_RESOURCES,
  walletClient,
} from '@ixo/oracles-chain-client';

/** The three networks the chain client and the claim bot are configured for. */
export type ClaimNetwork = 'devnet' | 'testnet' | 'mainnet';

/** A chain coin amount — micro-units as a decimal string. */
export interface ClaimCoin {
  denom: string;
  amount: string;
}

/** One entry of a work claim's `deliverables` array. */
export interface ClaimDeliverable {
  name: string;
  type: string;
  /** JSON string carrying the engine-resolvable `mediaAttachment` descriptor. */
  content: string;
}

export interface ClaimBotUploadInput {
  collectionId: string;
  fileName: string;
  mediaType: string;
  bytes: Buffer;
  oracleDid: string;
  /** The oracle's decrypted Ed25519 claim-signing mnemonic. */
  signingMnemonic: string;
  network: ClaimNetwork;
}

/**
 * Uploads the deliverable bytes to the claim-bot media lane and returns the
 * claim's file answer. Injected so tests never touch the bot.
 */
export type ClaimBotUploader = (
  input: ClaimBotUploadInput,
) => Promise<ClaimDeliverable>;

export interface SignClaimInput {
  body: Record<string, unknown>;
  amount: ClaimCoin[];
  collectionId: string;
  accessToken: string;
  matrixRoomId: string;
  secpMnemonic: string;
  matrixValuePin: string;
  oracleDid: string;
  network: ClaimNetwork;
  decryptedSigningMnemonic?: string;
}

export interface SubmitClaimInput {
  claimId: string;
  collectionId: string;
  useIntent: boolean;
  amount: ClaimCoin[];
}

export interface SubmitClaimResult {
  code: number;
  transactionHash: string;
  rawLog?: string;
}

/**
 * `true` when a failed `submit` is the chain refusing the claim because the
 * escrow intent it settles against is gone or past its deadline, rather than
 * anything about the claim itself.
 *
 * Two distinct chain refusals, both from `x/claims/keeper/msg_server.go`'s
 * `SubmitClaim` when `useIntent` is set: `ErrIntentNotFound` ("intent not
 * found", claims 1500) when the store no longer holds an active intent for
 * (agent, collection), and an invalid-request wrap reading "intent <id> is
 * expired" when it does but the block time is past `ExpireAt`.
 *
 * Matched on text because that is the only carrier: the wallet client
 * simulates before broadcasting, so a doomed claim usually surfaces as a THROWN
 * simulate error rather than a tx with a non-zero code — the module error
 * string is the one thing present in both.
 */
export function isExpiredIntentFailure(detail: string): boolean {
  const text = detail.toLowerCase();
  if (!text.includes('intent')) return false;
  return text.includes('not found') || text.includes('expired');
}

/**
 * The chain's evaluation of a submitted claim. `status` is the raw
 * `EvaluationStatus` enum value from `ixo/claims/v1beta1` (0 PENDING,
 * 1 APPROVED, 2 REJECTED, 3 DISPUTED, 4 INVALIDATED, 5 FLAGGED).
 */
export interface ClaimEvaluation {
  status: number;
}

/** Reads a submitted claim's evaluation off the chain, behind a test seam. */
export interface EvaluationChainClient {
  /** `null` when the claim is unknown to Blocksync or not yet evaluated. */
  getEvaluation(claimId: string): Promise<ClaimEvaluation | null>;
}

/**
 * Live evaluation read — a pure Blocksync query (`ClaimById`), no wallet, no
 * UCAN, no engine API.
 */
export const defaultEvaluationChainClient: EvaluationChainClient = {
  getEvaluation: async (claimId) => {
    const result = await claimsClient.getClaim(claimId);
    const status = result.claim?.evaluationByClaimId?.status;
    return typeof status === 'number' ? { status } : null;
  },
};

/** The escrow leg: what locking payment for one engagement needs. */
export interface SendIntentInput {
  collectionId: string;
  amount: ClaimCoin[];
}

/**
 * Locks the service price on-chain (`MsgClaimIntent`) when work starts, so the
 * claim submitted at delivery settles against a reserved amount. Behind a seam
 * so tests never touch the chain.
 */
export interface IntentChainClient {
  sendIntent(input: SendIntentInput): Promise<SubmitClaimResult>;
}

/** The two chain operations the delivery lane needs, behind a test seam. */
export interface ClaimChainClient {
  /** Sign the claim as a VC, stash it in the oracle's room, return its cid. */
  signAndSave(input: SignClaimInput): Promise<string>;
  /** Submit the saved claim on-chain against the user's collection. */
  submit(input: SubmitClaimInput): Promise<SubmitClaimResult>;
}

/**
 * Live claim-bot media upload. Mirrors the portal's `mediaAttachment` shape —
 * the descriptor the engine's attachment resolver turns into fetchable bytes
 * (mediaType + proof CID + a serviceEndpoint on the bot host), which its
 * deliverable gate probes before evaluating.
 */
export const defaultClaimBotUploader: ClaimBotUploader = async (input) => {
  const claimBotUrl = getDefaultClaimBotUrl(input.network);
  const getToken = createUcanTokenProvider({
    mnemonic: input.signingMnemonic,
    did: input.oracleDid,
  });
  const token = await getToken(claimBotUrl, MATRIX_BOT_RESOURCES.claimBot);

  const form = new FormData();
  form.append('collection', input.collectionId);
  form.append(
    'file',
    new File([new Uint8Array(input.bytes)], input.fileName, {
      type: input.mediaType,
    }),
  );

  const res = await fetch(`${claimBotUrl}/media/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-auth-type': 'ucan' },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `Claim media upload failed for ${input.fileName}: ${res.status} ${await res.text()}`,
    );
  }

  const body: unknown = await res.json();
  const cid =
    typeof body === 'object' &&
    body !== null &&
    'data' in body &&
    typeof body.data === 'object' &&
    body.data !== null &&
    'cid' in body.data &&
    typeof body.data.cid === 'string'
      ? body.data.cid
      : null;
  if (!cid) {
    throw new Error(
      `Claim media upload for ${input.fileName} returned no cid.`,
    );
  }

  return {
    name: input.fileName,
    type: input.mediaType,
    content: JSON.stringify({
      id: `{id}#${cid}`,
      type: 'mediaAttachment',
      proof: cid,
      encrypted: true,
      mediaType: input.mediaType,
      description: '',
      serviceEndpoint: `${claimBotUrl}/media/collections/${input.collectionId}/${cid}`,
    }),
  };
};

/**
 * Live chain lane, the same primitives the credits settlement cron uses.
 *
 * `submit` force-initializes the wallet client first: `submitClaim` builds its
 * MsgExec grantee address from `walletClient.address` BEFORE the client has
 * initialized, so on a cold first call the address embeds as `""` and the
 * chain rejects the tx with "empty address string is not allowed".
 */
export const defaultClaimChainClient: ClaimChainClient = {
  signAndSave: (input) =>
    claimsClient.saveSignedClaimToMatrix({
      claim: { body: input.body, amount: input.amount },
      collectionId: input.collectionId,
      accessToken: input.accessToken,
      matrixRoomId: input.matrixRoomId,
      secpMnemonic: input.secpMnemonic,
      matrixValuePin: input.matrixValuePin,
      oracleDid: input.oracleDid,
      network: input.network,
      ...(input.decryptedSigningMnemonic !== undefined && {
        decryptedSigningMnemonic: input.decryptedSigningMnemonic,
      }),
    }),

  submit: async (input) => {
    await walletClient.checkInitiated();
    const result = await claimsClient.submitClaim({
      claimId: input.claimId,
      collectionId: input.collectionId,
      useIntent: input.useIntent,
      amount: input.amount,
    });
    return {
      code: result.code,
      transactionHash: result.transactionHash,
      ...(result.rawLog !== undefined && { rawLog: result.rawLog }),
    };
  },
};

/**
 * Live escrow lane. `sendClaimIntent` builds its MsgExec grantee inside the
 * client's own `runWithInitiatedClient`, so the empty-address cold-start bug
 * that forces `submit` to pre-initialize does not apply here; the explicit
 * `checkInitiated` keeps every chain write in this file starting from the same
 * initialized-wallet precondition.
 */
export const defaultIntentChainClient: IntentChainClient = {
  sendIntent: async (input) => {
    await walletClient.checkInitiated();
    const result = await claimsClient.sendClaimIntent({
      amount: input.amount,
      userClaimCollection: input.collectionId,
    });
    return {
      code: result.code,
      transactionHash: result.transactionHash,
      ...(result.rawLog !== undefined && { rawLog: result.rawLog }),
    };
  },
};
