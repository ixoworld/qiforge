import { z } from 'zod';

import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import { createIxoTransactionTools, DEFAULT_SIGN_TIMEOUT_MS } from './tools.js';

const manifest: PluginManifest = {
  title: 'IXO Transaction',
  summary:
    "Prepare, validate, risk-gate, and sign IXO chain transactions with the user's Portal wallet.",
  whenToUse: [
    'The user asks to create, update, transfer, grant, revoke, submit, evaluate, mint, retire, or otherwise prepare an IXO chain transaction.',
    'The user gives a slash command such as `/ixo entity create` or `/ixo token retire`.',
    'The user describes a transaction in natural language ("create a new domain", "retire my credits") and needs it routed to the right Msg and signed.',
  ],
  whenNotToUse: [
    'The user only wants to read chain state or balances (this plugin is write-path only).',
    'The user asks the oracle to sign or broadcast directly — signing always happens in the user wallet.',
    'The transaction belongs to a deferred module (bonds, liquidstake, names) not yet supported.',
  ],
  examples: [
    {
      user: '/ixo entity create',
      thought:
        'Resolve the route and required fields first, then collect values and surface risks before signing.',
      tool: 'list_ixo_transaction_routes',
      args: { messageType: 'entity' },
    },
    {
      user: 'I want to create a new domain',
      thought: 'Classify the natural-language intent to a canonical Msg.',
      tool: 'classify_ixo_transaction_intent',
      args: { input: 'I want to create a new domain' },
    },
    {
      user: 'Yes, I accept those risks — go ahead and sign it.',
      thought:
        'Risks were disclosed and accepted; dispatch the validated transaction to the wallet.',
      tool: 'sign_ixo_transaction',
    },
  ],
  tags: ['ixo', 'portal', 'transaction', 'wallet', 'signx', 'cosmos'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'experimental',
};

const signTimeoutSchema = z.coerce
  .number()
  .int()
  .positive()
  .catch(DEFAULT_SIGN_TIMEOUT_MS);

/**
 * IXO Transaction plugin. Turns conversation into a validated IXO transaction
 * and dispatches it to the user's Portal wallet (`sign_transaction` AG-UI
 * action) for signing. The oracle never signs, broadcasts, or holds keys.
 */
export class IxoTransactionPlugin extends OraclePlugin {
  readonly name = 'ixo-transaction';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  readonly configSchema = z.object({
    IXO_TRANSACTION_SIGN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_SIGN_TIMEOUT_MS),
  });

  getTools(ctx: PluginContext): PluginTool[] {
    const signTimeoutMs = signTimeoutSchema.parse(
      ctx.config.IXO_TRANSACTION_SIGN_TIMEOUT_MS,
    );
    return createIxoTransactionTools({ signTimeoutMs });
  }
}
