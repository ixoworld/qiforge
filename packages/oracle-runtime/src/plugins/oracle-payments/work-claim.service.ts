import { Logger as NestLogger } from '@nestjs/common';
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
import type { CommerceEngagementStart } from '../../modules/messages/commerce-router-port.js';
import {
  defaultClaimBotUploader,
  defaultClaimChainClient,
  isExpiredIntentFailure,
  type ClaimBotUploader,
  type ClaimChainClient,
  type ClaimCoin,
  type ClaimDeliverable,
  type ClaimNetwork,
  type SubmitClaimResult,
} from './claim-lane.js';
import type { ContractGateService } from './contract-gate.service.js';
import type { EngagementService } from './engagement.service.js';
import type { WorkIntentService } from './work-intent.service.js';
import type { WorkSummaryExtractor } from './work-summary-extractor.js';
import {
  claimDeepLink,
  claimNetwork,
  creditsInChainText,
  DEFAULT_CURRENCY,
  errorMessage,
  formatCredits,
  grantedDenom,
  isEngagementExpired,
  priceToCoin,
  priceToCredits,
  readConfigNumber,
  readConfigString,
  resolvePortalUrl,
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

/**
 * The escrow lane the delivery uses to reserve payment again when a job
 * outlived its window. Narrowed to the one call so the two services share the
 * chain write without the delivery lane gaining a way to start engagements.
 */
export type WorkIntentReserver = Pick<WorkIntentService, 'reserve'>;

export interface WorkClaimServiceDeps {
  engagement: EngagementService;
  contractGate: ContractGateService;
  extractor: WorkSummaryExtractor;
  /**
   * Reserves payment on-chain. Without it a job whose reservation lapsed can
   * only be closed honestly, never recovered.
   */
  intent?: WorkIntentReserver;
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

/**
 * What to say when the job record could not be READ, as opposed to not being
 * there. The two are indistinguishable from a `null` and lead to opposite
 * replies: this one must never come out as "you have no job here".
 */
function unreadableJob(detail: string): string {
  return (
    `This thread's job could not be looked up, so nothing was done: ${detail}. This does NOT mean ` +
    'the user has no job running — the record simply could not be read. Do not tell them to ' +
    'contract anything, do not treat the work as unpaid, and do not retry in a loop: say the ' +
    'lookup failed and why, and try again in a moment.'
  );
}

const CLOSED_PREFIX =
  'The engagement is closed; this thread returns to support from the next message.';

/** What the model tells the user when the delivery had to re-reserve payment. */
const RENEWED_NOTE =
  'The payment reserved when this job started ran out while the work was still running, so a ' +
  'fresh reservation was made and the work was billed against that one. The user is charged ' +
  'once, the normal amount — say so plainly if the delay came up, and do not imply anything ' +
  'was charged twice.';

/** One submit attempt: the accepted tx, or why the chain would not take it. */
type SubmitAttempt = { ok: true; tx: SubmitClaimResult } | FailedSubmit;

interface FailedSubmit {
  ok: false;
  /** Raw chain wording, matched against to tell a lapsed reservation apart. */
  detail: string;
  /**
   * The same failure as the sentence the tool reports it with — amounts in
   * credits, since this one is written to be read out to the user. `detail`
   * stays raw: it is matched and logged, never spoken.
   */
  failure: string;
}

/**
 * Run one submit and normalize both refusal shapes into one value. A doomed
 * claim can come back either way: the wallet client simulates before it
 * broadcasts, so the chain's objection usually arrives as a thrown simulate
 * error, and only a tx that made it into a block reports a non-zero code.
 *
 * `denom` is the coin this claim is priced in — the one denom whose micro-unit
 * amounts can be rewritten as credits before the refusal reaches the user.
 */
async function attemptSubmit(
  submit: () => Promise<SubmitClaimResult>,
  denom: string,
): Promise<SubmitAttempt> {
  let tx: SubmitClaimResult;
  try {
    tx = await submit();
  } catch (error) {
    const detail = errorMessage(error);
    return {
      ok: false,
      detail,
      failure: `The payment record could not be submitted on-chain (${creditsInChainText(detail, denom)}).`,
    };
  }
  if (tx.code === 0) return { ok: true, tx };
  const rawLog = tx.rawLog || 'unknown chain error';
  return {
    ok: false,
    detail: `code ${tx.code}: ${rawLog}`,
    failure: `The payment record could not be submitted on-chain (code ${tx.code}): ${creditsInChainText(rawLog, denom)}.`,
  };
}

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
 *
 * One failure is not a failure lane at all: a job whose escrow reservation
 * lapsed while the work ran. The lapsed intent frees the chain's one-active-
 * intent slot, so delivery re-reserves and settles against the new reservation
 * instead of refusing finished work. Only when the reservation cannot be
 * renewed does the job end — and then the engagement is CLOSED, never left
 * `active`, because an engagement holding a reservation that no longer exists
 * blocks every future request for a job that can never be delivered.
 */
export class WorkClaimService {
  private readonly engagement: EngagementService;
  private readonly contractGate: ContractGateService;
  private readonly extractor: WorkSummaryExtractor;
  private readonly intent?: WorkIntentReserver;
  private getSigningMnemonic: () => string | null;
  private readonly uploadToRoom: RoomFileUploader;
  private readonly uploadToClaimBot: ClaimBotUploader;
  private readonly chain: ClaimChainClient;
  private readonly mcpClientFactory?: SandboxMcpClientFactory;
  private readonly statusProducer: Pick<WorkStatusProducer, 'emit'>;
  private readonly clock: () => Date;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(deps: WorkClaimServiceDeps) {
    this.engagement = deps.engagement;
    this.contractGate = deps.contractGate;
    this.extractor = deps.extractor;
    this.intent = deps.intent;
    this.getSigningMnemonic = deps.getSigningMnemonic ?? (() => null);
    this.uploadToRoom = deps.uploadToRoom ?? sendFileToRoom;
    this.uploadToClaimBot = deps.uploadToClaimBot ?? defaultClaimBotUploader;
    this.chain = deps.chain ?? defaultClaimChainClient;
    this.mcpClientFactory = deps.mcpClientFactory;
    this.statusProducer = deps.statusProducer ?? workStatusProducer;
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep;
    this.logger = deps.logger ?? new NestLogger(WorkClaimService.name);
  }

  /** Wire the oracle's signing-key reader (done once at module init). */
  setSigningMnemonicProvider(provider: () => string | null): void {
    this.getSigningMnemonic = provider;
  }

  async deliver(
    args: DeliverWorkArgs,
    ctx: RuntimeContext,
  ): Promise<DeliverWorkResult> {
    const chat = this.chatLocation(ctx, 'deliver_work');
    const { roomId, threadId } = this.engagementLocation(ctx, chat);

    const read = await this.engagement.readActive(roomId, threadId);
    if (read.error !== undefined) throw new Error(unreadableJob(read.error));
    const engagement = read.engagement;
    if (!engagement) throw new Error(NO_ENGAGEMENT_MESSAGE);

    // Already submitted: never re-sign, never re-submit, never double-charge.
    // Ahead of everything else on purpose — a claim already on the chain is a
    // fact no later check can change, so reporting it must not depend on the
    // reservation still being open or the contract still passing.
    if (engagement.claim?.cid && engagement.claim.txHash) {
      return {
        claimId: engagement.claim.cid,
        txHash: engagement.claim.txHash,
        delivered: true,
        note: 'This work was already delivered and its payment record already submitted — nothing was resubmitted.',
      };
    }

    // The escrow reserved at start released while the work was still running.
    // It is recovered from below rather than refused here: the work is done,
    // and dead-ending it would leave the user unbilled, the oracle unpaid, and
    // the engagement blocking every future request.
    const expired = isEngagementExpired(engagement, this.clock());

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
      // The reason is a code; the detail is what the user can act on. Both
      // travel, because "the contract check failed" with nothing after it is
      // exactly the message the agent cannot turn into an explanation.
      const why =
        gate.detail !== undefined
          ? `${gate.reason}: ${gate.detail}`
          : gate.reason;
      // A live reservation is still held, so the job keeps blocking and the
      // agent may retry once the user fixes their contract. A lapsed one holds
      // nothing and can never be renewed through a gate that refuses it — that
      // job ends here rather than wedging the thread.
      if (expired) {
        throw await this.abandon({
          roomId,
          threadId,
          reason: `the user's contract no longer covers it (${why})`,
        });
      }
      // A check that never completed says nothing about their contract, so
      // the fix is to try again — not to send a contracted user a contract
      // card and tell them something untrue about why their work stalled.
      if (gate.reason === 'contract_check_failed') {
        throw new Error(
          `This work can't be billed right now: the user's contract could not be checked at all (${why}). ` +
            'This is a failure on our side, not a problem with their contract — do not say they are ' +
            'uncontracted and do not call show_contract. Tell them the work is finished but could not be ' +
            'recorded yet, say why, and call deliver_work again shortly. The work itself is not lost.',
        );
      }
      throw new Error(
        `This work can't be billed right now: the user's contract check failed (${why}). ` +
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
    // R1 (uPay spec §5): the claim is priced in the granted denom the gate
    // just re-read off the contract record — the same source every reservation
    // prices from, so the claim and the escrow it settles can never disagree.
    // The gate always supplies it; its absence is a wiring fault, and pricing
    // in a guessed denom would strand the escrow, so this fails closed.
    const denom = grantedDenom(gate.start);
    if (denom === undefined) {
      throw new Error(
        "This work can't be billed right now: the contract check reported no granted payment " +
          'denom to price the claim in. This is a fault on our side, not a problem with their ' +
          'contract — the work itself is not lost, so say why and call deliver_work again shortly.',
      );
    }
    const price = priceToCoin(engagement.priceUsd, denom);
    const amount: ClaimCoin[] = [
      { denom: price.denom, amount: String(price.amount) },
    ];

    // The lapsed intent no longer occupies the chain's one-active-intent slot
    // for this (agent, collection), so a fresh one can be minted right now and
    // the finished work can still settle against it.
    let renewed = false;
    if (expired) {
      await this.renewReservation({
        roomId,
        threadId,
        engagement,
        gate: gate.start,
      });
      renewed = true;
    }

    let claimId = engagement.claim?.cid;
    let workSummary: string | undefined;
    let deliverable:
      | { fileName: string; mediaType: string; matrixEventId: string }
      | undefined;

    if (!claimId) {
      const file = await this.materialize(args, ctx, engagement);
      const extraction = await this.extractor.extract({
        messages: ctx.history.messages,
        serviceId: engagement.serviceId,
        serviceName: engagement.serviceName,
      });
      workSummary = extraction.workSummary;

      // The work goes where the conversation is, which is not necessarily
      // where the engagement's record lives.
      const matrixEventId = await this.uploadToRoom({
        roomId: chat.roomId,
        fileName: file.fileName,
        mediaType: file.mediaType,
        bytes: file.bytes,
        ...(ctx.session.client === 'matrix' ? { threadId: chat.threadId } : {}),
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

    // Always settles against the escrow locked for this job — the two halves
    // are unconditional, so a reserved job is never settled as an unreserved
    // one. Requires an evaluation engine that accepts `useIntent: true`
    // agent-work claims.
    const tx = await this.settle({
      roomId,
      threadId,
      engagement,
      gate: gate.start,
      claimId,
      amount,
      renewed,
    });

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
        roomId: chat.roomId,
        threadId: chat.threadId,
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

    return {
      claimId,
      txHash: tx.transactionHash,
      delivered: true,
      ...(renewed && { note: RENEWED_NOTE }),
    };
  }

  /**
   * Submit the claim against this job's escrow, recovering once from the one
   * failure a correct claim can still hit: the chain refusing it because the
   * reservation is gone. The pre-flight deadline check cannot rule that out —
   * the window can close between the check and the block, the oracle's clock
   * can drift from the chain's, and the intent may have been settled by another
   * claim — so the refusal is handled where it actually happens.
   *
   * Recovery is once per delivery: re-reserve, submit again. A second refusal
   * closes the engagement rather than leaving a job nobody can finish.
   */
  private async settle(input: {
    roomId: string;
    threadId: string;
    engagement: CommerceEngagement;
    gate: CommerceEngagementStart;
    claimId: string;
    amount: ClaimCoin[];
    renewed: boolean;
  }): Promise<SubmitClaimResult> {
    const { roomId, threadId, engagement, claimId, amount } = input;
    const denom = amount[0]?.denom ?? '';
    const submit = (): Promise<SubmitAttempt> =>
      attemptSubmit(
        () =>
          this.chain.submit({
            claimId,
            collectionId: engagement.collectionId,
            useIntent: true,
            amount,
          }),
        denom,
      );

    let renewed = input.renewed;
    let attempt = await submit();
    // `!renewed` bounds this to one recovery per delivery: a refusal that
    // survives a fresh reservation is not going to survive another one, and
    // reserving in a loop would burn the user's escrow, not their patience.
    if (
      !attempt.ok &&
      !renewed &&
      this.isLapsedReservation(attempt, engagement, renewed)
    ) {
      this.logger.warn(
        `[oracle-payments] the chain refused claim ${claimId} because its reservation is gone ` +
          `(${attempt.detail}) — re-reserving and submitting once more.`,
      );
      await this.renewReservation(input);
      renewed = true;
      attempt = await submit();
    }

    if (!attempt.ok) {
      if (this.isLapsedReservation(attempt, engagement, renewed)) {
        throw await this.abandon({
          roomId,
          threadId,
          reason: `the chain refused the payment record because its reservation is gone (${creditsInChainText(attempt.detail, denom)})`,
        });
      }
      throw new Error(
        `${attempt.failure} The work is saved — deliver again to retry the submission.`,
      );
    }
    return attempt.tx;
  }

  /**
   * `true` when a failed submit is about the reservation rather than the claim.
   *
   * The chain's own wording is the primary signal. The fallback — the job is
   * already past the deadline stamped on it — covers a window that closed
   * between the pre-flight check and the block, and is only consulted before a
   * renewal: afterwards the stamped deadline describes the reservation that was
   * just replaced, and reading it would misfile every later failure.
   */
  private isLapsedReservation(
    attempt: FailedSubmit,
    engagement: CommerceEngagement,
    renewed: boolean,
  ): boolean {
    if (isExpiredIntentFailure(attempt.detail)) return true;
    return !renewed && isEngagementExpired(engagement, this.clock());
  }

  /**
   * Reserve payment again for a job that outlived its window, and stamp the
   * fresh reservation on the engagement so every later read sees the new
   * deadline. The chain write is {@link WorkIntentService}'s, not a second copy
   * of it.
   *
   * Throws — with the engagement already closed — when the reservation cannot
   * be renewed. The work is finished either way, but it is no longer billable,
   * and an engagement left `active` around a reservation that does not exist is
   * exactly what wedges a user out of every future request.
   */
  private async renewReservation(input: {
    roomId: string;
    threadId: string;
    engagement: CommerceEngagement;
    gate: CommerceEngagementStart;
  }): Promise<void> {
    const { roomId, threadId, engagement, gate } = input;

    if (!this.intent) {
      throw await this.abandon({
        roomId,
        threadId,
        reason:
          'this oracle has no escrow lane wired, so payment could not be reserved again',
      });
    }
    // The gate answered from a fresh contract record. A different collection
    // means the user re-contracted mid-job: reserving there and claiming here
    // would settle against an escrow that belongs to a different agreement.
    if (gate.collectionId !== engagement.collectionId) {
      throw await this.abandon({
        roomId,
        threadId,
        reason:
          "the user's claim collection changed while the work was running, so this job can no longer be billed against it",
      });
    }

    const reservation = await this.intent.reserve(gate);
    if (!reservation.ok) {
      throw await this.abandon({
        roomId,
        threadId,
        reason: `reserving the payment again failed — ${reservation.detail}`,
        // The work is finished and unbillable, but for once the user can do
        // something about it: a balance that ran short between the start of
        // the job and its delivery is fixed by topping up and re-running.
        ...(reservation.insufficientFunds === true && { topUp: true }),
      });
    }
    const fresh = reservation.intent;

    this.logger.warn(
      `[oracle-payments] the reservation for thread ${threadId} lapsed mid-job — re-reserved on-chain ` +
        `(tx ${fresh.txHash}, expires ${fresh.expiresAt ?? 'unbounded'}); continuing the delivery.`,
    );
    // Best-effort: the reservation is already on-chain and the claim settles
    // against it whether or not the record catches up. A failed write only
    // costs bookkeeping, and failing the delivery over it would throw away a
    // reservation the user just paid for.
    await this.safely('record the renewed reservation', () =>
      this.engagement.recordIntent(roomId, threadId, fresh),
    );
  }

  /**
   * End a job whose reservation is gone and cannot be renewed. Closing it is
   * the whole point: the escrow released on its own, so the engagement holds
   * nothing, and every turn that finds it `active` refuses new work for a job
   * that can never be delivered. The returned error is what the tool throws, so
   * every give-up branch tells the user the same honest story.
   */
  private async abandon(input: {
    roomId: string;
    threadId: string;
    reason: string;
    /** The reservation failed for want of credits — the user can fix that. */
    topUp?: boolean;
  }): Promise<Error> {
    await this.safely('close the engagement whose reservation lapsed', () =>
      this.engagement.transition(input.roomId, input.threadId, 'closed'),
    );
    this.logger.warn(
      `[oracle-payments] could not recover the lapsed reservation for thread ${input.threadId} ` +
        `(${input.reason}) — the engagement is closed so the user is not blocked.`,
    );
    return new Error(
      `The payment reserved for this work ran out before it was delivered, and it could not be ` +
        `reserved again: ${input.reason}. Nothing was charged and this job is now closed, so the ` +
        'user can start a new one whenever they like. Tell them plainly that the work is finished ' +
        'but could not be billed, and why. Hand the finished work over anyway — paste it into the ' +
        'chat if it is text — and offer to run the request again, or to contract the service ' +
        'again, if they want it recorded.' +
        (input.topUp === true
          ? ' Their credit balance is what stopped it, so tell them that too and ask them to top ' +
            'up their account before asking you to run it again — nothing else needs fixing.'
          : ''),
    );
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
    const chat = this.chatLocation(ctx, 'cancel_work');
    const { roomId, threadId } = this.engagementLocation(ctx, chat);

    const read = await this.engagement.readActive(roomId, threadId);
    // Reporting "nothing to cancel" for a read that failed would leave the
    // user's reservation held while they are told they are free of it.
    if (read.error !== undefined) throw new Error(unreadableJob(read.error));
    const engagement = read.engagement;
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
    if (isEngagementExpired(engagement, this.clock())) {
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

    // R1 (uPay spec §5): the release claim hands back the exact coin the
    // reservation locked — the granted denom stamped on the engagement at
    // start. An engagement without one predates the stamp; pricing the release
    // in a guessed denom would only be rejected on-chain, so fail closed and
    // let the reservation lapse on its own, after which cancelling closes the
    // job cleanly with no claim at all.
    const denom = grantedDenom(engagement);
    if (denom === undefined) {
      throw new Error(
        'The reserved payment cannot be released: this job carries no record of the denom it was ' +
          'reserved in, so the release claim cannot be priced. The reservation is still held ' +
          `on-chain${expiresAt !== undefined ? ` and expires on its own at ${expiresAt}` : ' until it expires on its own'} — ` +
          'once it has, calling cancel_work again closes the job cleanly. Tell the user plainly ' +
          'that the cancellation is recorded but the reserved payment releases only when the ' +
          'reservation expires.',
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
    const price = priceToCoin(engagement.priceUsd, denom);
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
        `The cancellation record could not be submitted on-chain (${creditsInChainText(errorMessage(error), price.denom)}). ` +
          RELEASE_FAILED_SUFFIX,
      );
    }
    if (tx.code !== 0) {
      throw new Error(
        `The cancellation record was rejected on-chain (code ${tx.code}): ${creditsInChainText(
          tx.rawLog || 'unknown chain error',
          price.denom,
        )}. ${RELEASE_FAILED_SUFFIX}`,
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

  /** Where the conversation is happening — where the user will look for the
   * delivered file and the receipt card. */
  private chatLocation(
    ctx: RuntimeContext,
    toolName: string,
  ): { roomId: string; threadId: string } {
    const roomId = ctx.session.roomId;
    if (!roomId) {
      throw new Error(
        `${toolName} applies only to Matrix work threads — no room on this session.`,
      );
    }
    return { roomId, threadId: ctx.session.id };
  }

  /**
   * Where the engagement's durable record lives — the room and thread every
   * read and write against it must address.
   *
   * Usually the same as the chat location, but not when the user continued
   * live work from another thread or another room: the router reports the
   * engagement's own home on `ctx.commerce`, and settling the escrow against
   * the room the message happened to arrive in would find no engagement (or,
   * worse, someone else's). The chat location is the fallback for turns that
   * never went through the router.
   */
  private engagementLocation(
    ctx: RuntimeContext,
    chat: { roomId: string; threadId: string },
  ): { roomId: string; threadId: string } {
    return {
      roomId: ctx.commerce?.engagementRoomId ?? chat.roomId,
      threadId: ctx.commerce?.engagementThreadId ?? chat.threadId,
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
        this.logger.warn(
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
      resolvePortalUrl(
        readConfigString(ctx.config, 'PORTAL_URL'),
        this.network(ctx),
      ),
      input.claimId,
    );

    await postOracleComponent(ctx.matrix, input.roomId, {
      component: 'work_delivered',
      props: {
        service: {
          id: engagement.serviceId,
          name: engagement.serviceName,
          price: { amount: engagement.priceUsd, currency: DEFAULT_CURRENCY },
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
        claimUrl,
      },
      body: `Delivered: ${engagement.serviceName} (${formatCredits(priceToCredits(engagement.priceUsd))}) — claim ${input.claimId}.`,
      sessionId: ctx.session.id,
      requestId: ctx.session.requestId,
      ...(ctx.toolCallId !== undefined && { toolCallId: ctx.toolCallId }),
      ...(ctx.session.client === 'matrix' ? { threadId: input.threadId } : {}),
    });
  }

  private network(ctx: RuntimeContext): ClaimNetwork {
    return claimNetwork(readConfigString(ctx.config, 'NETWORK'));
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
      this.logger.warn(
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
