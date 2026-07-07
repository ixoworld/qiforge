import { callAgAction } from '@ixo/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { BlueprintStore } from './blueprint-store.js';
import {
  notConfiguredChainGateway,
  type ChainGateway,
} from './chain-gateway.js';
import { readPodCreatorConfig } from './config.js';
import type { CreateSessionStore } from './create-session-store.js';
import { assembleServicePodBlueprint, computeReadiness } from './stage.js';

const threadId = (ctx: RuntimeContext): string => ctx.session.id;

/** The AG-UI action the client must register to sign POD creation batches. */
export const SIGN_TRANSACTION_ACTION = 'sign_transaction';

/**
 * Wallet review + broadcast takes far longer than a UI render, so the sign
 * round-trip gets its own generous deadline.
 */
const SIGN_TIMEOUT_MS = 120_000;

/** Cosmos SDK transaction hash: 32 bytes hex. */
const TX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

const blobIdSchema = z.object({
  blobId: z
    .string()
    .describe('The blobId returned by prepare_pod_transaction.'),
});

const confirmSchema = z.object({
  txHash: z
    .string()
    .regex(TX_HASH_PATTERN, 'expected a 64-character hex transaction hash')
    .describe('The transaction hash the wallet returned after broadcasting.'),
});

const signResultSchema = z.object({
  txHash: z.string().regex(TX_HASH_PATTERN),
});

const CHAIN_UNAVAILABLE_MESSAGE =
  'On-chain POD creation is not yet enabled on this oracle — the chain ' +
  'gateway is not configured. The design blueprint is saved; creation can ' +
  'proceed once the operator wires the IXO MCP chain gateway.';

/**
 * Validate a blobId and return the stored batch, throwing when it is missing
 * or expired so the agent knows to re-prepare.
 */
async function requirePreparedBlob(
  ctx: RuntimeContext,
  blobId: string,
): Promise<{ name: string; value: string }> {
  if (!ctx.blobStore.isValidBlobId(blobId)) {
    throw new Error(`Invalid blobId: ${blobId}`);
  }
  const blob = await ctx.blobStore.get({ userDid: ctx.user.did, blobId });
  if (!blob) {
    throw new Error(
      'Prepared transaction not found or expired. Call prepare_pod_transaction again.',
    );
  }
  return blob;
}

/**
 * The on-chain create path — a propose → approve → commit handoff that keeps
 * the oracle out of the signing loop:
 *
 * - `prepare_pod_transaction` (propose) builds the UNSIGNED batch and stashes
 *   the bytes in the blob store (the LLM only ever sees a short `blobId`). It
 *   refuses on mainnet unless `POD_CREATOR_ALLOW_MAINNET` is set, and
 *   supersedes any prior approval.
 * - `approve_pod_transaction` (approve) binds the user's explicit go-ahead to
 *   the exact batch prepared in this conversation.
 * - `request_pod_signature` (commit) SPENDS that approval, then runs the
 *   blocking `sign_transaction` AG-UI round-trip: the unsigned bytes travel to
 *   the wallet in the action args (never through model context) and the
 *   broadcast txHash comes back as the result. A second dispatch always needs
 *   a fresh approval — a sign request cannot be replayed.
 * - `confirm_pod_creation` resolves the created POD from the broadcast tx and
 *   closes the session.
 *
 * The whole path only matters once the launch-readiness gate passes. The
 * binding hard gates are the operator's mainnet opt-in and the wallet
 * signature itself — the oracle never signs creation.
 */
