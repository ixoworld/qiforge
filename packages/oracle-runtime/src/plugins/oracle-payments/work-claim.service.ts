import { z } from 'zod';
import { postOracleComponent } from '../../matrix/oracle-component-event.js';
import { sendFileToRoom, type RoomFileSend } from '../../matrix/room-file.js';
import {
  workStatusProducer,
  type WorkStatusProducer,
} from '../../matrix/work-status-producer.js';
import type {
  CommerceEngagement,
  Logger,
  RuntimeContext,
} from '../../plugin-api/types.js';
import {
  getSandboxBridge,
  hasShellUnsafeChars,
  inferMimeFromPath,
  isUnderWorkspaceData,
  readSandboxFile,
} from '../sandbox/sandbox-bridge.js';
import type { SandboxMcpClientFactory } from '../sandbox/sandbox.plugin.js';
import {
  defaultClaimBotUploader,
  defaultClaimChainClient,
  type ClaimBotUploader,
  type ClaimChainClient,
  type ClaimCoin,
  type ClaimDeliverable,
  type ClaimNetwork,
  type SubmitClaimResult,
} from './claim-lane.js';
import type { ContractGateService } from './contract-gate.service.js';
import type { EngagementService } from './engagement.service.js';
import type { WorkSummaryExtractor } from './work-summary-extractor.js';
import {
  claimDeepLink,
  errorMessage,
  priceToCoin,
  readConfigNumber,
  readConfigString,
  retry,
  slugify,
  type RetryOptions,
} from './util.js';

/** Ceiling on the deliverable size when `ORACLE_PAYMENTS_MAX_DELIVERABLE_MB` is unset. */
export const DEFAULT_MAX_DELIVERABLE_MB = 25;

const BYTES_PER_MB = 1024 * 1024;

export const deliverWorkSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe(
      'One or two sentences shown to the user in the chat next to the delivered file.',
    ),
  resultStatus: z
    .enum(['completed', 'partial', 'unable'])
    .describe(
      'Honest outcome of the work: completed, partial, or unable. Recorded verbatim on the payment record and independently evaluated — never overstate it.',
    ),
  deliverable: z
    .object({
      kind: z
        .enum(['text', 'file'])
        .describe(
          "'text' to hand over written content you compose here; 'file' for a file you produced in the sandbox.",
        ),
      text: z
        .string()
        .optional()
        .describe(
          'kind=text: the full deliverable content in markdown. Not a summary — the actual work product.',
        ),
      sandboxPath: z
        .string()
        .optional()
        .describe(
          'kind=file: absolute sandbox path of the finished file, under /workspace/data/.',
        ),
      fileName: z
        .string()
        .optional()
        .describe('File name shown to the user. Defaults from the path.'),
      mediaType: z
        .string()
        .optional()
        .describe('MIME type. Defaults from the file extension.'),
    })
    .describe('The work product itself, handed to the user as a file.'),
  proofs: z
    .string()
    .optional()
    .describe(
      'Optional evidence backing the work: source links, transaction hashes, log excerpts.',
    ),
});

export type DeliverWorkArgs = z.infer<typeof deliverWorkSchema>;

export const cancelWorkSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe("The user's stated reason for cancelling, when they gave one."),
});

export type CancelWorkArgs = z.infer<typeof cancelWorkSchema>;

/** What `cancel_work` returns to the model so its confirmation is grounded. */
export interface CancelWorkResult {
  cancelled: boolean;
  serviceId?: string;
  serviceName?: string;
  /** The release claim that freed the reservation, when one was needed. */
  claimId?: string;
  txHash?: string;
  note: string;
}

/** What `deliver_work` returns to the model so its closing message is grounded. */
export interface DeliverWorkResult {
  claimId: string;
  txHash: string;
  delivered: true;
  /** Set when the call resumed an already-signed or already-submitted claim. */
  note?: string;
}

