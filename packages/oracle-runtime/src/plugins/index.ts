import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../plugin-api/types.js';
import { AGUIPlugin } from './agui/index.js';
import { DomainIndexerPlugin } from './domain-indexer/index.js';
import { FirecrawlPlugin } from './firecrawl/index.js';
import { SandboxPlugin } from './sandbox/index.js';
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

export const memoryPlugin = stub('memory', 'Memory');
export const portalPlugin = stub('portal', 'Portal');
export const firecrawlPlugin = new FirecrawlPlugin();
export const domainIndexerPlugin = new DomainIndexerPlugin();
export const composioPlugin = stub('composio', 'Composio', {
  autoDetect: (env) => Boolean(env.COMPOSIO_API_KEY),
  autoDetectHint: 'COMPOSIO_API_KEY',
});
export const sandboxPlugin = new SandboxPlugin();
export const skillsPlugin = stub('skills', 'Skills', {
  dependsOn: ['sandbox'],
});
export const editorPlugin = stub('editor', 'Editor');
export const aguiPlugin = new AGUIPlugin();
export const slackPlugin = stub('slack', 'Slack', {
  autoDetect: (env) => Boolean(env.SLACK_BOT_OAUTH_TOKEN),
  autoDetectHint: 'SLACK_BOT_OAUTH_TOKEN',
});
export const tasksPlugin = stub('tasks', 'Tasks', {
  autoDetect: (env) => Boolean(env.REDIS_URL),
  autoDetectHint: 'REDIS_URL',
});
export const creditsPlugin = stub('credits', 'Credits', {
  autoDetect: (env) => env.DISABLE_CREDITS !== 'true',
  autoDetectHint: 'DISABLE_CREDITS!=true',
});
export const claimProcessingPlugin = stub(
  'claim-processing',
  'Claim Processing',
  { dependsOn: ['credits'] },
);
export const callsPlugin = stub('calls', 'Calls');
export const userPreferencesPlugin = new UserPreferencesPlugin();

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
  claimProcessingPlugin,
  callsPlugin,
  userPreferencesPlugin,
] as const satisfies ReadonlyArray<OraclePlugin>;
