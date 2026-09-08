/**
 * Bundled Workers-runtime plugins — ports of the Node runtime's MCP / fetch
 * plugins. Each is gated the same way as on Node: `autoDetect` on its env
 * key where one exists (memory / sandbox / firecrawl / composio), always-on
 * otherwise (domain-indexer; vfs self-gates on `ctx.ucan.hasSigningKey()`).
 *
 * A host opts in by spreading `BUNDLED_WORKERS_PLUGINS` into
 * `createOracleWorker({ plugins })` — plugins whose env keys are absent are
 * skipped by their `autoDetect`.
 */
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
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
/** TasksPlugin is already an object (defineOraclePlugin), not a class. */
export const tasksPlugin = TasksPlugin;

/**
 * The bundled plugin set ported to the Workers runtime, in dependency-free
 * registration order. Forks that need custom options construct their own
 * instances instead of using these singletons.
 */
export const BUNDLED_WORKERS_PLUGINS = [
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
] as const satisfies readonly OraclePlugin[];
