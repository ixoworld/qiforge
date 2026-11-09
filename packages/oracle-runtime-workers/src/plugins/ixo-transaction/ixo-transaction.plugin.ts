/**
 * IXO transaction plugin: turns a conversation into a validated IXO chain
 * transaction and asks the user's Portal wallet to sign it, including a new
 * DAO DAO group, linking a group to an entity it governs, and the group
 * proposal steps (propose, vote, carry out, close). On demand,
 * and in `BUNDLED_WORKERS_PLUGINS`.
 *
 * Its tools exist only on a Portal turn (`getRequestTools`): the wallet is
 * reached through the Portal tab's AG-UI `sign_transaction` action, so on a
 * Matrix, channel or Slack turn the plugin offers nothing, is not in the
 * capability catalogue and is never preloaded by the router. Chain steps in
 * a channel chat go through Auth Hub (hub-actions) instead.
 *
 * The catalog, intent routing and validation come from the runtime-neutral
 * `@ixo/ixo-transaction` package, whose Portal half
 * (`@ixo/ixo-transaction/react`) answers the `sign_transaction` action.
 */
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { chainIdConfigSchema, chainIdsFromConfig } from './chain-ids';
import { linkDaoGroupTool } from './dao-link';
import { createDaoGroupTool, createDaoProposalTools } from './dao-tools';
import { createIxoTransactionTools } from './tools';

/** Default time the user has to sign in their wallet. */
export const DEFAULT_SIGN_TIMEOUT_MS = 120_000;
/** Upper bound: well inside the turn's own deadline (`TURN_TIMEOUT_MS`, 10 min by default). */
export const MAX_SIGN_TIMEOUT_MS = 300_000;

const configSchema = z.object({
  /**
   * `'true'` lets mainnet drafts through validation, each still needing a
   * successful testnet receipt or a recorded override. Off by default: the
   * oracle prepares testnet (and devnet) transactions only.
   */
  IXO_TRANSACTION_ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  /** The chain id each network's requests name (shared with the POD creator). */
  ...chainIdConfigSchema.shape,
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
    'The user wants to create a DAO DAO group: members, a threshold of yes votes, voting rules.',
    'The user wants a DAO DAO group to govern an existing POD or entity they control (link_dao_group).',
    'The user wants to propose, vote on, carry out or close a proposal of a DAO DAO group.',
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
      user: 'Vote yes on proposal A3 of our POD group.',
      thought:
        'Addresses copied from chain_lookup dao_proposals; the first call sends nothing and returns the summary and risks to show.',
      tool: 'vote_on_dao_proposal',
      args: {
        proposalModule:
          'ixo1zxmee4zshr3sjfssau8q54rsvm0n6yd0tasr96c3366sjht67l7s08kq6a',
        proposalId: 3,
        vote: 'yes',
      },
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
  tags: ['ixo', 'transaction', 'wallet', 'portal', 'cosmos', 'dao', 'group'],
  category: 'integration',
  visibility: 'on-demand',
  brief: 'prepare chain transactions for wallet signing in Portal',
  stability: 'experimental',
};

const OPERATING_GUIDE = [
  '### IXO transactions in the Portal wallet',
  '- The user signs every transaction in their own Portal wallet; you never sign. Each signing tool needs every listed risk accepted by the user, quoted word for word.',
  '- A new DAO DAO group (“create a DAO group with members X, Y, threshold 1”): `create_dao_group` with the name, members and threshold the user gave; the user’s own account must be a member. Ask how long voting lasts and whether votes can be changed if they did not say (the tool explains the trade-off). Never use sign_ixo_transaction for it. For the governance group of a POD created in this conversation, use create_pod_group instead: it also links the group to the POD.',
  '- A group to govern a POD or other entity the user controls, made earlier, elsewhere or in the Portal (“link my board to my POD”): `link_dao_group` with the entity’s DID and the group’s core address (`dao` in chain_lookup daos), never guessed. “Make my existing POD a DAO”: `create_dao_group`, then `link_dao_group` with the new `coreAddress`. Only the POD created in this conversation uses create_pod_group and link_pod_group. Tell the user everything the preview shows (members, pass rules, notes) before they agree: the group gets full control of the entity.',
  '- DAO DAO groups (a POD’s governance group, a DAO): find the group with chain_lookup `entity` (a POD’s `governingGroup`) or `daos` (the user’s groups, with each proposal list’s `proposalModule` and `intake`), and its proposals, their tally and the user’s vote with `dao_proposals` (`dao` set; it lists open proposals unless `status: all`, so a passed, rejected or executed proposal needs `status: all`). Copy addresses and the proposal `id` exactly; never guess them. To find out whether a proposal can be carried out or closed, call `execute_dao_proposal` or `close_dao_proposal` without riskConfirmation: it reads the proposal from the chain itself and says its status.',
  '- Then `create_dao_proposal`, `vote_on_dao_proposal`, `execute_dao_proposal` or `close_dao_proposal`: first without riskConfirmation (nothing is sent; show the summary, every risk and, for a carry-out, every action), then stop; only after the user agrees in a later message, call again with the same fields and riskConfirmation. Never vote, carry out or close without the user asking for it in this conversation.',
  '- Only members vote, with the voting power they had when the proposal opened; the chain refuses anyone else. Relay a refusal with its `hint` in plain words, never as an outage.',
].join('\n');

export class IxoTransactionPlugin extends OraclePlugin {
  readonly name = 'ixo-transaction';

  readonly version = '1.1.0';

  readonly manifest = manifest;

  override readonly operatingGuide = OPERATING_GUIDE;

  override readonly configSchema = configSchema;

  /** Built on the first Portal turn: the oracle's config does not change. */
  private tools?: PluginTool[];

  /**
   * The tools, on a Portal turn only: elsewhere there is no Portal tab to
   * reach the wallet through, so the plugin stays out of the turn.
   */
  override getRequestTools(ctx: RuntimeContext): PluginTool[] {
    if (ctx.session.client !== 'portal') return [];
    if (!this.tools) {
      const config = configSchema.parse(ctx.config);
      const options = {
        allowMainnet: config.IXO_TRANSACTION_ALLOW_MAINNET === 'true',
        signTimeoutMs: config.IXO_TRANSACTION_SIGN_TIMEOUT_MS,
        chainIds: chainIdsFromConfig(config),
      };
      this.tools = [
        ...createIxoTransactionTools(options),
        createDaoGroupTool(options),
        linkDaoGroupTool(options),
        ...createDaoProposalTools(options),
      ];
    }
    return this.tools;
  }
}
