import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { OraclePlugin } from './oracle-plugin.js';
import { defineOraclePlugin } from './define-plugin.js';
import { tool } from './tool-helper.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from './types.js';

const minimalManifest: PluginManifest = {
  title: 'Demo',
  summary: 'A demo plugin',
  whenToUse: ['user mentions demo'],
};

/**
 * Minimal `PluginContext` stub used to invoke `getTools(ctx)` from class-form
 * plugins under test. Tools-construction code rarely reads ambient services
 * directly; passing a stub keeps the test focused on the plugin-api shape.
 */
function stubPluginContext<TConfig = Record<string, unknown>>(
  config: TConfig = {} as TConfig,
): PluginContext<TConfig> {
  return {
    config,
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'desc',
      entityDid: 'did:ixo:test',
    },
    availablePlugins: new Set<string>(),
    logger: {
      log: () => undefined,
      error: () => undefined,
      warn: () => undefined,
    },
  };
}

/**
 * Minimal `RuntimeContext` stub used to drive tool handlers in unit tests.
 * Fields untouched by the assertions are stubbed out — handlers under test
 * only need a real shape to read from.
 */
function makeRuntimeContext(
  overrides: Partial<RuntimeContext> = {},
): RuntimeContext {
  const base = {
    user: {
      did: 'did:ixo:user1',
      matrixUserId: '@did-ixo-user1:ixo.world',
      ucanDelegation: { raw: 'test-ucan' },
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

describe('OraclePlugin (class form)', () => {
  it('compiles and instantiates with the abstract identity fields', () => {
    class FooPlugin extends OraclePlugin {
      readonly name = 'foo';
      readonly version = '0.1.0';
      readonly manifest: PluginManifest = {
        title: 'Foo',
        summary: 'A test plugin',
        whenToUse: ['foo case'],
      };

      override getTools(): PluginTool[] {
        return [
          tool(async () => 'foo result', {
            name: 'foo_tool',
            description: 'A foo tool',
            schema: z.object({ value: z.string() }),
          }),
        ];
      }
    }

    const plugin = new FooPlugin();
    expect(plugin.name).toBe('foo');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.manifest.title).toBe('Foo');
    const tools = plugin.getTools(stubPluginContext());
    expect(Array.isArray(tools)).toBe(true);
    expect(tools[0]?.name).toBe('foo_tool');
  });
});

describe('defineOraclePlugin (POJO form)', () => {
  it('returns the same object typed as OraclePlugin with all fields preserved', () => {
    const sub = (): PluginTool[] => [];
    const plugin = defineOraclePlugin({
      name: 'pojo',
      version: '0.2.0',
      manifest: minimalManifest,
      dependsOn: ['core'],
      softDependsOn: ['memory'],
      getTools: sub,
      getSubAgents: () => [],
      getMiddlewares: () => [],
      getSharedState: () => ({}),
    });

    expect(plugin.name).toBe('pojo');
    expect(plugin.version).toBe('0.2.0');
    expect(plugin.manifest).toBe(minimalManifest);
    expect(plugin.dependsOn).toEqual(['core']);
    expect(plugin.softDependsOn).toEqual(['memory']);
    expect(plugin.getTools).toBe(sub);
    expect(plugin.getSubAgents).toBeDefined();
    expect(plugin.getMiddlewares).toBeDefined();
    expect(plugin.getSharedState).toBeDefined();
  });

  it('throws a descriptive error when `name` is missing', () => {
    expect(() =>
      defineOraclePlugin({
        version: '0.1.0',
        manifest: minimalManifest,
      } as unknown as Parameters<typeof defineOraclePlugin>[0]),
    ).toThrow(/name/);
  });

  it('throws a descriptive error when `version` is missing', () => {
    expect(() =>
      defineOraclePlugin({
        name: 'no-version',
        manifest: minimalManifest,
      } as unknown as Parameters<typeof defineOraclePlugin>[0]),
    ).toThrow(/version/);
  });

  it('throws a descriptive error when `manifest` is missing', () => {
    expect(() =>
      defineOraclePlugin({
        name: 'no-manifest',
        version: '0.1.0',
      } as unknown as Parameters<typeof defineOraclePlugin>[0]),
    ).toThrow(/manifest/);
  });
});

describe('tool() helper', () => {
  it('returns a PluginTool whose handler accepts (args, ctx: RuntimeContext)', async () => {
    const schema = z.object({ greeting: z.string() });
    const handler = async (
      args: unknown,
      ctx: RuntimeContext,
    ): Promise<string> => {
      const parsed = schema.parse(args);
      return `${parsed.greeting} ${ctx.user.did}`;
    };

    const t = tool(handler, {
      name: 'say_hello',
      description: 'Says hello to the current user.',
      schema,
    });

    expect(t.name).toBe('say_hello');
    expect(t.description).toBe('Says hello to the current user.');
    expect(t.schema).toBe(schema);
    expect(typeof t.handler).toBe('function');
    expect(t.visibility).toBeUndefined();

    const ctx = makeRuntimeContext();
    const result = await t.handler({ greeting: 'hi' }, ctx);
    expect(result).toBe('hi did:ixo:user1');
  });

  it('propagates `visibility: silent` onto the produced PluginTool', () => {
    const t = tool(async () => undefined, {
      name: 'silent_tool',
      description: 'A silent middleware-style tool.',
      schema: z.object({}),
      visibility: 'silent',
    });

    expect(t.visibility).toBe('silent');
  });
});

describe('class form and POJO form are interchangeable', () => {
  /**
   * Loader-shaped consumer: any function that accepts `OraclePlugin`. Both
   * the class form and the POJO form must satisfy this contract identically.
   */
  function consumePlugin(plugin: OraclePlugin): {
    name: string;
    version: string;
    title: string;
  } {
    return {
      name: plugin.name,
      version: plugin.version,
      title: plugin.manifest.title,
    };
  }

  it('accepts a class-extending plugin and a POJO-defined plugin uniformly', () => {
    class ClassPlugin extends OraclePlugin {
      readonly name = 'class-plugin';
      readonly version = '1.0.0';
      readonly manifest: PluginManifest = {
        title: 'Class',
        summary: 'class-form',
        whenToUse: ['class case'],
      };
    }

    const pojoPlugin = defineOraclePlugin({
      name: 'pojo-plugin',
      version: '1.0.0',
      manifest: {
        title: 'Pojo',
        summary: 'pojo-form',
        whenToUse: ['pojo case'],
      },
    });

    const fromClass = consumePlugin(new ClassPlugin());
    const fromPojo = consumePlugin(pojoPlugin);

    expect(fromClass).toEqual({
      name: 'class-plugin',
      version: '1.0.0',
      title: 'Class',
    });
    expect(fromPojo).toEqual({
      name: 'pojo-plugin',
      version: '1.0.0',
      title: 'Pojo',
    });
  });
});

describe('configSchema type narrowing', () => {
  it('narrows ctx.config when a plugin declares a configSchema', () => {
    const configSchema = z.object({ MY_VAR: z.string() });
    type MyConfig = z.infer<typeof configSchema>;

    class TypedPlugin extends OraclePlugin {
      readonly name = 'typed';
      readonly version = '0.1.0';
      readonly manifest: PluginManifest = {
        title: 'Typed',
        summary: 'typed config plugin',
        whenToUse: ['typed case'],
      };
      override readonly configSchema = configSchema;

      override getTools(ctx: PluginContext<MyConfig>): PluginTool[] {
        expectTypeOf(ctx.config.MY_VAR).toEqualTypeOf<string>();
        return [
          tool(
            async (_args, runCtx: RuntimeContext<MyConfig>) => {
              expectTypeOf(runCtx.config.MY_VAR).toEqualTypeOf<string>();
              return runCtx.config.MY_VAR;
            },
            {
              name: 'read_my_var',
              description: 'Returns MY_VAR from typed config.',
              schema: z.object({}),
            },
          ),
        ];
      }
    }

    const plugin = new TypedPlugin();
    expect(plugin.configSchema).toBe(configSchema);
    const tools = plugin.getTools(
      stubPluginContext<MyConfig>({ MY_VAR: 'hello' }),
    );
    expect(tools[0]?.name).toBe('read_my_var');
  });
});