/** Uploads the deliverable into the user's room. Injected for tests. */
export type RoomFileUploader = (input: RoomFileSend) => Promise<string>;

export interface WorkClaimServiceDeps {
  engagement: EngagementService;
  contractGate: ContractGateService;
  extractor: WorkSummaryExtractor;
  /** Reads the oracle's decrypted claim-signing mnemonic (wired at boot). */
  getSigningMnemonic?: () => string | null;
  uploadToRoom?: RoomFileUploader;
  uploadToClaimBot?: ClaimBotUploader;
  chain?: ClaimChainClient;
  /** Sandbox MCP client factory — tests inject a stub bridge. */
  mcpClientFactory?: SandboxMcpClientFactory;
  /** Status-card sink; only `emit` is used (the `delivering` phase). */
  statusProducer?: Pick<WorkStatusProducer, 'emit'>;
  clock?: () => Date;
  /** Sleep seam for the release lane's bounded chain retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

const NO_ENGAGEMENT_MESSAGE =
  'There is no active work engagement in this thread, so there is nothing to deliver. ' +
  'Never call deliver_work outside a contracted engagement — the user has to contract the ' +
  'service first, which starts the engagement.';

const CLOSED_PREFIX =
  'The engagement is closed; this thread returns to support from the next message.';

/**
 * What the model must tell the user when the release did not reach the chain.
 * The reservation is still held, so promising a fresh start here would be a
 * lie — and the retry that fixes it is another `cancel_work`.
 */
const RELEASE_FAILED_SUFFIX =
  'The cancellation is recorded, but the payment reserved for this job is still held on-chain, ' +
  'so the user cannot start a new paid job yet. Tell them plainly that the cancellation did not ' +
  'go through, and that you will try again — calling cancel_work again retries the release.';

/**
 * The two lanes that end an engagement against the chain: `deliver_work` (hand
 * the finished work over and submit the claim that pays the oracle) and
 * `cancel_work` (submit a release claim that hands the reserved payment back).
 * Both settle the same escrow through the same signing and submission plumbing.
 *
 * Failure lanes are deliberate. Anything up to signing fails as a plain tool
 * error with the engagement left `active`, so the agent can retry. Once the
 * claim is signed its cid is persisted before the chain call, so a failed
 * submit resumes at submission on the next call and never re-signs or
 * re-uploads. Everything after a successful submit (receipt card, engagement
 * transition) is best-effort — a claim is never un-submitted because a card
 * failed to post.
 */
export class WorkClaimService {
  private readonly engagement: EngagementService;
  private readonly contractGate: ContractGateService;
  private readonly extractor: WorkSummaryExtractor;
  private getSigningMnemonic: () => string | null;
  private readonly uploadToRoom: RoomFileUploader;
  private readonly uploadToClaimBot: ClaimBotUploader;
  private readonly chain: ClaimChainClient;
  private readonly mcpClientFactory?: SandboxMcpClientFactory;
  private readonly statusProducer: Pick<WorkStatusProducer, 'emit'>;
  private readonly clock: () => Date;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly logger?: Logger;

  constructor(deps: WorkClaimServiceDeps) {
    this.engagement = deps.engagement;
    this.contractGate = deps.contractGate;
    this.extractor = deps.extractor;
    this.getSigningMnemonic = deps.getSigningMnemonic ?? (() => null);
    this.uploadToRoom = deps.uploadToRoom ?? sendFileToRoom;
    this.uploadToClaimBot = deps.uploadToClaimBot ?? defaultClaimBotUploader;
    this.chain = deps.chain ?? defaultClaimChainClient;
    this.mcpClientFactory = deps.mcpClientFactory;
    this.statusProducer = deps.statusProducer ?? workStatusProducer;
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep;
    this.logger = deps.logger;
  }

  /** Wire the oracle's signing-key reader (done once at module init). */
  setSigningMnemonicProvider(provider: () => string | null): void {
    this.getSigningMnemonic = provider;
  }

