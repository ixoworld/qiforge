import type { ActionProposal } from '@ixo/ixo-transaction/action-proposals';
import {
  TRANSACTION_CARD_BOUND_MISMATCH,
  TRANSACTION_REJECTIONS,
  type ActionProposalStore,
} from './store';
import { TRANSACTION_NOT_FOUND, verifyActionTransaction } from './verify';
export async function refreshActionProposal(
  store: ActionProposalStore,
  proposal: ActionProposal,
  rpc: string | undefined,
  fetcher: typeof fetch = fetch,
  /** The caller's wall budget: an abort ends the lookup like an RPC outage. */
  signal?: AbortSignal,
): Promise<{ proposal: ActionProposal; attempted: boolean }> {
  if (
    proposal.lifecycle.status !== 'unknown' ||
    !proposal.lifecycle.transactionHash ||
    proposal.lifecycle.executionBlockedAt
  )
    return { proposal, attempted: false };
  if (!(await store.claimVerification(proposal.ownerDid, proposal.id)))
    return { proposal, attempted: false };
  if (!rpc) {
    // No endpoint for this card's network (removed after the card was
    // prepared; preparation refuses such a network): the cooldown slot is
    // spent so the alarm backs off and stops instead of ticking every second.
    console.warn(
      `[action-proposals] verification of ${proposal.id} pending: no RPC configured for ${proposal.action.network}`,
    );
    return { proposal, attempted: false };
  }
  try {
    const verified = await verifyActionTransaction(
      proposal,
      proposal.lifecycle.transactionHash,
      rpc,
      fetcher,
      signal,
    );
    return {
      proposal:
        (await store.recordVerified(
          proposal.ownerDid,
          proposal.id,
          verified,
        )) ?? proposal,
      attempted: true,
    };
  } catch (error) {
    // Indexing lag, an RPC outage and a byte mismatch all leave the card
    // `unknown`; the reason is for the operator, never for the user. A
    // memo mismatch proves the hash is not this card's, so a later
    // reconcile may replace it; a transaction with this card's memo and
    // other messages is the owner's card-bound effect gone wrong, so the
    // card is blocked with the hash listed.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[action-proposals] verification of ${proposal.id} pending: ${message}`,
    );
    if (message === TRANSACTION_NOT_FOUND)
      // Inside the grace window after the hash arrived this is the
      // broadcast or the indexer still in flight, not a spent attempt.
      await store.deferNotFound(
        proposal.ownerDid,
        proposal.id,
        proposal.lifecycle.transactionHash,
      );
    else if (message === TRANSACTION_CARD_BOUND_MISMATCH)
      await store.blockExecution(
        proposal.ownerDid,
        proposal.id,
        message,
        proposal.lifecycle.transactionHash,
      );
    else if (TRANSACTION_REJECTIONS.has(message))
      await store.markTransactionRejected(
        proposal.ownerDid,
        proposal.id,
        proposal.lifecycle.transactionHash,
      );
    return {
      proposal: (await store.get(proposal.ownerDid, proposal.id)) ?? proposal,
      attempted: true,
    };
  }
}
