import type { KindDef } from '../types';
import { agentDeposits } from './agent-deposits';
import { daoProposals } from './dao-proposals';
import { daos } from './daos';
import { disputes } from './disputes';
import { evaluations } from './evaluations';
import { liquidStakeHistory } from './liquid-stake-history';
import { memberBudgets } from './member-budgets';
import { tokenHistory } from './token-history';

/** Kinds answered by the Blocksync index, in catalogue order. */
export const INDEXED_KINDS: readonly KindDef[] = [
  tokenHistory,
  evaluations,
  memberBudgets,
  agentDeposits,
  disputes,
  daos,
  daoProposals,
  liquidStakeHistory,
];
