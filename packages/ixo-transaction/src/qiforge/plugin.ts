import {
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginTool,
} from '@ixo/oracle-runtime';

import { createIxoTransactionTools } from './tools.js';

export class IxoTransactionPlugin extends OraclePlugin {
  readonly name = 'ixo-transaction';
  readonly version = '0.1.0';
  readonly manifest: PluginManifest = {
    title: 'IXO Transaction',
    summary:
      'Configure, validate, risk-gate, and render IXO Portal signxTransaction payloads.',
    whenToUse: [
      'The user asks to prepare an IXO chain transaction for Portal signing.',
      'The user provides a slash command such as /ixo entity create or /ixo token retire.',
      'The user describes an IXO transaction in natural language and needs deterministic Msg routing.',
    ],
    whenNotToUse: [
      'The user only wants to query chain state or inspect account balances.',
      'The user asks the agent to sign, broadcast, or custody keys directly.',
      'The transaction module is query-only, such as epochs or mint.',
    ],
    examples: [
      {
        user: '/ixo entity create',
        thought:
          'Resolve the slash command, collect required fields, validate the draft, report risks, then render after confirmation.',
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
        user: 'Render the mainnet signing payload after this Pandora testnet tx succeeded.',
        thought:
          'Validate the mainnet draft with the testnet receipt and risk confirmation before rendering signxTransaction.',
        tool: 'render_ixo_transaction_payload',
      },
    ],
    tags: ['ixo', 'portal', 'transaction', 'signx', 'cosmos', 'zod'],
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
