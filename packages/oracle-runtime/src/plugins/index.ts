import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../plugin-api/types.js';

const stubManifest = (title: string): PluginManifest => ({
  title,
  summary: `${title} plugin.`,
  whenToUse: [],
  visibility: 'silent',
  stability: 'experimental',
});

const stub = (
  name: string,
  title: string,
  extras: Partial<OraclePlugin> = {},
): OraclePlugin => ({
  name,
  version: '0.0.0',
  manifest: stubManifest(title),
  ...extras,
});

export const memoryPlugin: OraclePlugin = stub('memory', 'Memory');
export const portalPlugin: OraclePlugin = stub('portal', 'Portal');
export const firecrawlPlugin: OraclePlugin = stub('firecrawl', 'Firecrawl');
export const domainIndexerPlugin: OraclePlugin = stub(
  'domain-indexer',
  'Domain Indexer',
);
export const composioPlugin: OraclePlugin = stub('composio', 'Composio', {
  autoDetect: (env) => Boolean(env.COMPOSIO_API_KEY),
  autoDetectHint: 'COMPOSIO_API_KEY',
});
export const sandboxPlugin: OraclePlugin = stub('sandbox', 'Sandbox');
export const skillsPlugin: OraclePlugin = stub('skills', 'Skills', {
  dependsOn: ['sandbox'],
});
export const editorPlugin: OraclePlugin = stub('editor', 'Editor');
export const aguiPlugin: OraclePlugin = stub('agui', 'AG-UI');
export const slackPlugin: OraclePlugin = stub('slack', 'Slack', {
  autoDetect: (env) => Boolean(env.SLACK_BOT_OAUTH_TOKEN),
  autoDetectHint: 'SLACK_BOT_OAUTH_TOKEN',
});
export const tasksPlugin: OraclePlugin = stub('tasks', 'Tasks', {
  autoDetect: (env) => Boolean(env.REDIS_URL),
  autoDetectHint: 'REDIS_URL',
});
export const creditsPlugin: OraclePlugin = stub('credits', 'Credits', {
  autoDetect: (env) => env.DISABLE_CREDITS !== 'true',
  autoDetectHint: 'DISABLE_CREDITS!=true',
});
export const claimProcessingPlugin: OraclePlugin = stub(
  'claim-processing',
  'Claim Processing',
  { dependsOn: ['credits'] },
);
export const langfusePlugin: OraclePlugin = stub('langfuse', 'Langfuse', {
  autoDetect: (env) =>
    Boolean(env.LANGFUSE_SECRET_KEY && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_HOST),
  autoDetectHint: 'LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY + LANGFUSE_HOST',
});
export const callsPlugin: OraclePlugin = stub('calls', 'Calls');
export const userPreferencesPlugin: OraclePlugin = stub(
  'user-preferences',
  'User Preferences',
);
