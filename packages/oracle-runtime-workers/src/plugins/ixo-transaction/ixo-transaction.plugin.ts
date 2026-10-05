/**
 * IXO transaction plugin: turns a conversation into a validated IXO chain
 * transaction and asks the user's Portal wallet to sign it. On demand, and
 * opt-in — not part of `BUNDLED_WORKERS_PLUGINS`; an oracle adds
 * `new IxoTransactionPlugin()` to its plugins.
 *
 * The catalog, intent routing and validation come from the runtime-neutral
 * `@ixo/ixo-transaction` package, whose Portal half
 * (`@ixo/ixo-transaction/react`) answers the `sign_transaction` action.
 */
import { ChainIdSchema, DEFAULT_CHAIN_IDS } from '@ixo/ixo-transaction';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types';
import { createIxoTransactionTools } from './tools';

/** Default time the user has to sign in their wallet. */
export const DEFAULT_SIGN_TIMEOUT_MS = 120_000;
/** Upper bound: well inside the turn's own deadline (`TURN_TIMEOUT_MS`, 10 min by default). */
export const MAX_SIGN_TIMEOUT_MS = 300_000;

function chainIdSetting(defaultId: string) {
  return ChainIdSchema.default(defaultId);
}

const configSchema = z.object({
  /**
   * `'true'` lets mainnet drafts through validation, each still needing a
   * successful testnet receipt or a recorded override. Off by default: the
   * oracle prepares testnet (and devnet) transactions only.
   */
  IXO_TRANSACTION_ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  /**
   * The chain id each network's requests name; the Portal refuses a request
   * for another chain than its wallet's. The defaults are what each
   * network's RPC reports (`DEFAULT_CHAIN_IDS`); override after a chain
   * upgrade changes the id.
   */
  IXO_TRANSACTION_CHAIN_ID_DEVNET: chainIdSetting(DEFAULT_CHAIN_IDS.devnet),
  IXO_TRANSACTION_CHAIN_ID_TESTNET: chainIdSetting(DEFAULT_CHAIN_IDS.testnet),
  IXO_TRANSACTION_CHAIN_ID_MAINNET: chainIdSetting(DEFAULT_CHAIN_IDS.mainnet),
  /** How long `sign_ixo_transaction` waits for the wallet, in ms. */
  IXO_TRANSACTION_SIGN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_SIGN_TIMEOUT_MS)
    .default(DEFAULT_SIGN_TIMEOUT_MS),
});

const manifest: PluginManifest = {
  title: 'IXO Transaction',
  summary:
    'Prepares and validates IXO chain transactions; the user signs them in their Portal wallet.',
  whenToUse: [
    'The user wants to create, update, transfer, submit, evaluate, mint or retire on the IXO chain.',
    'The user types a slash command such as /ixo entity create or /ixo token retire.',
    'Classify, collect fields, validate, disclose risks, then sign only after explicit consent.',
  ],
  whenNotToUse: [
    'Reading chain state or balances: this plugin only prepares writes.',
    'Asking the oracle to sign itself: only the user signs, in their wallet.',
    'Bonds, liquid staking or names: not supported yet.',
  ],
  examples: [
    {
      user: 'I want to create a new domain',
      thought:
        'Resolve the request to a Msg first, then collect its required fields.',
      tool: 'classify_ixo_transaction_intent',
      args: { input: 'I want to create a new domain' },
    },
    {
      user: '/ixo token retire',
      thought:
        'List the route to see its fields and risks before asking for values.',
      tool: 'list_ixo_transaction_routes',
      args: { messageType: 'token' },
    },
    {
      user: 'Yes, I accept that retiring is permanent. Sign it.',
      thought:
        "Risks disclosed and accepted in the user's words: send the testnet draft to the wallet.",
      tool: 'sign_ixo_transaction',
      args: {
        command: '/ixo token retire',
        network: 'testnet',
        value: {
          owner: 'ixo1qwertyuiopasdfghjklzxcvbnmqwerty12345',
          tokens: [{ id: 'CARBON-1', amount: '10' }],
          jurisdiction: 'ZA',
          reason: 'Offsetting 2026 travel',
        },
        riskConfirmation: {
          confirmed: true,
          acceptedRisks: [
            'Permanently retires (burns) impact credits. Irreversible.',
          ],
        },
      },
    },
  ],
  tags: ['ixo', 'transaction', 'wallet', 'portal', 'cosmos'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'experimental',
};

export class IxoTransactionPlugin extends OraclePlugin {
  readonly name = 'ixo-transaction';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override getTools(ctx: PluginContext): PluginTool[] {
    const config = configSchema.parse(ctx.config);
    return createIxoTransactionTools({
      allowMainnet: config.IXO_TRANSACTION_ALLOW_MAINNET === 'true',
      signTimeoutMs: config.IXO_TRANSACTION_SIGN_TIMEOUT_MS,
      chainIds: {
        devnet: config.IXO_TRANSACTION_CHAIN_ID_DEVNET,
        testnet: config.IXO_TRANSACTION_CHAIN_ID_TESTNET,
        mainnet: config.IXO_TRANSACTION_CHAIN_ID_MAINNET,
      },
    });
  }
}