  async deliver(
    args: DeliverWorkArgs,
    ctx: RuntimeContext,
  ): Promise<DeliverWorkResult> {
    const roomId = ctx.session.roomId;
    if (!roomId) {
      throw new Error(
        'deliver_work applies only to Matrix work threads — no room on this session.',
      );
    }
    const threadId = ctx.session.id;

    const engagement = await this.engagement.getActive(roomId, threadId);
    if (!engagement) throw new Error(NO_ENGAGEMENT_MESSAGE);

    // The quota may have drained since the engagement started; the chain is
    // the final word at submission, but failing here keeps the claim honest.
    const gate = await this.contractGate.check({
      roomId,
      threadId,
      senderDid: ctx.user.did,
      service: {
        id: engagement.serviceId,
        name: engagement.serviceName,
        priceUsd: engagement.priceUsd,
      },
    });
    if (!gate.ok) {
      throw new Error(
        `This work can't be billed right now: the user's contract check failed (${gate.reason}). ` +
          'Explain this to the user and call show_contract so they can fix it — the work itself is not lost.',
      );
    }

    const signingMnemonic = this.getSigningMnemonic();
    if (!signingMnemonic) {
      throw new Error(
        "The oracle's claim signing key is not loaded yet, so the work record cannot be signed. Try again shortly.",
      );
    }

    this.statusProducer.emit(ctx.session.requestId, 'delivering');

    const network = this.network(ctx);
    const price = priceToCoin(engagement.priceUsd, network);
    const amount: ClaimCoin[] = [
      { denom: price.denom, amount: String(price.amount) },
    ];

    // Already submitted: never re-sign, never re-submit, never double-charge.
    // Ahead of the expiry guard on purpose — reporting a claim that is already
    // on-chain must not depend on the reservation still being open.
    if (engagement.claim?.cid && engagement.claim.txHash) {
      return {
        claimId: engagement.claim.cid,
        txHash: engagement.claim.txHash,
        delivered: true,
        note: 'This work was already delivered and its payment record already submitted — nothing was resubmitted.',
      };
    }

    // The escrow reserved at start has auto-released; a claim submitted against
    // it now would fail settlement, so fail here with something the agent can
    // actually explain.
    const expiresAt = engagement.intent?.expiresAt;
    if (expiresAt && Date.parse(expiresAt) <= this.clock().getTime()) {
      throw new Error(
        `The payment reserved for this work expired at ${expiresAt}, so it can no longer be claimed. ` +
          'Tell the user plainly that the reservation window closed, offer them the finished work, ' +
          'and explain they need to start the request again for it to be billable.',
      );
    }

    let claimId = engagement.claim?.cid;
    let workSummary: string | undefined;
    let deliverable:
      | { fileName: string; mediaType: string; matrixEventId: string }
      | undefined;

    if (!claimId) {
      const file = await this.materialize(args, ctx, engagement);
      const extractorModel = readConfigString(
        ctx.config,
        'ORACLE_PAYMENTS_EXTRACTOR_MODEL',
      );
      const extraction = await this.extractor.extract({
        messages: ctx.history.messages,
        serviceId: engagement.serviceId,
        serviceName: engagement.serviceName,
        ...(extractorModel !== undefined && { model: extractorModel }),
      });
      workSummary = extraction.workSummary;

      const matrixEventId = await this.uploadToRoom({
        roomId,
        fileName: file.fileName,
        mediaType: file.mediaType,
        bytes: file.bytes,
        ...(ctx.session.client === 'matrix' ? { threadId } : {}),
      });
      deliverable = {
        fileName: file.fileName,
        mediaType: file.mediaType,
        matrixEventId,
      };

      const entry = await this.uploadToClaimBot({
        collectionId: engagement.collectionId,
        fileName: file.fileName,
        mediaType: file.mediaType,
        bytes: file.bytes,
        oracleDid: this.requireConfig(ctx, 'ORACLE_DID'),
        signingMnemonic,
        network,
      });

      // The claim's own trusted fields — the agent supplies neither.
      const body = buildClaimBody({
        service: engagement.serviceId,
        request: extraction.request,
        workSummary: extraction.workSummary,
        resultStatus: args.resultStatus,
        deliverables: [entry],
        ...(args.proofs !== undefined && { proofs: args.proofs }),
      });

      // Abort-deferred critical section: a double-text must not tear a claim
      // in half. Past this check the signal is deliberately not consulted
      // again until the claim reaches a durable state.
      if (ctx.abortSignal.aborted) {
        throw new Error(
          'Delivery was interrupted before the payment record was signed — nothing was submitted. Call deliver_work again to finish.',
        );
      }

      claimId = await this.signClaim({
        ctx,
        body,
        amount,
        collectionId: engagement.collectionId,
        network,
        signingMnemonic,
      });

      // Persisted BEFORE the chain call: if the submit fails, the next call
      // resumes here instead of signing a second claim for the same work.
      await this.engagement.recordClaim(roomId, threadId, {
        cid: claimId,
        submittedAt: this.clock().toISOString(),
      });
    }

    // Always settles against the escrow locked at engagement start — the two
    // halves are unconditional, so a reserved job is never settled as an
    // unreserved one. Requires an evaluation engine that accepts
    // `useIntent: true` agent-work claims.
    const tx = await this.chain.submit({
      claimId,
      collectionId: engagement.collectionId,
      useIntent: true,
      amount,
    });
    if (tx.code !== 0) {
      throw new Error(
        `The payment record could not be submitted on-chain (code ${tx.code}): ${
          tx.rawLog || 'unknown chain error'
        }. The work is saved — deliver again to retry the submission.`,
      );
    }

    // Everything below is best-effort: the claim is submitted and must never
    // be reported as failed because a follow-up step did.
    await this.safely('record claim tx', () =>
      this.engagement.recordClaim(roomId, threadId, {
        cid: claimId,
        txHash: tx.transactionHash,
        submittedAt: this.clock().toISOString(),
      }),
    );

    await this.safely('post work_delivered card', () =>
      this.postReceipt(ctx, {
        roomId,
        threadId,
        engagement,
        args,
        claimId,
        txHash: tx.transactionHash,
        ...(workSummary !== undefined && { workSummary }),
        ...(deliverable !== undefined && { deliverable }),
      }),
    );

    await this.safely('close out engagement', () =>
      this.engagement.transition(roomId, threadId, 'delivered'),
    );

    return { claimId, txHash: tx.transactionHash, delivered: true };
  }

