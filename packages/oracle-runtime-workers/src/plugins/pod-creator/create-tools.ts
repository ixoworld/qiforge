import {
  ITrxMsgSchema,
  NetworkSchema,
  RiskConfirmationSchema,
  SIGN_TRANSACTION_ACTION_NAME,
  buildBatchSignTransactionActionArgs,
  describeValidationError,
  validateTransactionBatch,
  type BatchMessageRoute,
  type ITrxMsg,
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
  type PodConfirmation,
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

/**
 * Characters plain text never carries: format characters (bidi overrides,
 * zero-width), line and paragraph separators, private-use and unassigned
 * code points.
 */
const INVISIBLE_CHARACTERS = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
/** Control characters, which a one-line name never carries. */
const CONTROL_CHARACTERS = /\p{Cc}/u;
/** Control characters other than a line break or a tab. */
const CONTROL_EXCEPT_LINES = /[^\P{Cc}\n\t]/u;

/** The longest POD description: it is quoted in full in the batch summary the user approves. */
export const MAX_POD_DESCRIPTION_LENGTH = 600;

const prepareSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(
      (name) =>
        !CONTROL_CHARACTERS.test(name) && !INVISIBLE_CHARACTERS.test(name),
      { message: 'The name is one line of plain text.' },
    )
    .describe(
      "The POD's name exactly as the user agreed it in the design (plain text, at most 100 characters). It is the name on the POD's public profile.",
    ),
  description: z
    .string()
    .trim()
    .max(MAX_POD_DESCRIPTION_LENGTH)
    .refine(
      (text) =>
        !CONTROL_EXCEPT_LINES.test(text) && !INVISIBLE_CHARACTERS.test(text),
      { message: 'The description is plain text.' },
    )
    .optional()
    .describe(
      `One or two plain sentences on what the POD does, from the design (at most ${MAX_POD_DESCRIPTION_LENGTH} characters). Shown on its public profile.`,
    ),
});

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

const emptySchema = z.object({});

const ADD_LINKED_RESOURCE = '/ixo.iid.v1beta1.MsgAddLinkedResource';
/** The linked resource id of an entity's domain card, which the chain fills in. */
const DOMAIN_CARD_RESOURCE_ID = '{id}#dmn';

