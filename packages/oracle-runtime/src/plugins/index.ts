import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../plugin-api/types.js';
import { AGUIPlugin } from './agui/index.js';
import { ComposioPlugin } from './composio/index.js';
import { CreditsPlugin } from './credits/index.js';
import { DomainIndexerPlugin } from './domain-indexer/index.js';
import { EditorPlugin } from './editor/index.js';
import { FirecrawlPlugin } from './firecrawl/index.js';
import { MatrixGroupChatsPlugin } from './matrix-group-chats/index.js';
import { MemoryPlugin } from './memory/index.js';
import { PortalPlugin } from './portal/index.js';
import { SandboxPlugin } from './sandbox/index.js';
import { SkillsPlugin } from './skills/index.js';
import { SlackPlugin } from './slack/index.js';
import { UserPreferencesPlugin } from './user-preferences/index.js';

const stubManifest = (title: string): PluginManifest => ({
  title,
  summary: `${title} plugin.`,
  whenToUse: [],
  visibility: 'silent',
  stability: 'experimental',
});

const stub = <Name extends string>(
  name: Name,
  title: string,
  extras: Omit<Partial<OraclePlugin>, 'name'> = {},
): OraclePlugin & { readonly name: Name } => ({
  version: '0.0.0',
  manifest: stubManifest(title),
  ...extras,
  name,
});

export const memoryPlugin = new MemoryPlugin();
export const portalPlugin = new PortalPlugin();
export const firecrawlPlugin = new FirecrawlPlugin();
export const domainIndexerPlugin = new DomainIndexerPlugin();
export const composioPlugin = new ComposioPlugin();
export const sandboxPlugin = new SandboxPlugin();
export const skillsPlugin = new SkillsPlugin();
export const editorPlugin = new EditorPlugin();
export const aguiPlugin = new AGUIPlugin();
export const slackPlugin = new SlackPlugin();
export const tasksPlugin = stub('tasks', 'Tasks', {
  autoDetect: (env) => Boolean(env.REDIS_URL),
  autoDetectHint: 'REDIS_URL',
});
export const creditsPlugin = new CreditsPlugin();
export const callsPlugin = stub('calls', 'Calls');
export const userPreferencesPlugin = new UserPreferencesPlugin();
export const matrixGroupChatsPlugin = new MatrixGroupChatsPlugin();

/**
 * The canonical bundled-plugin set used by `createOracleApp` when the
 * caller does not supply `bundledPlugins`. Forks that need a custom
 * bundled set pass their own array via `bundledPlugins`.
 *
 * Typed as a readonly tuple via `as const` so `BundledFeatureName` can
 * derive the literal union of plugin names from this single source.
 */
export const BUNDLED_PLUGINS = [
  memoryPlugin,
  portalPlugin,
  firecrawlPlugin,
  domainIndexerPlugin,
  composioPlugin,
  sandboxPlugin,
  skillsPlugin,
  editorPlugin,
  aguiPlugin,
  slackPlugin,
  tasksPlugin,
  creditsPlugin,
  callsPlugin,
  userPreferencesPlugin,
  matrixGroupChatsPlugin,
] as const satisfies ReadonlyArray<OraclePlugin>;
