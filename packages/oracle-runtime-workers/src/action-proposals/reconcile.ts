import type { ActionProposal } from '@ixo/ixo-transaction/action-proposals';
import { TRANSACTION_REJECTIONS, type ActionProposalStore } from './store';
import { verifyActionTransaction } from './verify';
export async function refreshActionProposal(
  store: ActionProposalStore,
  proposal: ActionProposal,
  rpc: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ proposal: ActionProposal; attempted: boolean }> {
  if (
    proposal.lifecycle.status !== 'unknown' ||
    !proposal.lifecycle.transactionHash
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
    // mismatch proves the hash is not this card's, so a later reconcile may
    // replace it.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[action-proposals] verification of ${proposal.id} pending: ${message}`,
    );
    if (TRANSACTION_REJECTIONS.has(message))
      await store.markTransactionRejected(proposal.ownerDid, proposal.id);
    return { proposal, attempted: true };
  }
}