  /**
   * The `cancel_work` lane: end the engagement AND free the escrow reserved for
   * it. The chain has no cancel-intent message, so the only way to hand the
   * reservation back is to claim against it — honestly. This submits a release
   * claim: `resultStatus: 'unable'`, no deliverables, the user's reason carried
   * as proofs. Submitting fulfils the intent and drops it from the chain's
   * store, so the user can start a new paid job immediately; the claim then
   * fails the evaluator's deliverable gate and the escrow reverts to them.
   *
   * The engagement only leaves `active` once that claim is on-chain. A release
   * that fails leaves a cancelled-but-still-active engagement, which keeps
   * blocking new work (the reservation is genuinely still held) and is
   * retryable by calling the tool again.
   */
  async release(
    args: CancelWorkArgs,
    ctx: RuntimeContext,
  ): Promise<CancelWorkResult> {
    const roomId = ctx.session.roomId;
    if (!roomId) {
      throw new Error(
        'cancel_work applies only to Matrix work threads — no room on this session.',
      );
    }
    const threadId = ctx.session.id;

    const engagement = await this.engagement.getActive(roomId, threadId);
    if (!engagement) {
      return {
        cancelled: false,
        note: 'No active work engagement in this thread — nothing to cancel.',
      };
    }

    const identity = {
      serviceId: engagement.serviceId,
      serviceName: engagement.serviceName,
    };

    // A claim is already on-chain for this job (a release whose closing write
    // failed, or a delivery that never transitioned): the reservation is
    // settled, so finish the transition and never submit twice.
    if (engagement.claim?.txHash) {
      await this.engagement.cancel(roomId, threadId, args.reason);
      return {
        cancelled: true,
        ...identity,
        claimId: engagement.claim.cid,
        txHash: engagement.claim.txHash,
        note: `${CLOSED_PREFIX} The payment record for this job was already submitted on-chain, so its reservation is already released — the user can start a new paid job right now.`,
      };
    }

    // Nothing was reserved, so closing the engagement is the whole job.
    if (!engagement.intent) {
      await this.engagement.cancel(roomId, threadId, args.reason);
      return {
        cancelled: true,
        ...identity,
        note: `${CLOSED_PREFIX} No payment was reserved for this work, so there is nothing to release.`,
      };
    }

    // The reservation already lapsed on its own. Claiming against an intent
    // the chain no longer holds would only be rejected — and would leave the
    // engagement blocking a user nothing is actually blocking.
    const expiresAt = engagement.intent.expiresAt;
    if (expiresAt && Date.parse(expiresAt) <= this.clock().getTime()) {
      await this.engagement.cancel(roomId, threadId, args.reason);
      return {
        cancelled: true,
        ...identity,
        note:
          `${CLOSED_PREFIX} The payment reserved for this work had already expired at ${expiresAt} and ` +
          'released on its own, so there is nothing left to release. The user can start a new paid job right now.',
      };
    }

    const signingMnemonic = this.getSigningMnemonic();
    if (!signingMnemonic) {
      throw new Error(
        "The oracle's claim signing key is not loaded yet, so the reserved payment cannot be released. " +
          RELEASE_FAILED_SUFFIX,
      );
    }

    // Stamped before anything can fail: an engagement that still reads
    // `active` while carrying `cancelledAt` is a release the gate must report
    // as failed rather than as a job still being worked on.
    const marked = await this.engagement.markCancelRequested(
      roomId,
      threadId,
      args.reason,
    );
    const cancelledAt = marked?.cancelledAt ?? this.clock().toISOString();

    const network = this.network(ctx);
    const price = priceToCoin(engagement.priceUsd, network);
    const amount: ClaimCoin[] = [
      { denom: price.denom, amount: String(price.amount) },
    ];

    let claimId = engagement.claim?.cid;
    const resumed = claimId !== undefined;

    if (!claimId) {
      // Written here, not extracted: there is no delivered work to summarise,
      // so a model call would only invent one.
      const body = buildClaimBody({
        service: engagement.serviceId,
        request: releaseClaimRequest(engagement),
        workSummary: releaseClaimWorkSummary(
          engagement,
          cancelledAt,
          args.reason,
        ),
        resultStatus: 'unable',
        ...(args.reason !== undefined &&
          args.reason.length > 0 && {
            proofs: `Cancelled by the user. Reason given: ${args.reason}`,
          }),
      });

      try {
        claimId = await retry(
          () =>
            this.signClaim({
              ctx,
              body,
              amount,
              collectionId: engagement.collectionId,
              network,
              signingMnemonic,
            }),
          this.retryOptions('sign the cancellation record'),
        );
      } catch (error) {
        throw new Error(
          `The cancellation record could not be signed (${errorMessage(error)}). ` +
            RELEASE_FAILED_SUFFIX,
        );
      }

      // Persisted BEFORE the chain call, exactly as delivery does: a failed
      // submit resumes here instead of signing a second claim for the same job.
      await this.engagement.recordClaim(roomId, threadId, {
        cid: claimId,
        submittedAt: this.clock().toISOString(),
      });
    }

    const submitted = claimId;
    let tx: SubmitClaimResult;
    try {
      tx = await retry(
        () =>
          this.chain.submit({
            claimId: submitted,
            collectionId: engagement.collectionId,
            useIntent: true,
            amount,
          }),
        this.retryOptions('submit the cancellation record'),
      );
    } catch (error) {
      throw new Error(
        `The cancellation record could not be submitted on-chain (${errorMessage(error)}). ` +
          RELEASE_FAILED_SUFFIX,
      );
    }
    if (tx.code !== 0) {
      throw new Error(
        `The cancellation record was rejected on-chain (code ${tx.code}): ${
          tx.rawLog || 'unknown chain error'
        }. ${RELEASE_FAILED_SUFFIX}`,
      );
    }

    // Past this point the reservation is free; a failed write must not report
    // the release as failed and send the model into a needless retry.
    await this.safely('record the release claim tx', () =>
      this.engagement.recordClaim(roomId, threadId, {
        cid: submitted,
        txHash: tx.transactionHash,
        submittedAt: this.clock().toISOString(),
      }),
    );
    await this.safely('close out the cancelled engagement', () =>
      this.engagement.cancel(roomId, threadId, args.reason),
    );

    return {
      cancelled: true,
      ...identity,
      claimId: submitted,
      txHash: tx.transactionHash,
      note: releasedNote(submitted, resumed),
    };
  }

