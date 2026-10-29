import type { KindDef } from '../types';
import { accountKind, smartAccountKind, spendableKind } from './account';
import { claimIntentsKind, collectionMembershipKind } from './claims';
import { networkEconomicsKind } from './economics';
import { govProposalsKind } from './governance';
import { authzGrantsKind, feeGrantsKind } from './grants';
import { liquidStakingKind } from './liquid-staking';
import { stakingKind } from './staking';

/** Kinds answered by chain REST reads, in catalogue order. */
export const CHAIN_KINDS: readonly KindDef[] = [
  feeGrantsKind,
  authzGrantsKind,
  smartAccountKind,
  accountKind,
  stakingKind,
  spendableKind,
  liquidStakingKind,
  networkEconomicsKind,
  govProposalsKind,
  claimIntentsKind,
  collectionMembershipKind,
];