const domainCardMessageSchema = z.object({
  id: z.string(),
  linkedResource: z.object({ id: z.string() }),
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
    /** The profile the user agreed, for the POD's domain card later. */
    profile: z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
    /** The documents the messages name, uploaded after approval. */
    documents: z.array(
      z
        .object({
          mxc: z.string(),
          contentType: z.string(),
          filename: z.string(),
          text: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

type StoredBatch = z.infer<typeof storedBatchSchema>;

const CHAIN_UNAVAILABLE_MESSAGE =
  'On-chain POD creation is turned off on this oracle: it was built ' +
  'without a chain gateway. The design blueprint is saved; creating the ' +
  'POD on chain needs an oracle that has one.';

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
    {
      network: batch.network,
      summary: batch.summary,
      messages: batch.messages,
      riskConfirmation: options.riskConfirmation,
    },
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

/** What `confirm_pod_creation` returns to the model. */
export type ConfirmPodCreationResult =
  | {
      created: true;
      podDid: string;
      /** The POD in the Portal. */
      portalUrl: string;
      summary: string;
      message: string;
    }
  | {
      created: false;
      status: Exclude<PodConfirmation['status'], 'created'>;
      /** True: call again later with the same hash. */
      retryable: boolean;
      message: string;
    };

/** What `add_pod_domain_card` returns to the model. */
export type AddPodDomainCardResult =
  | { status: 'added'; podDid: string; txHash?: string; message: string }
  | { status: 'refused'; message: string }
  | {
      status: 'failed';
      code: number;
      txHash?: string;
      error: string;
      message: string;
    }
  | {
      status: 'rejected' | 'error' | 'unavailable';
      error: string;
      message: string;
    }
  | { status: 'timeout'; outcome: 'unknown'; error: string };

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
    async (args, ctx) => {
      const profile = prepareSchema.parse(args);
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
        { blueprint, network, profile },
        ctx,
      );
      if (!prepared.ok) {
        ctx.logger.warn(
          `[pod-creator] prepare refused user=${ctx.user.did} thread=${threadId(ctx)}: ${prepared.message}`,
        );
        return {
          prepared: false,
          retryable: prepared.retryable,
          message: prepared.retryable
            ? `${prepared.message} Nothing was prepared; call prepare_pod_transaction again shortly.`
            : `${prepared.message} Nothing was prepared; tell the user what is needed.`,
        };
      }
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
        profile,
        documents: prepared.documents,
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
        name: profile.name,
        description: profile.description ?? '',
        summary: batch.summary,
        messageCount: batch.messages.length,
        messages: batch.routes.map((route) => route.messageName),
        risks: batch.risks,
        riskLevel: batch.riskLevel,
        ...(prepared.estimatedCost !== undefined
          ? { estimatedCost: prepared.estimatedCost }
          : {}),
        message:
          'Transaction batch prepared. Show the user the summary (with the exact public name and description) and every risk, word for word, and stop: approve_pod_transaction only works on a later message in which the user explicitly confirms, and needs each risk they accepted quoted exactly. Nothing is public yet: the profile is published only after their approval.',
      };
    },
    {
      name: 'prepare_pod_transaction',
      description:
        "Build the on-chain POD creation batch (unsigned messages) from the approved blueprint, with the POD's name and description from the design, and stash it for the user to sign in their own wallet. Reserves the POD's public profile (name and description), which is published only once the user approved the batch. Returns its summary, message names and risks, or prepared: false with what is missing. Only works once the launch-readiness gate has passed; refuses on mainnet unless the operator opted in.",
      schema: prepareSchema,
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
          network: batch.network,
          summary: batch.summary,
          messages: batch.messages,
          riskConfirmation: { confirmed: true, acceptedRisks: risks },
        },
        { allowMainnet: mainnetAllowed, chainIds },
      );
      const notApproved = new Error(
        'Transaction not approved (or its approval was already used). Call approve_pod_transaction after the user explicitly confirms the batch.',
      );
      const session = await sessionsFor(ctx).read(ctx.user.did, threadId(ctx));
      if (session?.approvedBlobId !== blobId) throw notApproved;
      // The profile becomes public only now, after the user's approval and
      // before it is spent: a homeserver that is down keeps the approval.
      if (batch.documents.length > 0) {
        const published = await gateway.publishDocuments(
          { documents: batch.documents },
          ctx,
        );
        if (!published.ok) {
          ctx.logger.warn(
            `[pod-creator] profile not published for batch ${blobId} user=${ctx.user.did}: ${published.message}`,
          );
          return {
            status: 'unavailable',
            error: published.message,
            message: published.retryable
              ? "Nothing was sent and the approval is kept: the POD's profile could not be published yet. Call request_pod_signature again in a moment."
              : "Nothing was sent: the POD's profile cannot be published from this batch. Call prepare_pod_transaction again, show the user the new batch and ask them to approve it.",
          };
        }
      }
      const consumed = await sessionsFor(ctx).consume(
        ctx.user.did,
        threadId(ctx),
        blobId,
        { messages: batch.messages, profile: batch.profile },
      );
      if (!consumed) throw notApproved;
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
    async (args, ctx): Promise<ConfirmPodCreationResult> => {
      const { txHash } = confirmSchema.parse(args);
      if (chainUnavailable) {
        return {
          created: false,
          status: 'unavailable',
          retryable: false,
          message: CHAIN_UNAVAILABLE_MESSAGE,
        };
      }
      const sessions = sessionsFor(ctx);
      const session = await sessions.read(ctx.user.did, threadId(ctx));
      if (!session?.sent) {
        return {
          created: false,
          status: 'failed',
          retryable: false,
          message:
            'No POD batch was sent for signing in this conversation (or it was more than an hour ago), so there is nothing to confirm here. A POD is confirmed in the conversation that prepared and sent it.',
        };
      }
      const { network, portalUrl } = readPodCreatorConfig(ctx);
      const outcome = await gateway.confirmPodCreation(
        { txHash, network, sent: session.sent },
        ctx,
      );
      const audit = `tx=${txHash} user=${ctx.user.did} thread=${threadId(ctx)}`;
      if (outcome.status !== 'created') {
        ctx.logger.warn(
          `[pod-creator] confirm ${outcome.status} ${audit}: ${outcome.message}`,
        );
        return {
          created: false,
          status: outcome.status,
          retryable: outcome.retryable,
          message: outcome.message,
        };
      }
      await sessions.confirmed(ctx.user.did, threadId(ctx), {
        podDid: outcome.podDid,
        txHash,
      });
      ctx.logger.log(`[pod-creator] confirmed POD ${outcome.podDid} ${audit}`);
      return {
        created: true,
        podDid: outcome.podDid,
        portalUrl: `${portalUrl}/domain/${outcome.podDid}/overview`,
        summary: outcome.summary,
        message:
          "Tell the user the POD exists and give them its Portal link; its public profile (name and description) is published. Then offer the next step: add the POD's public domain card (add_pod_domain_card, one more wallet signature), so the Portal lists it and search finds it.",
      };
    },
    {
      name: 'confirm_pod_creation',
      description:
        'Confirm the POD was created on chain from the signed transaction hash; returns the new POD DID and its Portal link. Reads the chain for up to 20 s: created: false with status pending (not on chain yet) or unavailable (chain not readable) and retryable: true means call it again later with the same hash; status failed means no POD of this conversation was created (do not retry).',
      schema: confirmSchema,
      effect: 'read',
    },
  );

  const addDomainCard = tool(
    async (args, ctx): Promise<AddPodDomainCardResult> => {
      emptySchema.parse(args);
      if (chainUnavailable) {
        return {
          status: 'unavailable',
          error: CHAIN_UNAVAILABLE_MESSAGE,
          message: 'Nothing was sent.',
        };
      }
      const { network, mainnetAllowed, chainIds } = readPodCreatorConfig(ctx);
      if (network === 'mainnet' && !mainnetAllowed) {
        return {
          status: 'refused',
          message:
            'Mainnet POD creation is disabled on this oracle (POD_CREATOR_ALLOW_MAINNET), so no domain card is added.',
        };
      }
      const unavailable = walletUnavailableReason(ctx);
      if (unavailable !== null) {
        return {
          status: 'unavailable',
          error: unavailable,
          message:
            'Nothing was sent: call add_pod_domain_card again once the user has the chat open in the Portal.',
        };
      }
      const sessions = sessionsFor(ctx);
      const claim = await sessions.claimCard(ctx.user.did, threadId(ctx));
      if (claim.status === 'no-pod') {
        return {
          status: 'refused',
          message:
            'No POD was confirmed in this conversation (confirm_pod_creation first), so there is no POD to add a domain card to.',
        };
      }
      if (claim.status === 'claimed') {
        return {
          status: 'refused',
          message:
            claim.state === 'added'
              ? 'The domain card of this POD was already added; it is added once.'
              : 'The domain card of this POD was already sent to the wallet and its outcome is not known. Ask the user whether they signed it; do not send it again.',
        };
      }
      const { podDid } = claim;
      const release = () =>
        sessions.settleCard(ctx.user.did, threadId(ctx), 'released');
      const prepared = await gateway.prepareDomainCard(
        { network, podDid, profile: claim.sent.profile },
        ctx,
      );
      if (!prepared.ok) {
        await release();
        return {
          status: 'unavailable',
          error: prepared.message,
          message: prepared.retryable
            ? 'Nothing was sent: call add_pod_domain_card again in a moment.'
            : 'Nothing was sent: tell the user what is needed.',
        };
      }
      let signArgs: ReturnType<typeof buildBatchSignTransactionActionArgs>;
      try {
        const batch = validateTransactionBatch(
          { messages: prepared.messages, summary: prepared.summary, network },
          { allowMainnet: mainnetAllowed },
        );
        const notCard = domainCardBatchProblem(batch.routes, prepared, podDid);
        if (notCard !== null) throw new Error(notCard);
        // The user reviews and signs the card in the Portal's own consent
        // prompt: an update of an entity they own, nothing else.
        signArgs = buildBatchSignTransactionActionArgs(
          {
            network,
            summary: batch.summary,
            messages: batch.messages,
            riskConfirmation: { confirmed: true, acceptedRisks: batch.risks },
          },
          { allowMainnet: mainnetAllowed, chainIds },
        );
      } catch (error) {
        await release();
        throw new Error(
          `The chain gateway built a domain card batch the wallet would refuse: ${describeValidationError(error)}`,
        );
      }
      const published = await gateway.publishDocuments(
        { documents: prepared.documents },
        ctx,
      );
      if (!published.ok) {
        await release();
        return {
          status: 'unavailable',
          error: published.message,
          message: published.retryable
            ? 'Nothing was sent: the card could not be published yet. Call add_pod_domain_card again in a moment.'
            : 'Nothing was sent: the card could not be published. Tell the user.',
        };
      }
      const outcome = await requestWalletSignature(ctx, {
        args: signArgs,
        callIdPrefix: 'pod_card',
        timeoutMs: SIGN_TIMEOUT_MS,
      });
      const audit = `card of ${podDid} user=${ctx.user.did} thread=${threadId(ctx)}`;
      switch (outcome.status) {
        case 'signed': {
          await sessions.settleCard(ctx.user.did, threadId(ctx), 'added');
          ctx.logger.log(
            `[pod-creator] wallet signed ${audit} tx=${outcome.transactionHash ?? 'none'}`,
          );
          await gateway.requestIndexing({ network, podDid }, ctx);
          return {
            status: 'added',
            podDid,
            ...(outcome.transactionHash !== undefined
              ? { txHash: outcome.transactionHash }
              : {}),
            message:
              'The domain card was added. The domain indexer was asked to index the POD; it can take a few minutes to show in the Portal lists and search.',
          };
        }
        case 'failed':
          await release();
          ctx.logger.warn(
            `[pod-creator] card failed on chain ${audit} code=${outcome.code}`,
          );
          return {
            status: 'failed',
            code: outcome.code,
            ...(outcome.transactionHash !== undefined
              ? { txHash: outcome.transactionHash }
              : {}),
            error: outcome.error,
            message:
              'The transaction failed on chain, so no card was added. Tell the user the code and error.',
          };
        case 'rejected':
        case 'error':
        case 'unavailable':
          await release();
          ctx.logger.warn(
            `[pod-creator] card ${outcome.status} ${audit}: ${outcome.error}`,
          );
          return {
            status: outcome.status,
            error: outcome.error,
            message:
              'Nothing was signed. If the user wants the card, call add_pod_domain_card again.',
          };
        case 'timeout':
          ctx.logger.warn(`[pod-creator] card outcome unknown ${audit}`);
          return outcome;
      }
    },
    {
      name: 'add_pod_domain_card',
      description:
        "After confirm_pod_creation: add the new POD's public domain card (its name and description, as the Portal publishes for a domain it creates) with one wallet signature in the Portal, then ask the domain indexer to index it, so the POD shows in the Portal's lists and search. Offer it to the user; it runs once per POD.",
      schema: emptySchema,
    },
  );

  return [prepare, approve, requestSignature, confirm, addDomainCard];
}

/**
 * Why a validated batch is not the domain card of `podDid`, or null when it
 * is: one `MsgAddLinkedResource` on the POD, its `{id}#dmn` card.
 */
function domainCardBatchProblem(
  routes: readonly BatchMessageRoute[],
  prepared: { messages: readonly ITrxMsg[] },
  podDid: string,
): string | null {
  const [message] = prepared.messages;
  const card = domainCardMessageSchema.safeParse(message?.value);
  if (
    routes.length !== 1 ||
    routes[0]?.typeUrl !== ADD_LINKED_RESOURCE ||
    !card.success ||
    card.data.id !== podDid ||
    card.data.linkedResource.id !== DOMAIN_CARD_RESOURCE_ID
  )
    return `A domain card batch is one ${ADD_LINKED_RESOURCE} of ${DOMAIN_CARD_RESOURCE_ID} on ${podDid}`;
  return null;
}