  /** Sign a claim as a VC and stash it, returning its cid (= the claim id). */
  private signClaim(input: {
    ctx: RuntimeContext;
    body: Record<string, unknown>;
    amount: ClaimCoin[];
    collectionId: string;
    network: ClaimNetwork;
    signingMnemonic: string;
  }): Promise<string> {
    const { ctx } = input;
    return this.chain.signAndSave({
      body: input.body,
      amount: input.amount,
      collectionId: input.collectionId,
      accessToken: this.requireConfig(ctx, 'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN'),
      matrixRoomId: this.requireConfig(ctx, 'MATRIX_ACCOUNT_ROOM_ID'),
      secpMnemonic: this.requireConfig(ctx, 'SECP_MNEMONIC'),
      matrixValuePin: this.requireConfig(ctx, 'MATRIX_VALUE_PIN'),
      oracleDid: this.requireConfig(ctx, 'ORACLE_DID'),
      network: input.network,
      decryptedSigningMnemonic: input.signingMnemonic,
    });
  }

  /**
   * Bounded backoff for the release lane's chain writes. Small on purpose: it
   * rides out a transport blip, and anything it cannot ride out surfaces as a
   * retryable tool error with the engagement still blocking.
   */
  private retryOptions(what: string): RetryOptions {
    return {
      attempts: 3,
      delayMs: 500,
      ...(this.sleep !== undefined && { sleep: this.sleep }),
      onRetry: (error, attempt) => {
        this.logger?.warn?.(
          `[oracle-payments] could not ${what} (attempt ${attempt}), retrying: ${errorMessage(error)}`,
        );
      },
    };
  }

