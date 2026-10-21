import type { ActionProposalSubject } from '@ixo/ixo-transaction/action-proposals';
import { ActionProposalConflict } from './store';

/** How long a prepared card can be claimed: the plugin's expiry and the owner object's ceiling. */
export const ACTION_PROPOSAL_TTL_MS = 15 * 60_000;

type Network = ActionProposalSubject['action']['network'];

/**
 * What the owner object requires of every card before it is stored, whichever
 * plugin prepared it: the authenticated owner signs from their own account,
 * on a non-mainnet chain the Worker is configured for, and the card expires
 * inside the policy window. The contract schema already pins the memo to the
 * card id and one transfer per card.
 */
export function assertActionProposalPolicy(
  subject: ActionProposalSubject,
  policy: { ownerDid: string; chainIds: Readonly<Record<Network, string>> },
): void {
  if (subject.ownerDid !== policy.ownerDid)
    throw new ActionProposalConflict('Proposal owner mismatch');
  if (subject.action.network === 'mainnet')
    throw new ActionProposalConflict('Mainnet action proposals are disabled');
  if (subject.action.signerAddress !== policy.ownerDid.replace(/^did:ixo:/, ''))
    throw new ActionProposalConflict(
      'The signer must be the authenticated account',
    );
  if (subject.action.chainId !== policy.chainIds[subject.action.network])
    throw new ActionProposalConflict(
      'Chain ID does not match the configured network',
    );
  if (
    Date.parse(subject.expiresAt) - Date.parse(subject.createdAt) >
    ACTION_PROPOSAL_TTL_MS
  )
    throw new ActionProposalConflict(
      'Proposal expiry exceeds the policy window',
    );
}
