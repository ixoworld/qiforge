import { ActionProposalsPlugin } from './action-proposals/action-proposals.plugin';
import { HubActionsPlugin } from './hub-actions/hub-actions.plugin';
import { IxoChainPlugin } from './ixo-chain';
import { IxoTransactionPlugin } from './ixo-transaction';
export { ActionProposalsPlugin } from './action-proposals/action-proposals.plugin';
export { HubActionsPlugin } from './hub-actions/hub-actions.plugin';
/**
 * Bundled Workers-runtime plugins — ports of the Node runtime's MCP / fetch
 * plugins. Each is gated the same way as on Node: `autoDetect` on its env
 * key where one exists (memory / sandbox / firecrawl / composio), always-on
 * otherwise (domain-indexer; ixo-chain unless `IXO_CHAIN_TOOLS=off`; vfs
 * self-gates on `ctx.ucan.hasSigningKey()`; sandbox, vfs, pod-creator,
 * ixo-chain and ixo-transaction are on-demand and stay hidden until
 * `load_capability`).
 *
 * A host opts in by spreading `BUNDLED_WORKERS_PLUGINS` into
 * `createOracleWorker({ plugins })` — plugins whose env keys are absent are
 * skipped by their `autoDetect`. A plugin listed twice (by name) is loaded
 * once, as its last instance: a host passes its own configured instance
 * after the spread.
 *
 * `IxoTransactionPlugin` asks the user's Portal wallet to sign chain
 * transactions (DAO DAO group proposal steps included). Its tools exist on
 * Portal turns only, so Matrix and channel turns never see it (chain steps
 * there go through hub-actions); mainnet signing stays off unless
 * `IXO_TRANSACTION_ALLOW_MAINNET=true`.
 *
 * asks.world (`AsksPlugin`) self-gates on `ASKS_TOKEN_KEY`, `ORACLE_PUBLIC_URL`
 * and `NETWORK`; the host also binds and exports `AsksConnectionDO`
 * (`docs/asks.md`).
 *
 * Credentials (`CredentialsPlugin`, credential checks and the Hub's
 * permission cards, WhatsApp only) is off unless `CREDENTIALS_ENABLED=true`
 * and `AUTH_HUB_CHANNEL_SERVICE_KEY` are set
 * (`src/plugins/credentials/README.md`).
 */
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import { AsksPlugin } from './asks';
import { ComposioPlugin } from './composio';
import { EditorPlugin } from './editor';
import { TasksPlugin } from './tasks'; // pre-constructed object (defineOraclePlugin)
import { DomainIndexerPlugin } from './domain-indexer';
import { FirecrawlPlugin } from './firecrawl';
import { MemoryPlugin } from './memory';
import { SandboxPlugin } from './sandbox';
import { VfsPlugin } from './vfs';
import { UserPreferencesPlugin } from './user-preferences';
import { PortalPlugin } from './portal';
import { AGUIPlugin } from './agui';
import { AttachmentsPlugin } from './attachments';
import { MatrixGroupChatsPlugin } from './matrix-group-chats';
import { PodCreatorPlugin } from './pod-creator';
import { CredentialsPlugin } from './credentials';

export * from './asks';
export * from './composio';
export * from './editor';
export * from './flows';
export * from './tasks';
export * from './domain-indexer';
export * from './firecrawl';
export * from './memory';
export * from './sandbox';
export * from './vfs';
export * from './user-preferences';
export * from './portal';
export * from './agui';
export * from './ixo-transaction';
export * from './ixo-chain';
export * from './pod-creator';
export * from './credentials';

export const memoryPlugin = new MemoryPlugin();
export const sandboxPlugin = new SandboxPlugin();
export const firecrawlPlugin = new FirecrawlPlugin();
export const domainIndexerPlugin = new DomainIndexerPlugin();
export const composioPlugin = new ComposioPlugin();
export const vfsPlugin = new VfsPlugin();
export const editorPlugin = new EditorPlugin();
export const userPreferencesPlugin = new UserPreferencesPlugin();
export const portalPlugin = new PortalPlugin();
export const aguiPlugin = new AGUIPlugin();
export const attachmentsPlugin = new AttachmentsPlugin();
export const matrixGroupChatsPlugin = new MatrixGroupChatsPlugin();
export const podCreatorPlugin = new PodCreatorPlugin();
export const asksPlugin = new AsksPlugin();
export const ixoTransactionPlugin = new IxoTransactionPlugin();
export const credentialsPlugin = new CredentialsPlugin();
/** TasksPlugin is already an object (defineOraclePlugin), not a class. */
export const tasksPlugin = TasksPlugin;

/**
 * The bundled plugin set ported to the Workers runtime, in dependency-free
 * registration order. Forks that need custom options construct their own
 * instances instead of using these singletons.
 */
export const BUNDLED_WORKERS_PLUGINS = [
  new ActionProposalsPlugin(),
  new HubActionsPlugin(),
  new IxoChainPlugin(),
  memoryPlugin,
  sandboxPlugin,
  firecrawlPlugin,
  domainIndexerPlugin,
  composioPlugin,
  vfsPlugin,
  tasksPlugin,
  editorPlugin,
  userPreferencesPlugin,
  portalPlugin,
  aguiPlugin,
  attachmentsPlugin,
  matrixGroupChatsPlugin,
  ixoTransactionPlugin,
  podCreatorPlugin,
  asksPlugin,
  credentialsPlugin,
] as const satisfies readonly OraclePlugin[];