  /**
   * Turn the agent's deliverable argument into real bytes. The claim's
   * deliverable gate rejects anything that doesn't resolve to a file, so a
   * text deliverable is materialized as a markdown file rather than pasted.
   */
  private async materialize(
    args: DeliverWorkArgs,
    ctx: RuntimeContext,
    engagement: CommerceEngagement,
  ): Promise<{ bytes: Buffer; fileName: string; mediaType: string }> {
    const maxBytes =
      (readConfigNumber(ctx.config, 'ORACLE_PAYMENTS_MAX_DELIVERABLE_MB') ??
        DEFAULT_MAX_DELIVERABLE_MB) * BYTES_PER_MB;

    const file =
      args.deliverable.kind === 'text'
        ? materializeText(args, engagement)
        : await this.readFromSandbox(args, ctx);

    if (file.bytes.length === 0) {
      throw new Error(
        'The deliverable is empty — there is nothing to hand over.',
      );
    }
    if (file.bytes.length > maxBytes) {
      throw new Error(
        `The deliverable is ${(file.bytes.length / BYTES_PER_MB).toFixed(1)} MB, over the ${(
          maxBytes / BYTES_PER_MB
        ).toFixed(0)} MB limit. Deliver a smaller file or split the work.`,
      );
    }
    return file;
  }