export function createCreateTools(
  store: BlueprintStore,
  gateway: ChainGateway,
  sessions: CreateSessionStore,
): PluginTool[] {
  const chainUnavailable = gateway === notConfiguredChainGateway;

  const prepare = tool(
    async (_args, ctx) => {
      const bp = await store.get(threadId(ctx));
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
      const batch = await gateway.prepareUnsignedPodBatch(
        { blueprint, network },
        ctx,
      );
      const blobId = await ctx.blobStore.put({
        userDid: ctx.user.did,
        name: 'pod-unsigned-tx',
        value: batch.unsignedTx,
      });
      await sessions.prepared(ctx.user.did, threadId(ctx), blobId);
      ctx.logger.log(
        `[pod-creator] prepared batch ${blobId} (${batch.messageCount} msgs, ${network}) user=${ctx.user.did} thread=${threadId(ctx)}`,
      );
      return {
        prepared: true,
        blobId,
        summary: batch.summary,
        messageCount: batch.messageCount,
        ...(batch.estimatedCost !== undefined
          ? { estimatedCost: batch.estimatedCost }
          : {}),
        message:
          'Unsigned transaction prepared. Show the summary to the user and call approve_pod_transaction once they explicitly confirm.',
      };
    },
    {
      name: 'prepare_pod_transaction',
      description:
        'Build the UNSIGNED on-chain POD creation batch from the approved blueprint and stash it for the user to sign. Only works once the launch-readiness gate has passed; refuses on mainnet unless the operator opted in.',
      schema: z.object({}),
    },
  );

  const approve = tool(
    async (args, ctx) => {
      const { blobId } = blobIdSchema.parse(args);
      await requirePreparedBlob(ctx, blobId);
      const bound = await sessions.approve(ctx.user.did, threadId(ctx), blobId);
      if (!bound) {
        return {
          approved: false,
          message:
            'That blobId is not the batch prepared in this conversation. Call prepare_pod_transaction and approve the blobId it returns.',
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
        "Record the user's explicit approval of the prepared batch (blobId). Call only after showing the batch summary and the user confirms in their own words. request_pod_signature refuses until this approval is recorded.",
      schema: blobIdSchema,
    },
  );

  const requestSignature = tool(
    async (args, ctx) => {
      const { blobId } = blobIdSchema.parse(args);
      const blob = await requirePreparedBlob(ctx, blobId);
      const { network, mainnetAllowed } = readPodCreatorConfig(ctx);
      if (network === 'mainnet' && !mainnetAllowed) {
        throw new Error(
          'Mainnet POD creation is disabled; cannot request a signature.',
        );
      }
      const consumed = await sessions.consume(
        ctx.user.did,
        threadId(ctx),
        blobId,
      );
      if (!consumed) {
        throw new Error(
          'Transaction not approved (or its approval was already used). Call approve_pod_transaction after the user explicitly confirms the batch.',
        );
      }
      const toolCallId = `pod_${ctx.session.requestId || 'noreq'}_${randomUUID().slice(0, 8)}`;
      try {
        const result = await callAgAction({
          sessionId: ctx.session.id,
          toolCallId,
          toolName: SIGN_TRANSACTION_ACTION,
          args: { blobId, unsignedTx: blob.value, network },
          timeout: SIGN_TIMEOUT_MS,
        });
        const parsed = signResultSchema.safeParse(result);
        if (parsed.success) {
          ctx.logger.log(
            `[pod-creator] wallet signed batch ${blobId} tx=${parsed.data.txHash} user=${ctx.user.did} thread=${threadId(ctx)}`,
          );
          return {
            requested: true,
            txHash: parsed.data.txHash,
            message:
              'Wallet signed and broadcast the transaction. Call confirm_pod_creation with this txHash.',
          };
        }
        ctx.logger.warn(
          `[pod-creator] sign result for ${blobId} carried no txHash`,
        );
        return {
          requested: true,
          txHash: null,
          message:
            'The wallet responded without a transaction hash. If the user has the txHash, call confirm_pod_creation with it; otherwise re-approve and retry.',
        };
      } catch (error) {
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        ctx.logger.warn(
          `[pod-creator] sign dispatch for ${blobId} failed: ${detail}`,
        );
        return {
          requested: true,
          txHash: null,
          message:
            'The wallet did not complete signing (timed out, unsupported by this client, or rejected). The approval was spent — to retry, get the user to confirm again and call approve_pod_transaction, then request_pod_signature.',
        };
      }
    },
    {
      name: 'request_pod_signature',
      description:
        "Send the approved unsigned transaction to the user's wallet to sign and broadcast (blocking sign_transaction AG-UI round-trip; returns the txHash on success). Spends the approval — each dispatch needs a fresh approve_pod_transaction.",
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
      await sessions.clear(ctx.user.did, threadId(ctx));
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
