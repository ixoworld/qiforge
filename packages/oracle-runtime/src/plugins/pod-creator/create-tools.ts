import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { BlueprintStore } from './blueprint-store.js';
import type { ChainGateway } from './chain-gateway.js';
import { assembleServicePodBlueprint, computeReadiness } from './stage.js';

const threadId = (ctx: RuntimeContext): string => ctx.session.id;

const networkSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
});

/** Network routing hint from config; defaults to the safer testnet. */
function networkOf(ctx: RuntimeContext): string {
  const parsed = networkSchema.safeParse(ctx.config);
  return parsed.success ? (parsed.data.NETWORK ?? 'testnet') : 'testnet';
}

const requestSchema = z.object({
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

/**
 * The on-chain create path — a non-blocking, three-step handoff that keeps the
 * oracle out of the signing loop: `prepare` builds the UNSIGNED batch and stashes
 * the bytes in the blob store (the LLM only ever sees a short `blobId`),
 * `request_pod_signature` emits the `sign_transaction` AG-UI action for the
 * user's wallet, and `confirm_pod_creation` reads the created POD back from the
 * broadcast tx hash. All three only matter once the launch-readiness gate passes.
 */
export function createCreateTools(
  store: BlueprintStore,
  gateway: ChainGateway,
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
      const blueprint = assembleServicePodBlueprint(bp);
      const batch = await gateway.prepareUnsignedPodBatch(
        { blueprint, network: networkOf(ctx) },
        ctx,
      );
      const blobId = await ctx.blobStore.put({
        userDid: ctx.user.did,
        name: 'pod-unsigned-tx',
        value: batch.unsignedTx,
      });
      return {
        prepared: true,
        blobId,
        summary: batch.summary,
        messageCount: batch.messageCount,
        ...(batch.estimatedCost !== undefined
          ? { estimatedCost: batch.estimatedCost }
          : {}),
        message:
          'Unsigned transaction prepared. Review the summary with the user and obtain explicit approval before requesting a signature.',
      };
    },
    {
      name: 'prepare_pod_transaction',
      description:
        'Build the UNSIGNED on-chain POD creation batch from the approved blueprint and stash it for the user to sign. Only works once the launch-readiness gate has passed.',
      schema: z.object({}),
    },
  );

  const requestSignature = tool(
    async (args, ctx) => {
      const { blobId } = requestSchema.parse(args);
      if (!ctx.blobStore.isValidBlobId(blobId)) {
        throw new Error(`Invalid blobId: ${blobId}`);
      }
      const blob = await ctx.blobStore.get({ userDid: ctx.user.did, blobId });
      if (!blob) {
        throw new Error(
          'Prepared transaction not found or expired. Call prepare_pod_transaction again.',
        );
      }
      ctx.emit.actionCall({
        toolName: 'sign_transaction',
        ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
        args: { blobId, network: networkOf(ctx) },
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
        "Hand the prepared unsigned transaction to the user's wallet to sign and broadcast (emits the sign_transaction action). Call only after the user has approved the batch.",
      schema: requestSchema,
    },
  );

  const confirm = tool(
    async (args, ctx) => {
      const { txHash } = confirmSchema.parse(args);
      const created = await gateway.confirmPodCreation(
        { txHash, network: networkOf(ctx) },
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

  return [prepare, requestSignature, confirm];
}
