/**
 * Shared fixtures for the core test suites. Not part of the public surface.
 */
import { z } from 'zod';
import { OraclePlugin, type PluginEnv } from '../plugin-api/oracle-plugin';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../plugin-api/types';
import {
  buildRuntimeContext,
  createNoopAmbient,
  type AmbientServices,
  type RunConfig,
  type RuntimeStateInput,
} from './runtime-context';

/** Build a minimal PluginContext sufficient for registry collection. */
export function makeBuildCtx(
  overrides: Partial<PluginContext> = {},
): PluginContext {
  return {
    config: {},
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'test oracle',
      entityDid: 'did:ixo:test',
    },
    availablePlugins: new Set<string>(),
    logger: {
      log: () => undefined,
      error: () => undefined,
      warn: () => undefined,
    },
    ...overrides,
  };
}

/** Build a minimal PluginManifest for tests. */
export function makeManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    title: 'Test Plugin',
    summary: 'A plugin used in registry tests.',
    whenToUse: ['always for testing'],
    visibility: 'always',
    ...overrides,
  };
}

/** Build a PluginTool fixture with a no-op handler. */
export function makeTool(
  name: string,
  overrides: Partial<PluginTool> = {},
): PluginTool {
  return {
    name,
    description: `tool ${name}`,
    schema: z.object({}),
    handler: async () => 'ok',
    ...overrides,
  };
}

/** Build a PluginSubAgent fixture. */
export function makeSubAgent(
  name: string,
  overrides: Partial<PluginSubAgent> = {},
): PluginSubAgent {
  return {
    name,
    description: `subagent ${name}`,
    systemPrompt: 'you are a test sub-agent',
    tools: [],
    ...overrides,
  };
}

/**
 * Registries only store and forward middlewares — they never invoke them —
 * so a name-only object satisfies the structural type.
 */
export function makeMiddleware(label: string): AgentMiddleware {
  return { name: label };
}

export interface TestPluginInit {
  name: string;
  version?: string;
  manifest?: PluginManifest;
  dependsOn?: string[];
  softDependsOn?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema?: z.ZodObject<any>;
  autoDetect?: (env: PluginEnv) => boolean;
  autoDetectHint?: string;
  getTools?: (ctx: PluginContext) => PluginTool[] | Promise<PluginTool[]>;
  getSubAgents?: (ctx: PluginContext) => PluginSubAgent[];
  getMiddlewares?: (ctx: PluginContext) => AgentMiddleware[];
  getRequestTools?: (
    rtCtx: RuntimeContext,
  ) => PluginTool[] | Promise<PluginTool[]>;
  getRequestSubAgents?: (
    rtCtx: RuntimeContext,
  ) => PluginSubAgent[] | Promise<PluginSubAgent[]>;
  getSharedState?: () => Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (state: any, runCtx: RuntimeContext) => unknown
  >;
}

/** Build a class-based `OraclePlugin` from a plain init record. */
export function makePlugin(init: TestPluginInit): OraclePlugin {
  class TestPlugin extends OraclePlugin {
    readonly name = init.name;
    readonly version = init.version ?? '0.0.1';
    readonly manifest = init.manifest ?? makeManifest();
    override readonly dependsOn?: string[] = init.dependsOn;
    override readonly softDependsOn?: string[] = init.softDependsOn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override readonly configSchema?: z.ZodObject<any> = init.configSchema;
    override readonly autoDetectHint?: string = init.autoDetectHint;

    override autoDetect(env: PluginEnv): boolean {
      return init.autoDetect ? init.autoDetect(env) : true;
    }

    override getTools(
      ctx: PluginContext,
    ): PluginTool[] | Promise<PluginTool[]> {
      return init.getTools ? init.getTools(ctx) : [];
    }

    override getSubAgents(ctx: PluginContext): PluginSubAgent[] {
      return init.getSubAgents ? init.getSubAgents(ctx) : [];
    }

    override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
      return init.getMiddlewares ? init.getMiddlewares(ctx) : [];
    }

    override getRequestTools = init.getRequestTools;
    override getRequestSubAgents = init.getRequestSubAgents;

    override getSharedState(): Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state: any, runCtx: RuntimeContext) => unknown
    > {
      return init.getSharedState ? init.getSharedState() : {};
    }
  }
  return new TestPlugin();
}

/** A `RunConfig` with the default test user/session. */
export function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    context: {
      user: {
        did: 'did:ixo:user1',
        matrixUserId: '@did-ixo-user1:ixo.world',
        ucanDelegation: { raw: 'test-ucan-delegation' },
      },
      session: {
        id: 'session-1',
        client: 'portal',
        requestId: 'req-1',
      },
    },
    ...overrides,
  };
}

/**
 * A real `RuntimeContext` built through `buildRuntimeContext` over a no-op
 * ambient bag, with optional shallow overrides.
 */
export function makeRuntimeContext(
  overrides: Partial<RuntimeContext> = {},
  opts: {
    ambient?: Partial<AmbientServices>;
    state?: Partial<RuntimeStateInput>;
    runConfig?: Partial<RunConfig>;
  } = {},
): RuntimeContext {
  const ambient = createNoopAmbient(opts.ambient);
  const state: RuntimeStateInput = {
    messages: [],
    loadedPlugins: new Set<string>(),
    ...opts.state,
  };
  const base = buildRuntimeContext(
    makeRunConfig(opts.runConfig),
    ambient,
    state,
  );
  return { ...base, ...overrides };
}

/** A complete, valid Worker `env` for `createRuntimeCore`. */
export function makeEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ORACLE_NAME: 'TestOracle',
    ORACLE_DID: 'did:ixo:oracle1',
    ORACLE_ENTITY_DID: 'did:ixo:entity:oracle1',
    NETWORK: 'devnet',
    BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.example/graphql',
    MATRIX_BASE_URL: 'https://matrix.example',
    MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:matrix.example',
    MATRIX_ORACLE_ADMIN_PASSWORD: 'test-password',
    OPEN_ROUTER_API_KEY: 'sk-or-test',
    // Non-string bindings a Worker env carries; must never reach plugins.
    USER_ORACLE: { idFromName: () => undefined },
    MATRIX_GATEWAY: { idFromName: () => undefined },
    ...overrides,
  };
}
