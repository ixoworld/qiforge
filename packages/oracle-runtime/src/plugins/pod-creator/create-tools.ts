import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { ApprovalStore } from './approval-store.js';
import type { BlueprintStore } from './blueprint-store.js';
import type { ChainGateway } from './chain-gateway.js';
import { assembleServicePodBlueprint, computeReadiness } from './stage.js';

const threadId = (ctx: RuntimeContext): string => ctx.session.id;

const configReadSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
  POD_CREATOR_ALLOW_MAINNET: z
    .union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ])
    .optional(),
});

/** Network routing + the mainnet opt-in, read from the merged config. */
function readConfig(ctx: RuntimeContext): {
  network: string;
  mainnetAllowed: boolean;
} {
  const parsed = configReadSchema.safeParse(ctx.config);
  if (!parsed.success) {
    return { network: 'testnet', mainnetAllowed: false };
  }
  return {
    network: parsed.data.NETWORK ?? 'testnet',
    mainnetAllowed: parsed.data.POD_CREATOR_ALLOW_MAINNET ?? false,
  };
}

const blobIdSchema = z.object({
  blobId: z
    .string()
    .describe('The blobId returned by prepare_pod_transaction.'),
});

const confirmSchema = z.object({
  txHash: z
    .string()
    .min(1)
    .describe('The transaction hash the wallet returned after broadcasting.'),
});

/** Validate a blobId and confirm the prepared batch is still retrievable. */
async function requirePreparedBlob(
  ctx: RuntimeContext,
  blobId: string,
): Promise<void> {
  if (!ctx.blobStore.isValidBlobId(blobId)) {
    throw new Error(`Invalid blobId: ${blobId}`);
  }
  const blob = await ctx.blobStore.get({ userDid: ctx.user.did, blobId });
  if (!blob) {
    throw new Error(
      'Prepared transaction not found or expired. Call prepare_pod_transaction again.',
    );
  }
}

/**
 * The on-chain create path — a non-blocking propose → approve → commit handoff
 * that keeps the oracle out of the signing loop:
 *
 * - `prepare_pod_transaction` (propose) builds the UNSIGNED batch and stashes the
 *   bytes in the blob store (the LLM only ever sees a short `blobId`). It refuses
 *   on mainnet unless `POD_CREATOR_ALLOW_MAINNET` is set, and supersedes any prior
 *   approval.
 * - `approve_pod_transaction` (approve) records the user's explicit go-ahead for a
 *   specific `blobId`, after the agent has shown them the summary.
 * - `request_pod_signature` (commit) refuses unless that exact batch is approved,
 *   then emits the `sign_transaction` AG-UI action for the user's wallet.
 * - `confirm_pod_creation` reads the created POD back from the broadcast tx hash.
 *
 * The whole path only matters once the launch-readiness gate passes. The binding
 * hard gates are the operator's mainnet opt-in and the wallet signature itself —
 * the oracle never signs creation.
 */
export function createCreateTools(
  store: BlueprintStore,
  gateway: ChainGateway,
  approvals: ApprovalStore,
): PluginTool[] {
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
      const { network, mainnetAllowed } = readConfig(ctx);
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
      // A freshly prepared batch must be re-approved before it can be signed.
      await approvals.clear(threadId(ctx));
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
      await approvals.approve(threadId(ctx), blobId);
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
      await requirePreparedBlob(ctx, blobId);
      if (!(await approvals.isApproved(threadId(ctx), blobId))) {
        throw new Error(
          'Transaction not approved. Call approve_pod_transaction after the user explicitly confirms the batch.',
        );
      }
      const { network } = readConfig(ctx);
      ctx.emit.actionCall({
        toolName: 'sign_transaction',
        ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
        args: { blobId, network },
      });
      return {
        requested: true,
        message:
          'Sign request sent to the wallet. Once the user signs and broadcasts, call confirm_pod_creation with the txHash.',
      };
    },
    {
      name: 'request_pod_signature',
      description:
        "Hand the approved unsigned transaction to the user's wallet to sign and broadcast (emits the sign_transaction action). Refuses unless approve_pod_transaction recorded approval for this exact blobId.",
      schema: blobIdSchema,
    },
  );

  const confirm = tool(
    async (args, ctx) => {
      const { txHash } = confirmSchema.parse(args);
      const { network } = readConfig(ctx);
      const created = await gateway.confirmPodCreation(
        { txHash, network },
        ctx,
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
