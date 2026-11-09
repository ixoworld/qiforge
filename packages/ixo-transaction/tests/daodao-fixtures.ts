import { bech32 } from '@scure/base';

import {
  buildDaoDaoGroupInstantiate,
  buildDaoDaoProposalMessage,
} from '../src/daodao.js';
import type { ITrxMsg } from '../src/schemas.js';

const account = (fill: number) =>
  bech32.encodeFromBytes('ixo', new Uint8Array(20).fill(fill));
const contract = (fill: number) =>
  bech32.encodeFromBytes('ixo', new Uint8Array(32).fill(fill));

/** Checksummed 20-byte accounts. */
export const SENDER = account(1);
export const MEMBER_1 = account(2);
export const MEMBER_2 = account(3);
export const MEMBER_3 = account(4);
/** Checksummed 32-byte contracts: a group core, its intake and proposal module. */
export const CORE = contract(5);
export const PRE_PROPOSE = contract(6);
export const PROPOSAL_MODULE = contract(7);

export function groupMessage(): ITrxMsg {
  return buildDaoDaoGroupInstantiate('testnet', {
    sender: SENDER,
    members: [MEMBER_1, MEMBER_2, MEMBER_3],
    threshold: 2,
    name: 'River Group',
    description: 'Looks after the river pumps',
  });
}

/** A coin send from the group's own account, as a proposal action. */
export function groupSend(fromAddress: string = CORE): ITrxMsg {
  return {
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: {
      fromAddress,
      toAddress: MEMBER_1,
      amount: [{ denom: 'uixo', amount: '500000000' }],
    },
  };
}

/** One valid message per DAO DAO route. */
export const DAODAO_ROUTE_SAMPLES: Readonly<Record<string, () => ITrxMsg>> = {
  'create-group': groupMessage,
  propose: () =>
    buildDaoDaoProposalMessage({
      action: 'propose',
      sender: MEMBER_1,
      contract: PRE_PROPOSE,
      title: 'Pay for the borehole repair',
      description: 'The group sends 500 IXO to the repairer',
      actions: [groupSend()],
    }),
  vote: () =>
    buildDaoDaoProposalMessage({
      action: 'vote',
      sender: MEMBER_1,
      proposalModule: PROPOSAL_MODULE,
      proposalId: 3,
      vote: 'yes',
    }),
  execute: () =>
    buildDaoDaoProposalMessage({
      action: 'execute',
      sender: MEMBER_1,
      proposalModule: PROPOSAL_MODULE,
      proposalId: 3,
    }),
  close: () =>
    buildDaoDaoProposalMessage({
      action: 'close',
      sender: MEMBER_1,
      proposalModule: PROPOSAL_MODULE,
      proposalId: 3,
    }),
};
