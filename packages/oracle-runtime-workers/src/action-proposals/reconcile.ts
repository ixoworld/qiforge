import type { ActionProposal } from '@ixo/ixo-transaction/action-proposals';
import type { ActionProposalStore } from './store';
import { verifyActionTransaction } from './verify';
export async function refreshActionProposal(
  store: ActionProposalStore,
  proposal: ActionProposal,
  rpc: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ proposal: ActionProposal; attempted: boolean }> {
  if (
    !rpc ||
    proposal.lifecycle.status !== 'unknown' ||
    !proposal.lifecycle.transactionHash
  )
    return { proposal, attempted: false };
  if (!(await store.claimVerification(proposal.ownerDid, proposal.id)))
    return { proposal, attempted: false };
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
  } catch {
    return { proposal, attempted: true };
  }
}