  private async readFromSandbox(
    args: DeliverWorkArgs,
    ctx: RuntimeContext,
  ): Promise<{ bytes: Buffer; fileName: string; mediaType: string }> {
    const sandboxPath = args.deliverable.sandboxPath;
    if (!sandboxPath) {
      throw new Error(
        'deliverable.sandboxPath is required when kind is "file".',
      );
    }
    if (!isUnderWorkspaceData(sandboxPath)) {
      throw new Error(
        `Deliverables must live under /workspace/data/ (got \`${sandboxPath}\`). Write the finished file there and deliver again.`,
      );
    }
    if (hasShellUnsafeChars(sandboxPath)) {
      throw new Error(
        `The path \`${sandboxPath}\` contains characters I can't safely handle (quotes or newlines). Rename the file and deliver again.`,
      );
    }

    const sandboxMcpUrl = readConfigString(ctx.config, 'SANDBOX_MCP_URL');
    if (!sandboxMcpUrl) {
      throw new Error(
        'This oracle has no sandbox configured, so a file deliverable cannot be read. Deliver the work as text instead.',
      );
    }

    const bridge = await getSandboxBridge(
      ctx,
      sandboxMcpUrl,
      this.mcpClientFactory,
    );
    if ('error' in bridge) throw new Error(bridge.error);

    try {
      const read = await readSandboxFile(bridge, sandboxPath);
      if ('error' in read) throw new Error(read.error);
      return {
        bytes: read.bytes,
        fileName: args.deliverable.fileName ?? basename(sandboxPath),
        mediaType: args.deliverable.mediaType ?? inferMimeFromPath(sandboxPath),
      };
    } finally {
      await bridge.close();
    }
  }

  private async postReceipt(
    ctx: RuntimeContext,
    input: {
      roomId: string;
      threadId: string;
      engagement: CommerceEngagement;
      args: DeliverWorkArgs;
      claimId: string;
      txHash: string;
      workSummary?: string;
      deliverable?: {
        fileName: string;
        mediaType: string;
        matrixEventId: string;
      };
    },
  ): Promise<void> {
    const { engagement, args } = input;
    const claimUrl = claimDeepLink(
      readConfigString(ctx.config, 'PORTAL_URL'),
      input.claimId,
    );

    await postOracleComponent(ctx.matrix, input.roomId, {
      component: 'work_delivered',
      props: {
        service: {
          id: engagement.serviceId,
          name: engagement.serviceName,
          price: { amount: engagement.priceUsd, currency: 'USDC' },
        },
        description: args.description,
        resultStatus: args.resultStatus,
        ...(input.deliverable !== undefined && {
          deliverable: input.deliverable,
        }),
        claimId: input.claimId,
        txHash: input.txHash,
        ...(input.workSummary !== undefined && {
          workSummary: input.workSummary,
        }),
        ...(claimUrl !== undefined && { claimUrl }),
      },
      body: `Delivered: ${engagement.serviceName} (${engagement.priceUsd} USDC) — claim ${input.claimId}.`,
      sessionId: ctx.session.id,
      requestId: ctx.session.requestId,
      ...(ctx.toolCallId !== undefined && { toolCallId: ctx.toolCallId }),
      ...(ctx.session.client === 'matrix' ? { threadId: input.threadId } : {}),
    });
  }

  private network(ctx: RuntimeContext): ClaimNetwork {
    const network = readConfigString(ctx.config, 'NETWORK');
    return network === 'mainnet' || network === 'testnet' ? network : 'devnet';
  }

