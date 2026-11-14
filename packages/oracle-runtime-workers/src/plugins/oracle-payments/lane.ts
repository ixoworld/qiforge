import type { BaseMessage } from '@langchain/core/messages';
import { claimIntentExec, submitClaimExec } from '../../chain';
import type {
  ChainBroadcastResult,
  ChainSigningSurface,
  RuntimeContext,
} from '../../plugin-api/types';
import {
  uploadDeliverable,
  saveClaim,
  type ClaimFileAnswer,
} from './claim-bot';
import type { ResolvedPaymentsEnv } from './config';
import { EngagementStore, type Engagement } from './engagements';
import { checkContract, type GateFailureReason } from './gate';

export type ResultStatus = 'completed' | 'partial' | 'unable';

export type StartWorkResult =
  | { started: true; engagement: Engagement }
  | {
      started: false;
      reason:
        | GateFailureReason
        | 'engagement_in_progress'
        | 'intent_failed'
        | 'insufficient_funds'
        | 'unavailable';
      detail: string;
    };

export type SettleResult =
  | { ok: true; claimId: string; txHash: string; engagement: Engagement }
  | { ok: false; reason: string; detail: string };

/** A chain write that failed in the block or before it (simulate). */
class ChainWriteError extends Error {}

function isExpiredIntentFailure(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes('intent') &&
    (text.includes('not found') || text.includes('expired'))
  );
}

function isInsufficientFunds(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes('insufficient funds') ||
    text.includes('insufficient balance') ||
    (text.includes('spendable balance') && text.includes('smaller than'))
  );
}

async function broadcast(
  chain: ChainSigningSurface,
  msg: Parameters<ChainSigningSurface['signAndBroadcast']>[0][number],
  memo: string,
): Promise<ChainBroadcastResult> {
  let res: ChainBroadcastResult;
  try {
    res = await chain.signAndBroadcast([msg], memo);
  } catch (err) {
    throw new ChainWriteError(err instanceof Error ? err.message : String(err));
  }
  if (res.code !== 0) {
    throw new ChainWriteError(
      `tx ${res.transactionHash} failed (code ${res.code}): ${res.rawLog ?? ''}`,
    );
  }
  return res;
}

function textOf(message: BaseMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((part) =>
      typeof part === 'object' &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join(' ')
    .trim();
}

/**
 * The user's own latest message — what the claim's `request` records. Taken
 * from the transcript, never from tool arguments, so the agent cannot
 * rewrite what was asked for.
 */
function latestUserRequest(ctx: RuntimeContext): string {
  const messages = ctx.history.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.getType() === 'human') {
      const text = textOf(m);
      if (text.length > 0) return text.slice(0, 4000);
    }
  }
  return '';
}

export interface LaneDeps {
  ctx: RuntimeContext;
  env: ResolvedPaymentsEnv;
}

function storeOf(ctx: RuntimeContext): EngagementStore | null {
  return ctx.kv ? new EngagementStore(ctx.kv) : null;
}

/**
 * Open a paid job: run the contract gate, reserve the agreed price into
 * escrow (`MsgClaimIntent`), record the engagement. The chain is the final
 * guard against a double start: it allows one live intent per collection.
 */
export async function startWork(
  { ctx, env }: LaneDeps,
  serviceId: string,
): Promise<StartWorkResult> {
  const store = storeOf(ctx);
  if (!ctx.chain || !store) {
    return {
      started: false,
      reason: 'unavailable',
      detail:
        'This oracle has no chain account configured, so it cannot take paid work.',
    };
  }
  const existing = await store.active();
  if (existing) {
    return {
      started: false,
      reason: 'engagement_in_progress',
      detail: `"${existing.serviceName}" (started ${existing.startedAt}) is still open — deliver or cancel it first.`,
    };
  }
  const oracleAddress = await ctx.chain.address();
  const gate = await checkContract({
    ctx,
    env,
    oracleAddress,
    senderDid: ctx.user.did,
    serviceId,
  });
  if (!gate.ok) {
    return { started: false, reason: gate.reason, detail: gate.detail };
  }
  let intent: ChainBroadcastResult;
  try {
    intent = await broadcast(
      ctx.chain,
      await claimIntentExec({
        agentAddress: oracleAddress,
        collectionId: gate.collectionId,
        amount: [gate.amount],
      }),
      `reserve ${gate.service.id}`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      started: false,
      reason: isInsufficientFunds(detail)
        ? 'insufficient_funds'
        : 'intent_failed',
      detail,
    };
  }
  const engagement: Engagement = {
    status: 'active',
    serviceId: gate.service.id,
    serviceName: gate.service.name,
    priceUsd: gate.service.priceUsd,
    collectionId: gate.collectionId,
    adminAddress: gate.admin,
    userDid: ctx.user.did,
    startedAt: new Date().toISOString(),
    amount: gate.amount,
    homeServer: gate.homeServer,
    intentTxHash: intent.transactionHash,
    request: latestUserRequest(ctx),
  };
  await store.save(engagement);
  return { started: true, engagement };
}

/**
 * Save the claim body (once — a saved `claimId` is reused on retry) and
 * submit it against the job's escrow. If the reservation lapsed, reserve
 * again and submit once more.
 */
