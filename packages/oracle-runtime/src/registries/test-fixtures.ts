import { z } from 'zod';
import { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../plugin-api/types.js';

/** Build a minimal PluginContext sufficient for registry collection. */
export function makeBuildCtx(
  overrides: Partial<PluginContext> = {},
): PluginContext {
  const noopLogger = {
    log: () => undefined,
    error: () => undefined,
    warn: () => undefined,
  };
  return {
    config: {},
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'test oracle',
      entityDid: 'did:ixo:test',
    },
    availablePlugins: new Set<string>(),
    logger: noopLogger,
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
 * Build a minimally-typed AgentMiddleware fixture for registry tests.
 * Registries only store and forward middlewares — they never invoke them —
 * so a name-only object satisfies the structural type without pulling
 * langchain into the test module graph.
 */
export function makeMiddleware(label: string): AgentMiddleware {
  return { name: label } satisfies { name: string };
}

/**
 * Build a plain `OraclePlugin`-conforming object. Avoids subclassing the
 * abstract class so tests stay shape-driven and tolerate API additions.
 */
export interface TestPluginInit {
  name: string;
  version?: string;
  manifest?: PluginManifest;
  dependsOn?: string[];
  softDependsOn?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema?: z.ZodObject<any>;
  autoDetect?: (env: NodeJS.ProcessEnv) => boolean;
  autoDetectHint?: string;
  getTools?: (ctx: PluginContext) => PluginTool[] | Promise<PluginTool[]>;
  getSubAgents?: (ctx: PluginContext) => PluginSubAgent[];
  getMiddlewares?: (ctx: PluginContext) => AgentMiddleware[];
  getSharedState?: () => Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (state: any, runCtx: RuntimeContext) => unknown
  >;
}

/**
 * Minimal `RuntimeContext` stub used by `SharedStateRegistry.build` tests.
 * Mirrors the pattern in `plugin-api.test.ts` — `satisfies RuntimeContext`
 * keeps the shape honest with one narrow assertion on the unrelated LLM
 * adapter return.
 */
export function makeRuntimeContext(
  overrides: Partial<RuntimeContext> = {},
): RuntimeContext {
  const base = {
    user: {
      did: 'did:ixo:user1',
      matrixUserId: '@did-ixo-user1:ixo.world',
      ucanDelegation: { raw: 'test-ucan-delegation' },
    },
    session: {
      id: 'session-1',
      client: 'portal' as const,
      requestId: 'req-1',
    },
    history: {
      messages: [],
      recent: () => [],
      userContext: {},
      state: { messages: [] },
    },
    config: {},
    availablePlugins: new Set<string>(),
    loadedPlugins: new Set<string>(),
    secrets: {
      getIndex: async () => ({}),
      getValues: async () => ({}),
    },
    matrix: {
      postToRoom: async () => 'event-id',
      getRoomState: async (roomId: string) => ({ roomId, state: [] }),
      getEventById: async (_roomId: string, eventId: string) => ({
        eventId,
        type: 'm.room.message',
        content: {},
      }),
    },
    ucan: {
      requireCapability: () => undefined,
      hasCapability: () => true,
      mintInvocation: async () => 'invocation-cid',
    },
    llm: {
      get: () => ({}) as unknown as RuntimeContext['llm'] extends {
        get: (...a: unknown[]) => infer R;
      }
        ? R
        : never,
    },
    emit: {
      toolCall: () => undefined,
      actionCall: () => undefined,
      renderComponent: () => undefined,
      reasoning: () => undefined,
      browserToolCall: () => undefined,
      router: () => undefined,
      messageCacheInvalidation: () => undefined,
    },
    logger: {
      log: () => undefined,
      error: () => undefined,
      warn: () => undefined,
    },
    abortSignal: new AbortController().signal,
    shared: {},
  } satisfies RuntimeContext;

  return { ...base, ...overrides };
}

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

    override autoDetect(env: NodeJS.ProcessEnv): boolean {
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