  private requireConfig(ctx: RuntimeContext, key: string): string {
    const value = readConfigString(ctx.config, key);
    if (!value) {
      throw new Error(
        `This oracle is missing ${key}, so the work record cannot be signed. The operator needs to configure it.`,
      );
    }
    return value;
  }

  /** Run a post-submission step, logging (never rethrowing) any failure. */
  private async safely(
    what: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger?.warn?.(
        `[oracle-payments] failed to ${what} after a submitted claim: ${errorMessage(error)}`,
      );
    }
  }
}

/**
 * The claim body, in the exact field order the work-claim form defines.
 * `deliverables` is omitted entirely for a release claim — there is no work
 * product, and the unanswered question is what makes the evaluator reject it
 * and hand the escrow back to the user.
 */
export function buildClaimBody(input: {
  service: string;
  request: string;
  workSummary: string;
  resultStatus: DeliverWorkArgs['resultStatus'];
  deliverables?: ClaimDeliverable[];
  proofs?: string;
}): Record<string, unknown> {
  return {
    service: input.service,
    request: input.request,
    workSummary: input.workSummary,
    resultStatus: input.resultStatus,
    ...(input.deliverables !== undefined && {
      deliverables: input.deliverables,
    }),
    ...(input.proofs !== undefined && { proofs: input.proofs }),
  };
}

/** The release claim's `request`, written from the engagement, not a model. */
function releaseClaimRequest(engagement: CommerceEngagement): string {
  return (
    `The user contracted "${engagement.serviceName}" (${engagement.serviceId}) on ` +
    `${engagement.startedAt} and then cancelled the request before any work was delivered.`
  );
}

/** The release claim's `workSummary`: nothing was done, and why it stopped. */
function releaseClaimWorkSummary(
  engagement: CommerceEngagement,
  cancelledAt: string,
  reason?: string,
): string {
  const why =
    reason !== undefined && reason.length > 0
      ? ` The user's stated reason was: ${reason}`
      : ' The user gave no reason.';
  return (
    `No work was completed and there is no deliverable. The user cancelled this engagement at ` +
    `${cancelledAt}, before "${engagement.serviceName}" was delivered.${why} This record is filed ` +
    'only to close out the cancelled job and release the payment reserved for it — nothing is ' +
    'claimed as delivered.'
  );
}

/** The confirmation the model speaks from after a successful release. */
function releasedNote(claimId: string, resumed: boolean): string {
  const what = resumed
    ? 'The cancellation record already signed for this job has now been submitted on-chain'
    : 'A record reporting that this work was cancelled before completion has been submitted on-chain';
  return (
    `${CLOSED_PREFIX} ${what} (claim ${claimId}), which releases the payment reserved when the ` +
    'job started. The user is not blocked by it any more: they can start a new paid job right ' +
    'now. The reserved amount goes back to them once the record is evaluated, normally within ' +
    'a few minutes. Tell them the job is cancelled, the reserved payment is on its way back, ' +
    'and they can start something new whenever they like.'
  );
}

function materializeText(
  args: DeliverWorkArgs,
  engagement: CommerceEngagement,
): { bytes: Buffer; fileName: string; mediaType: string } {
  const text = args.deliverable.text;
  if (text === undefined || text.trim().length === 0) {
    throw new Error(
      'deliverable.text is required when kind is "text" — it carries the actual work product, not a summary.',
    );
  }
  return {
    bytes: Buffer.from(text, 'utf8'),
    fileName:
      args.deliverable.fileName ??
      `${slugify(engagement.serviceName || args.description)}.md`,
    mediaType: args.deliverable.mediaType ?? 'text/markdown',
  };
}

function basename(path: string): string {
  const last = path.split('/').filter(Boolean).pop();
  return last && last.length > 0 ? last : 'deliverable';
}