async function settle(
  { ctx, env }: LaneDeps,
  store: EngagementStore,
  chain: ChainSigningSurface,
  engagement: Engagement,
  body: () => Promise<object>,
): Promise<{ claimId: string; txHash: string; engagement: Engagement }> {
  const oracleAddress = await chain.address();
  const botUrl = env.claimBotFor(engagement.homeServer);
  let current = engagement;
  if (!current.claimId) {
    const claimId = await saveClaim(ctx, {
      botUrl,
      collectionId: current.collectionId,
      body: await body(),
    });
    current = { ...current, claimId };
    await store.save(current);
  }
  const claimId = current.claimId;
  if (!claimId) throw new Error('claim id missing after save');
  const submit = async () =>
    broadcast(
      chain,
      await submitClaimExec({
        agentAddress: oracleAddress,
        adminAddress: current.adminAddress,
        collectionId: current.collectionId,
        claimId,
        useIntent: true,
        amount: [current.amount],
      }),
      `claim ${current.serviceId}`,
    );
  try {
    const tx = await submit();
    return { claimId, txHash: tx.transactionHash, engagement: current };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!isExpiredIntentFailure(detail)) throw err;
    const intent = await broadcast(
      chain,
      await claimIntentExec({
        agentAddress: oracleAddress,
        collectionId: current.collectionId,
        amount: [current.amount],
      }),
      `re-reserve ${current.serviceId}`,
    );
    current = { ...current, intentTxHash: intent.transactionHash };
    await store.save(current);
    const tx = await submit();
    return { claimId, txHash: tx.transactionHash, engagement: current };
  }
}

export interface DeliverInput {
  description: string;
  resultStatus: ResultStatus;
  text: string;
  fileName?: string;
  mediaType?: string;
  proofs?: string;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'deliverable'
  );
}

/** Hand over the work product and file the claim that gets the oracle paid. */
export async function deliverWork(
  deps: LaneDeps,
  input: DeliverInput,
): Promise<SettleResult> {
  const { ctx, env } = deps;
  const store = storeOf(ctx);
  const chain = ctx.chain;
  if (!store || !chain) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: 'No chain account or store.',
    };
  }
  const engagement = await store.active();
  if (!engagement) {
    return {
      ok: false,
      reason: 'no_engagement',
      detail: 'There is no open paid job to deliver.',
    };
  }
  if (engagement.cancelledAt) {
    return {
      ok: false,
      reason: 'cancelled',
      detail:
        'This job was cancelled; finish the cancellation with cancel_work.',
    };
  }
  const bytes = new TextEncoder().encode(input.text);
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      reason: 'empty_deliverable',
      detail: 'The deliverable text is empty.',
    };
  }
  if (bytes.byteLength > env.maxDeliverableBytes) {
    return {
      ok: false,
      reason: 'deliverable_too_large',
      detail: `The deliverable is over ${env.maxDeliverableBytes} bytes.`,
    };
  }
  const botUrl = env.claimBotFor(engagement.homeServer);
  try {
    const result = await settle(deps, store, chain, engagement, async () => {
      const file: ClaimFileAnswer = await uploadDeliverable(ctx, {
        botUrl,
        collectionId: engagement.collectionId,
        fileName: input.fileName ?? `${slug(engagement.serviceName)}.md`,
        mediaType: input.mediaType ?? 'text/markdown',
        bytes,
      });
      return {
        service: engagement.serviceId,
        request: engagement.request,
        // shortcut: the agent's own summary; upgrade to an independent extractor (Node's WorkSummaryExtractor) when evaluator honesty scores need it
        workSummary: input.description,
        resultStatus: input.resultStatus,
        deliverables: [file],
        ...(input.proofs ? { proofs: input.proofs } : {}),
      };
    });
    await store.settle({
      serviceName: engagement.serviceName,
      outcome: 'delivered',
      claimId: result.claimId,
      txHash: result.txHash,
      settledAt: new Date().toISOString(),
    });
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof ChainWriteError ? 'claim_failed' : 'delivery_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Cancel a reserved job. The chain has no "drop intent" message, so the
 * reservation is released by a claim stating nothing was delivered
 * (`resultStatus: unable`, no deliverables): the evaluator rejects it and
 * the escrow returns to the user.
 */
export async function cancelWork(
  deps: LaneDeps,
  reason: string | undefined,
): Promise<SettleResult> {
  const store = storeOf(deps.ctx);
  const chain = deps.ctx.chain;
  if (!store || !chain) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: 'No chain account or store.',
    };
  }
  const found = await store.active();
  if (!found) {
    return {
      ok: false,
      reason: 'no_engagement',
      detail: 'There is no open paid job to cancel.',
    };
  }
  const cancelledAt = found.cancelledAt ?? new Date().toISOString();
  const engagement: Engagement = {
    ...found,
    cancelledAt,
    ...(reason ? { cancelReason: reason } : {}),
  };
  await store.save(engagement);
  try {
    const result = await settle(deps, store, chain, engagement, async () => ({
      service: engagement.serviceId,
      request: engagement.request,
      workSummary:
        `No work was completed and there is no deliverable. The user cancelled "${engagement.serviceName}" at ${cancelledAt}.` +
        (engagement.cancelReason
          ? ` Their reason: ${engagement.cancelReason}`
          : '') +
        ' Filed only to release the payment reserved for this job.',
      resultStatus: 'unable',
      proofs: `Cancelled by the user before delivery.`,
    }));
    await store.settle({
      serviceName: engagement.serviceName,
      outcome: 'cancelled',
      claimId: result.claimId,
      txHash: result.txHash,
      settledAt: new Date().toISOString(),
    });
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      reason: 'release_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
