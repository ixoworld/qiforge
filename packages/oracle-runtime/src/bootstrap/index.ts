import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { OracleIdentity } from '../plugin-api/types.js';

export interface CreateOracleAppOptions {
  identity: OracleIdentity;
  plugins: OraclePlugin[];
  port?: number;
}

export interface OracleApp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNestApp(): any;
  beforeListen(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (app: any) => void | Promise<void>,
  ): OracleApp;
  onPluginStatusChange(
    listener: (event: { plugin: string; status: string; reason?: string }) => void,
  ): OracleApp;
  listen(): Promise<void>;
}

export function createOracleApp(_options: CreateOracleAppOptions): Promise<OracleApp> {
  throw new Error('not implemented');
}

export { resolvePlugins, topoSort } from './plugin-loader.js';
export type {
  ResolvePluginsInput,
  ResolvePluginsResult,
  ExcludedPlugin,
  SoftDepGap,
  FeatureToggle,
} from './plugin-loader.js';

export { composeEnvSchema, validateEnv } from './schema-composer.js';
export type {
  ComposeEnvSchemaResult,
  ValidateEnvResult,
  ValidateEnvError,
} from './schema-composer.js';

export { inspect } from './inspect.js';
export type {
  InspectInput,
  InspectOutput,
  InspectPluginEntry,
  CollectedRegistries,
} from './inspect.js';
