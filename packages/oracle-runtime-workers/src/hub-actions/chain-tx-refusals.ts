import {
  CHAIN_TX_MAX_MESSAGES,
  CHAIN_TX_REFUSAL_CODES,
  type ChainTxRefusal,
  type ChainTxRefusalCode,
} from '@ixo/action-protocol';

/**
 * What each chain transaction refusal code means, for the person (`means`,
 * plain words the model may say) and what the model does next (`next`).
 * Auth Hub sends the code when it will not make a card from what it read on
 * chain, or when the node's simulation names one message
 * (`invalid_message: messages[<i>].<field>: <code>`); the reason text itself
 * is never given to the person. `satisfies` makes every code of the
 * protocol need an entry.
 */
export const CHAIN_TX_REFUSAL_WORDS = {
  validator_not_found: {
    means: 'there is no validator with that address on the network',
    next: 'Find the validator again with chain_lookup validators and copy its address exactly.',
  },
  no_stake: {
    means: 'they have nothing staked with this validator',
    next: 'Check where their stake is with chain_lookup staking.',
  },
  stake_too_small: {
    means: 'that is more than they have staked with this validator',
    next: 'Check how much is staked there with chain_lookup staking and ask for a smaller amount.',
  },
  same_validator: {
    means: 'the stake is already with that validator',
    next: 'Ask which other validator it should move to.',
  },
  invalid_amount: {
    means: 'the network does not accept that amount',
    next: 'Ask for the amount again.',
  },
  nothing_to_collect: {
    means: 'there are no rewards to collect from this validator yet',
    next: 'Leave this validator out of the card.',
  },
  proposal_not_found: {
    means: 'there is no proposal with that number',
    next: 'Find the open proposals with chain_lookup gov_proposals.',
  },
  proposal_not_open: {
    means:
      'voting on this proposal is not open (it has closed, or not started yet)',
    next: 'Tell them; a vote cannot be recorded now.',
  },
  invalid_vote_option: {
    means: 'that is not a vote the network accepts',
    next: 'Ask whether they vote yes, no, abstain or no with veto.',
  },
  token_not_found: {
    means: 'one of these impact tokens could not be found',
    next: 'Check the tokens they hold with chain_lookup token_balances.',
  },
  collection_not_found: {
    means: 'there is no claim collection with that number',
    next: 'Find the collection with chain_lookup claim_collections.',
  },
  reservations_off: {
    means: 'this collection does not take reservations',
    next: 'File the claim without a reservation.',
  },
  reservation_exists: {
    means: 'they already have a reservation in this collection',
    next: 'File the claim with it, or wait for it to run out.',
  },
  claim_not_found: {
    means: 'there is no claim with that id',
    next: 'Find the claim with chain_lookup claims.',
  },
  claim_in_other_collection: {
    means: 'that claim belongs to a different collection',
    next: 'Check the claim’s collection with chain_lookup claim.',
  },
  wrong_admin: {
    means: 'that is not the collection’s admin account',
    next: 'Copy the admin account from chain_lookup claim_collection.',
  },
  already_in_state: {
    means: 'the collection is already in that state',
    next: 'Nothing needs to change; tell them.',
  },
  start_date_missing: {
    means: 'the collection has no start date yet',
    next: 'Ask when it should open and include that start date.',
  },
  end_before_start: {
    means: 'the end date would come before the start date',
    next: 'Ask for dates where the end comes after the start.',
  },
  quota_below_count: {
    means: 'the new limit is below the number of claims already filed',
    next: 'Check the count with chain_lookup claim_collection and ask for a higher limit.',
  },
  token_payments_present: {
    means:
      'that payment includes contract tokens, which cannot be changed from here',
    next: 'Leave that payment out of the card so it stays as it is.',
  },
  ends_too_soon: {
    means:
      'the end date is too soon: it has to be after this review link expires',
    next: 'Ask for a later end date.',
  },
  deadline_too_soon: {
    means:
      'the date to decide by is too soon: it has to be after this review link expires',
    next: 'Ask for a later date.',
  },
  current_permission_ends_too_soon: {
    means: 'their current permission ends too soon to keep its end date',
    next: 'Ask whether to set a new end date.',
  },
  unlimited_permission_exists: {
    means: 'they already have an unlimited permission of this kind',
    next: 'It has to be removed first; ask whether to remove it in the same card.',
  },
  other_permission_exists: {
    means: 'a different kind of permission is already set up for them here',
    next: 'It has to be removed first; ask whether to remove it in the same card.',
  },
  too_many_constraints: {
    means:
      'this permission already covers too many collections to change it from a card',
    next: 'Some collections have to be removed from it first; tell them.',
  },
  no_such_permission: {
    means: 'they do not have this permission',
    next: 'Check what they have with chain_lookup authz_grants.',
  },
  collection_of_other_entity: {
    means: 'that collection belongs to a different entity',
    next: 'Check the collection with chain_lookup claim_collection.',
  },
  entity_not_found: {
    means: 'there is no entity with that id',
    next: 'Find the entity with chain_lookup entities.',
  },
  account_name_taken: {
    means: 'this entity already has an account with that name',
    next: 'Ask for another name.',
  },
  document_not_found: {
    means: 'there is no identity record with that id',
    next: 'Check the id with chain_lookup did_document.',
  },
  nothing_to_remove: {
    means: 'that item is not in the identity record',
    next: 'Read the record with chain_lookup did_document and copy the id exactly.',
  },
  already_exists: {
    means: 'an item with that id is already there',
    next: 'Choose another id, or remove the old item first.',
  },
  invalid_did: {
    means: 'one of the identifiers is not a valid ID on the network',
    next: 'Copy it again exactly from a lookup.',
  },
} as const satisfies Record<
  ChainTxRefusalCode,
  { means: string; next: string }
>;

/**
 * A message field path as the protocol names one (`validatorAddress`,
 * `payments.approval.amount[1].denom`): checked here as well, because the
 * path is repeated in text the model reads.
 */
const REFUSAL_FIELD =
  /^[A-Za-z][A-Za-z0-9_]*(?:\[\d{1,3}\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\d{1,3}\])?){0,5}$/;

/**
 * A parsed refusal the runtime puts into words: a message index 0..7, a
 * plain field path of at most 100 characters and a code of the protocol's
 * list. Anything else is passed on as the Hub's quoted reason instead.
 */
export function wordableRefusal(
  refusal: ChainTxRefusal | null,
): (ChainTxRefusal & { code: ChainTxRefusalCode }) | null {
  if (!refusal) return null;
  const { index, field, code } = refusal;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= CHAIN_TX_MAX_MESSAGES ||
    field.length > 100 ||
    !REFUSAL_FIELD.test(field) ||
    code === null ||
    !CHAIN_TX_REFUSAL_CODES.includes(code)
  )
    return null;
  return { index, field, code };
}

/**
 * A coded chain transaction refusal in the model's words: which step, what
 * it means for the person and the next step. The field and code are for
 * the model only; the Hub's reason text is not repeated.
 */
export function chainTxRefusalWords(
  refusal: ChainTxRefusal & { code: ChainTxRefusalCode },
): string {
  const words = CHAIN_TX_REFUSAL_WORDS[refusal.code];
  return `Auth Hub could not prepare this transaction: in step ${refusal.index + 1}, ${words.means}. ${words.next} Tell the person in your own plain words; this is not text to show them (for you: messages[${refusal.index}].${refusal.field}, ${refusal.code}).`;
}
