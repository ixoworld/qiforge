import type { ActionProposalSubject } from '@ixo/ixo-transaction/action-proposals';
import { ActionProposalConflict } from './store';

/** How long a prepared card can be claimed: the plugin's expiry and the owner object's ceiling. */
export const ACTION_PROPOSAL_TTL_MS = 15 * 60_000;
/** How far a card's `createdAt` may sit from the object's clock. */
export const ACTION_PROPOSAL_CLOCK_SKEW_MS = 5 * 60_000;

type Network = ActionProposalSubject['action']['network'];

/**
 * What the owner object requires of every card before it is stored, whichever
 * plugin prepared it: the authenticated owner signs from their own account,
 * on a non-mainnet chain the Worker is configured for and can verify against,
 * stamped now, expiring inside the policy window. The contract schema already
 * pins the memo to the card id and one transfer per card.
 */
export function assertActionProposalPolicy(
  subject: ActionProposalSubject,
  policy: {
    ownerDid: string;
    chainIds: Readonly<Record<Network, string>>;
    rpc: Readonly<Record<Network, string | undefined>>;
    now: number;
  },
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
  // A card the Worker could never verify would sit `unknown` for ever.
  if (!policy.rpc[subject.action.network])
    throw new ActionProposalConflict(
      `No chain endpoint is configured for ${subject.action.network}`,
    );
  const createdAt = Date.parse(subject.createdAt);
  if (Math.abs(createdAt - policy.now) > ACTION_PROPOSAL_CLOCK_SKEW_MS)
    throw new ActionProposalConflict('Proposal timestamp is not current');
  if (
    Date.parse(subject.expiresAt) >
    policy.now + ACTION_PROPOSAL_TTL_MS + ACTION_PROPOSAL_CLOCK_SKEW_MS
  )
    throw new ActionProposalConflict(
      'Proposal expiry exceeds the policy window',
    );
}
