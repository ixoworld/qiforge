import {
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginTool,
} from '@ixo/oracle-runtime/plugin-api';

import { createIxoTransactionTools } from './tools.js';

export class IxoTransactionPlugin extends OraclePlugin {
  readonly name = 'ixo-transaction';
  readonly version = '0.1.0';
  readonly manifest: PluginManifest = {
    title: 'IXO Transaction',
    summary:
      "Configure, validate, risk-gate, and dispatch IXO transactions to the user's Portal wallet for signing. Defaults to testnet; requires explicit risk confirmation before risky transactions; the user always signs in their own wallet.",
    whenToUse: [
      'The user asks to prepare an IXO chain transaction for Portal signing.',
      'The user provides a slash command such as /ixo entity create or /ixo token retire.',
      'The user describes an IXO transaction in natural language and needs deterministic Msg routing.',
      'Workflow: classify the intent, collect and validate required fields, disclose the risks, and only call sign_ixo_transaction after the user explicitly confirms. Default to testnet before mainnet.',
    ],
    whenNotToUse: [
      'The user only wants to query chain state or inspect account balances.',
      'The user asks the oracle to sign, broadcast, or custody keys directly — signing always happens in the user wallet.',
      'The transaction belongs to a query-only or deferred module (epochs, mint, bonds, liquidstake, names).',
    ],
    examples: [
      {
        user: '/ixo entity create',
        thought:
          'Resolve the slash command, collect required fields, validate the draft, report risks, then dispatch to the Portal wallet after confirmation.',
        tool: 'list_ixo_transaction_routes',
        args: { messageType: 'entity' },
      },
      {
        user: 'I want to create a new domain',
        thought:
          'Classify natural language to MsgCreateEntity before asking for required parameters.',
        tool: 'classify_ixo_transaction_intent',
        args: { input: 'I want to create a new domain' },
      },
      {
        user: 'Sign the mainnet transfer after this Pandora testnet tx succeeded.',
        thought:
          'Validate the mainnet draft with the testnet receipt and risk confirmation before dispatching the sign_transaction wallet action.',
        tool: 'sign_ixo_transaction',
        args: {
          command: '/ixo entity transfer',
          network: 'mainnet',
          value: {
            id: 'did:ixo:entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ownerDid: 'did:ixo:ixo1qwertyuiopasdfghjklzxcvbnmqwerty12345',
            ownerAddress: 'ixo1qwertyuiopasdfghjklzxcvbnmqwerty12345',
            recipientDid: 'did:ixo:ixo1zxcvbnmqwertyuiopasdfghjkl1234567890ab',
          },
          riskConfirmation: {
            confirmed: true,
            acceptedRisks: ['Entity ownership will transfer to the recipient.'],
          },
          testnetReceipt: {
            network: 'testnet',
            transactionHash:
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            code: 0,
          },
        },
      },
    ],
    tags: ['ixo', 'portal', 'transaction', 'wallet', 'cosmos', 'zod'],
    category: 'integration',
    visibility: 'on-demand',
    stability: 'experimental',
  };

  getTools(_ctx: PluginContext): PluginTool[] {
    return createIxoTransactionTools();
  }
}

export function createIxoTransactionPlugin(): IxoTransactionPlugin {
  return new IxoTransactionPlugin();
}
