import {
  ITrxMsgSchema,
  NetworkSchema,
  RiskConfirmationSchema,
  SIGN_TRANSACTION_ACTION_NAME,
  buildBatchSignTransactionActionArgs,
  describeValidationError,
  validateTransactionBatch,
  type Network,
  type RiskConfirmation,
  type ValidatedTransactionBatch,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import {
  requestWalletSignature,
  walletUnavailableReason,
} from '../ixo-transaction/wallet-signing';
import type { BlueprintStoreFor } from './blueprint-store';
import {
  notConfiguredChainGateway,
  podBatchProblem,
  type ChainGateway,
} from './chain-gateway';
import { readPodCreatorConfig } from './config';
import type { CreateSessionStoreFor } from './create-session-store';
import { assembleServicePodBlueprint, computeReadiness } from './stage';

const threadId = (ctx: RuntimeContext): string => ctx.session.id;

/**
 * The AG-UI action that signs POD creation batches: the same
 * `sign_transaction` action, and the same Portal handler, as
 * `IxoTransactionPlugin` (`@ixo/ixo-transaction/react`).
 */
export const SIGN_TRANSACTION_ACTION = SIGN_TRANSACTION_ACTION_NAME;

/**
 * Wallet review + broadcast takes far longer than a UI render, so the sign
 * round-trip gets its own generous deadline.
 */
export const SIGN_TIMEOUT_MS = 120_000;

/** Cosmos SDK transaction hash: 32 bytes hex. */
const TX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/** The blob store name of a prepared batch. */
export const POD_BATCH_BLOB_NAME = 'pod-batch-messages';

const blobIdSchema = z.object({
  blobId: z
    .string()
    .describe('The blobId returned by prepare_pod_transaction.'),
});

const approveSchema = blobIdSchema.extend({
  riskConfirmation: RiskConfirmationSchema.describe(
    'The risks prepare_pod_transaction listed, each quoted exactly as the user accepted it, with confirmed: true.',
  ),
});

const confirmSchema = z.object({
  txHash: z
    .string()
    .regex(TX_HASH_PATTERN, 'expected a 64-character hex transaction hash')
    .describe('The transaction hash the wallet returned after broadcasting.'),
});

/**
 * The prepared batch as the blob store keeps it: the gateway's messages after
 * catalog validation (canonical proto-JSON), and what they are for. The
 * model only ever sees the blobId and the message names.
 */
const storedBatchSchema = z
  .object({
    network: NetworkSchema,
    summary: z.string(),
    messages: z.array(ITrxMsgSchema),
  })
  .strict();

type StoredBatch = z.infer<typeof storedBatchSchema>;

const CHAIN_UNAVAILABLE_MESSAGE =
  'On-chain POD creation is not yet enabled on this oracle — the chain ' +
  'gateway is not configured. The design blueprint is saved; creation can ' +
  'proceed once the operator wires the IXO MCP chain gateway.';

/**
 * Validate a blobId and return the stored batch, throwing when it is missing,
 * expired or not a POD batch so the agent knows to re-prepare.
 */
async function requirePreparedBatch(
  ctx: RuntimeContext,
  blobId: string,
): Promise<StoredBatch> {
  if (!ctx.blobStore.isValidBlobId(blobId)) {
    throw new Error(`Invalid blobId: ${blobId}`);
  }
  const blob = await ctx.blobStore.get({ userDid: ctx.user.did, blobId });
  if (!blob) {
    throw new Error(
      'Prepared transaction not found or expired. Call prepare_pod_transaction again.',
    );
  }
  const stored =
    blob.name === POD_BATCH_BLOB_NAME
      ? storedBatchSchema.safeParse(parseJson(blob.value))
      : undefined;
  if (!stored?.success) {
    throw new Error(
      'That blobId does not hold a prepared POD batch. Call prepare_pod_transaction again.',
    );
  }
  return stored.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The stored batch through the catalog again (it was valid when prepared;
 * the catalog is the authority at every step), with the user's risk
 * acceptance when given.
 */
function validateStoredBatch(
  batch: StoredBatch,
  options: {
    mainnetAllowed: boolean;
    riskConfirmation?: RiskConfirmation;
  },
): ValidatedTransactionBatch {
  return validateTransactionBatch(
    { ...batch, riskConfirmation: options.riskConfirmation },
    {
      allowMainnet: options.mainnetAllowed,
      requireRiskConfirmation: options.riskConfirmation !== undefined,
    },
  );
}

/** What `request_pod_signature` returns to the model. */
export type RequestPodSignatureResult =
  | {
      status: 'signed';
      network: Network;
      chainId: string;
      /** Absent when the wallet gave none; confirm_pod_creation needs it. */
      txHash?: string;
      code?: number;
      height?: string | number;
      message: string;
    }
  | {
      /** Included in a block but failed: nothing was created. */
      status: 'failed';
      network: Network;
      chainId: string;
      code: number;
      txHash?: string;
      height?: string | number;
      error: string;
      message: string;
    }
  | {
      status: 'rejected' | 'error';
      network: Network;
      error: string;
      message: string;
    }
  | {
      status: 'timeout';
      /** The wallet may still sign: the write claim stays. */
      outcome: 'unknown';
      network: Network;
      error: string;
    }
  | { status: 'unavailable'; error: string; message: string };

const RETRY_AFTER_SPENT_APPROVAL =
  'Nothing was signed and the approval was spent: to retry, the user confirms again in a new message and you call approve_pod_transaction, then request_pod_signature.';

/**
 * The on-chain create path — a propose → approve → commit handoff that keeps
 * the oracle out of the signing loop:
 *
 * - `prepare_pod_transaction` (propose) has the gateway compose the batch's
 *   proto-JSON messages, validates every one against the `@ixo/ixo-transaction`
 *   catalog (and that it is a POD batch), and stashes them in the blob store
 *   (the LLM only sees a short `blobId`, the message names and the risks). It
 *   refuses on mainnet unless `POD_CREATOR_ALLOW_MAINNET` is set, and
 *   supersedes any prior approval.
 * - `approve_pod_transaction` (approve) binds the user's go-ahead to the exact
 *   batch prepared in this conversation — with every risk of every message
 *   accepted word for word — and refuses within the turn that prepared it,
 *   so approval needs a new user message after the summary was shown. The
 *   model still calls it: what it records is "a later turn said yes", not a
 *   verified human act.
 * - `request_pod_signature` (commit) re-checks the launch gate, SPENDS the
 *   approval, then sends the batch as the batch form of the ixo-transaction
 *   `sign_transaction` action over the realtime channel — the same contract
 *   and the same Portal handler as `sign_ixo_transaction` — which re-validates
 *   every message and signs them in one wallet transaction. A second dispatch
 *   always needs a fresh approval — a sign request cannot be replayed.
 * - `confirm_pod_creation` resolves the created POD from the broadcast tx and
 *   closes the session.
 *
 * The whole path only matters once the launch-readiness gate passes. The
 * binding hard gates are the operator's mainnet opt-in and the wallet
 * signature — the user reviewing and signing in their own wallet is the real
 * human gate. The oracle never signs creation: nothing here holds or asks for
 * a signing key, and what leaves is the validated, unsigned messages.
 *
 * Both stores are resolved per call from the request context (on Workers they
 * are rows in the user's own database, so an approval survives the user
 * object being evicted between the user's "yes" and the sign request).
 */
export function createCreateTools(
  blueprintsFor: BlueprintStoreFor,
  gateway: ChainGateway,
  sessionsFor: CreateSessionStoreFor,
): PluginTool[] {
  const chainUnavailable = gateway === notConfiguredChainGateway;

  const prepare = tool(
    async (_args, ctx) => {
      const bp = await blueprintsFor(ctx).get(threadId(ctx));
      if (!bp) {
        return {
          prepared: false,
          message:
            'No POD design session started yet. Call start_pod_design first.',
        };
      }
      const readiness = computeReadiness(bp);
      if (!readiness.complete) {
        return {
          prepared: false,
          stage: readiness.stage,
          blockers: readiness.blockers,
          message:
            'Launch-readiness gate not passed; cannot prepare the creation transaction yet.',
        };
      }
      if (chainUnavailable) {
        return { prepared: false, message: CHAIN_UNAVAILABLE_MESSAGE };
      }
      const { network, mainnetAllowed } = readPodCreatorConfig(ctx);
      if (network === 'mainnet' && !mainnetAllowed) {
        return {
          prepared: false,
          message:
            'Mainnet POD creation is disabled. Set POD_CREATOR_ALLOW_MAINNET=true in the oracle config to allow preparing a mainnet creation batch.',
        };
      }
      const blueprint = assembleServicePodBlueprint(bp);
      const prepared = await gateway.preparePodBatch(
        { blueprint, network },
        ctx,
      );
      // The wallet's handler refuses anything outside the catalog, so a
      // batch it would refuse is caught here, before the user is asked.
      let batch: ValidatedTransactionBatch;
      try {
        batch = validateTransactionBatch(
          {
            messages: prepared.messages,
            summary: prepared.summary,
            network,
          },
          { allowMainnet: mainnetAllowed },
        );
      } catch (error) {
        throw new Error(
          `The chain gateway built a batch the wallet would refuse: ${describeValidationError(error)}`,
        );
      }
      const notPod = podBatchProblem(batch.routes);
      if (notPod !== null) {
        throw new Error(`The chain gateway built a wrong batch: ${notPod}`);
      }
      const stored: StoredBatch = {
        network: batch.network,
        summary: batch.summary,
        messages: batch.messages,
      };
      const blobId = await ctx.blobStore.put({
        userDid: ctx.user.did,
        name: POD_BATCH_BLOB_NAME,
        value: JSON.stringify(stored),
      });
      await sessionsFor(ctx).prepared(
        ctx.user.did,
        threadId(ctx),
        blobId,
        ctx.session.requestId,
      );
      ctx.logger.log(
        `[pod-creator] prepared batch ${blobId} (${batch.messages.length} msgs, ${network}) user=${ctx.user.did} thread=${threadId(ctx)}`,
      );
      return {
        prepared: true,
        blobId,
        summary: batch.summary,
        messageCount: batch.messages.length,
        messages: batch.routes.map((route) => route.messageName),
        risks: batch.risks,
        riskLevel: batch.riskLevel,
        ...(prepared.estimatedCost !== undefined
          ? { estimatedCost: prepared.estimatedCost }
          : {}),
        message:
          'Transaction batch prepared. Show the user the summary and every risk, word for word, and stop: approve_pod_transaction only works on a later message in which the user explicitly confirms, and needs each risk they accepted quoted exactly.',
      };
    },
    {
      name: 'prepare_pod_transaction',
      description:
        'Build the on-chain POD creation batch (unsigned messages) from the approved blueprint and stash it for the user to sign. Returns its summary, message names and risks. Only works once the launch-readiness gate has passed; refuses on mainnet unless the operator opted in.',
      schema: z.object({}),
    },
  );

  const approve = tool(
    async (args, ctx) => {
      const { blobId, riskConfirmation } = approveSchema.parse(args);
      const batch = await requirePreparedBatch(ctx, blobId);
      // Approval means every risk of every message was accepted word for
      // word, as `sign_ixo_transaction` requires of a single message.
      try {
        validateStoredBatch(batch, {
          mainnetAllowed: readPodCreatorConfig(ctx).mainnetAllowed,
          riskConfirmation,
        });
      } catch (error) {
        return {
          approved: false,
          message: describeValidationError(error),
        };
      }
      const outcome = await sessionsFor(ctx).approve(
        ctx.user.did,
        threadId(ctx),
        blobId,
        ctx.session.requestId,
      );
      if (outcome === 'not-prepared') {
        return {
          approved: false,
          message:
            'That blobId is not the batch prepared in this conversation. Call prepare_pod_transaction and approve the blobId it returns.',
        };
      }
      if (outcome === 'same-request') {
        return {
          approved: false,
          message:
            'The batch was prepared in this same turn. Show the user the summary and wait for their reply; approval is only accepted on a later message in which they confirm it.',
        };
      }
      ctx.logger.log(
        `[pod-creator] approved batch ${blobId} user=${ctx.user.did} thread=${threadId(ctx)}`,
      );
      return {
        approved: true,
        message:
          'Approval recorded. Call request_pod_signature to send the batch to the wallet for signing.',
      };
    },
    {
      name: 'approve_pod_transaction',
      description:
        "Record the user's explicit approval of the prepared batch (blobId), with every risk prepare_pod_transaction listed quoted exactly in riskConfirmation.acceptedRisks. Call only after showing the batch summary and its risks and the user confirms in their own words in a later message — it refuses in the turn that prepared the batch. request_pod_signature refuses until this approval is recorded.",
      schema: approveSchema,
    },
  );

  const requestSignature = tool(
    async (args, ctx): Promise<RequestPodSignatureResult> => {
      const { blobId } = blobIdSchema.parse(args);
      const batch = await requirePreparedBatch(ctx, blobId);
      const { network, mainnetAllowed, chainIds } = readPodCreatorConfig(ctx);
      if (
        (network === 'mainnet' || batch.network === 'mainnet') &&
        !mainnetAllowed
      ) {
        throw new Error(
          'Mainnet POD creation is disabled; cannot request a signature.',
        );
      }
      // The gate is checked again here, before the approval is spent: a
      // design restarted, expired or re-opened by a failed gate verdict since
      // the batch was prepared must not reach the wallet.
      const bp = await blueprintsFor(ctx).get(threadId(ctx));
      if (!bp || !computeReadiness(bp).complete) {
        throw new Error(
          'The launch-readiness gate no longer passes for this design (it was restarted, expired or re-opened since the batch was prepared). Resolve the blockers and call prepare_pod_transaction again.',
        );
      }
      // Nothing is sent without a way to the wallet, so the approval is kept.
      const unavailable = walletUnavailableReason(ctx);
      if (unavailable !== null) {
        return {
          status: 'unavailable',
          error: unavailable,
          message:
            'Nothing was sent and the approval is kept: call request_pod_signature again once the user has the chat open in the Portal.',
        };
      }
      // The approval stands for every risk accepted word for word (checked
      // by approve_pod_transaction against this same stored batch).
      const risks = validateStoredBatch(batch, { mainnetAllowed }).risks;
      const signArgs = buildBatchSignTransactionActionArgs(
        {
          ...batch,
          riskConfirmation: { confirmed: true, acceptedRisks: risks },
        },
        { allowMainnet: mainnetAllowed, chainIds },
      );
      const consumed = await sessionsFor(ctx).consume(
        ctx.user.did,
        threadId(ctx),
        blobId,
      );
      if (!consumed) {
        throw new Error(
          'Transaction not approved (or its approval was already used). Call approve_pod_transaction after the user explicitly confirms the batch.',
        );
      }
      const outcome = await requestWalletSignature(ctx, {
        args: signArgs,
        callIdPrefix: 'pod',
        timeoutMs: SIGN_TIMEOUT_MS,
      });
      const audit = `batch ${blobId} (${signArgs.chainId}) user=${ctx.user.did} thread=${threadId(ctx)}`;
      switch (outcome.status) {
        case 'signed': {
          const { transactionHash, ...rest } = outcome;
          ctx.logger.log(
            `[pod-creator] wallet signed ${audit} tx=${transactionHash ?? 'none'}`,
          );
          return {
            ...rest,
            network: signArgs.network,
            chainId: signArgs.chainId,
            ...(transactionHash !== undefined
              ? {
                  txHash: transactionHash,
                  message:
                    'The wallet signed and broadcast the batch. Call confirm_pod_creation with this txHash.',
                }
              : {
                  message:
                    'The wallet reports the batch signed but returned no transaction hash. Ask the user for it, then call confirm_pod_creation with it.',
                }),
          };
        }
        case 'failed': {
          const { transactionHash, ...rest } = outcome;
          ctx.logger.warn(
            `[pod-creator] batch failed on chain ${audit} code=${outcome.code} tx=${transactionHash ?? 'none'}`,
          );
          return {
            ...rest,
            network: signArgs.network,
            chainId: signArgs.chainId,
            ...(transactionHash !== undefined
              ? { txHash: transactionHash }
              : {}),
            message:
              'The transaction was included in a block but failed, so no POD was created (a transaction is all or nothing). Tell the user the code and error; once the cause is fixed, call prepare_pod_transaction again.',
          };
        }
        case 'rejected':
        case 'error':
          ctx.logger.warn(
            `[pod-creator] wallet ${outcome.status} ${audit}: ${outcome.error}`,
          );
          return {
            ...outcome,
            network: signArgs.network,
            message: RETRY_AFTER_SPENT_APPROVAL,
          };
        case 'timeout':
          ctx.logger.warn(`[pod-creator] sign outcome unknown ${audit}`);
          return { ...outcome, network: signArgs.network };
        case 'unavailable':
          ctx.logger.warn(
            `[pod-creator] wallet unavailable ${audit}: ${outcome.error}`,
          );
          return { ...outcome, message: RETRY_AFTER_SPENT_APPROVAL };
      }
    },
    {
      name: 'request_pod_signature',
      description:
        "Send the approved POD creation batch to the user's Portal wallet to sign and broadcast as one transaction, and return the outcome: signed (with the txHash for confirm_pod_creation), failed (on chain, with code and hash; nothing was created), rejected, error, timeout (outcome unknown: do not send it again, ask the user) or unavailable. Spends the approval once the request is sent — each dispatch needs a fresh approve_pod_transaction.",
      schema: blobIdSchema,
    },
  );

  const confirm = tool(
    async (args, ctx) => {
      const { txHash } = confirmSchema.parse(args);
      if (chainUnavailable) {
        return { created: false, message: CHAIN_UNAVAILABLE_MESSAGE };
      }
      const { network } = readPodCreatorConfig(ctx);
      const created = await gateway.confirmPodCreation(
        { txHash, network },
        ctx,
      );
      await sessionsFor(ctx).clear(ctx.user.did, threadId(ctx));
      ctx.logger.log(
        `[pod-creator] confirmed POD ${created.podDid} tx=${txHash} user=${ctx.user.did} thread=${threadId(ctx)}`,
      );
      return {
        created: true,
        podDid: created.podDid,
        summary: created.summary,
      };
    },
    {
      name: 'confirm_pod_creation',
      description:
        'Confirm the POD was created on-chain from the signed transaction hash; returns the new POD DID.',
      schema: confirmSchema,
    },
  );

  return [prepare, approve, requestSignature, confirm];
}
