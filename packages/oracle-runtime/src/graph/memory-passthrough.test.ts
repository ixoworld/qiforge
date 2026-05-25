import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type * as Langchain from 'langchain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
} from '../registries/index.js';
import {
  makeManifest,
  makePlugin,
  makeSubAgent,
  makeTool,
} from '../registries/test-fixtures.js';
import type { AmbientServices } from '../runtime-context/ambient.js';

// langchain's createAgent stub: every call returns a fake compiled agent that
// returns an empty messages array on .invoke(). The main-agent build does not
// blow up, AND when the wrapped sub-agent tool is invoked downstream we can
// observe the inner createAgent's tool list to verify passthrough plumbing.
type CreateAgentArgs = Parameters<typeof Langchain.createAgent>[0];

const createAgentCalls: CreateAgentArgs[] = [];
const fakeCompiledAgent = {
  invoke: vi.fn(
    async (): Promise<{ messages: BaseMessage[] }> => ({
      messages: [new AIMessage('done')],
    }),
  ),
  stream: vi.fn(),
};

vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof Langchain>('langchain');
  return {
    ...actual,
    createAgent: vi.fn((args: CreateAgentArgs) => {
      createAgentCalls.push(args);
      return fakeCompiledAgent;
    }),
    toolRetryMiddleware: vi.fn(() => ({ name: 'ToolRetryMiddleware' })),
  };
});

import { createMainAgent, type MainAgentArgs } from './main-agent.js';

function makeAmbient(): AmbientServices {
  return {
    config: {},
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'desc',
      entityDid: 'did:ixo:test',
    },
    availablePlugins: new Set(),
    secrets: {
      getIndex: vi.fn(async () => ({})),
      getValues: vi.fn(async () => ({})),
    },
    matrix: {
      postToRoom: vi.fn(async () => 'event-id'),
      getRoomState: vi.fn(async (roomId: string) => ({ roomId, state: [] })),
      getEventById: vi.fn(async (_roomId: string, eventId: string) => ({
        eventId,
        type: 'm.room.message',
        content: {},
      })),
    },
    llm: {
      get: vi.fn(
        () =>
          ({ invoke: vi.fn() }) as unknown as ReturnType<
            AmbientServices['llm']['get']
          >,
      ),
    },
    emit: { emit: vi.fn() },
    ucan: {
      hasCapability: vi.fn(() => true),
      requireCapability: vi.fn(),
      mintInvocation: vi.fn(async () => 'inv'),
      resolveServiceDid: vi.fn(async () => 'did:web:example.com'),
      hasSigningKey: vi.fn(() => true),
      createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'mock-invocation-car' })),
    },
    logger: {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      child: vi.fn(function (this: unknown) {
        return this;
      }) as never,
    },
  };
}

function emptyRegistries(): MainAgentArgs['registries'] {
  return {
    tools: new ToolRegistry(),
    subAgents: new SubAgentRegistry(),
    middlewares: new MiddlewareRegistry(),
    manifests: new ManifestRegistry(),
    configSchema: new ConfigSchemaRegistry(),
    sharedState: new SharedStateRegistry(),
  };
}

function baseArgs(overrides: Partial<MainAgentArgs> = {}): MainAgentArgs {
  return {
    registries: overrides.registries ?? emptyRegistries(),
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'a test oracle',
      entityDid: 'did:ixo:test',
    },
    config: {},
    requestCtx: {
      user: {
        did: 'did:ixo:user1',
        matrixUserId: '@did-ixo-user1:ixo.world',
        ucanDelegation: { raw: 'test-ucan' },
      },
      session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
      history: { userContext: undefined },
    },
    ambient: overrides.ambient ?? makeAmbient(),
    state: {},
    availablePlugins: new Set(),
    ...overrides,
  };
}

/** Helper: build registries with optional memory plugin + 1 sub-agent. */
function registriesWith({
  includeMemory,
}: {
  includeMemory: boolean;
}): MainAgentArgs['registries'] {
  const registries = emptyRegistries();

  if (includeMemory) {
    const memoryPlugin = makePlugin({
      name: 'memory',
      manifest: makeManifest({ visibility: 'always', title: 'Memory' }),
      getTools: () => [
        makeTool('memory-engine__search_memory_engine', {
          schema: z.object({ q: z.string() }),
        }),
        makeTool('memory-engine__add_memory', {
          schema: z.object({ c: z.string() }),
        }),
        makeTool('memory-engine__delete_episode', {
          schema: z.object({ id: z.string() }),
        }),
        makeTool('memory-engine__clear', {
          schema: z.object({ confirm: z.boolean() }),
        }),
      ],
    });
    registries.tools.register(memoryPlugin);
    registries.manifests.register(memoryPlugin);
  }

  const subAgentPlugin = makePlugin({
    name: 'search-plugin',
    manifest: makeManifest({ visibility: 'silent' }),
    getSubAgents: () => [
      makeSubAgent('search_agent', {
        tools: [makeTool('do_search', { schema: z.object({ q: z.string() }) })],
      }),
    ],
  });
  registries.subAgents.register(subAgentPlugin);
  registries.manifests.register(subAgentPlugin);

  return registries;
}

/** Convenience: find the wrapped sub-agent tool registered with the main agent. */
function findSubAgentTool(name: string) {
  const mainTools = (createAgentCalls[0]?.tools ?? []) as Array<{
    name: string;
    invoke?: (...args: unknown[]) => Promise<unknown>;
  }>;
  const t = mainTools.find((tool) => tool.name === name);
  if (!t) {
    throw new Error(
      `Sub-agent tool "${name}" not found. Got: ${mainTools.map((x) => x.name).join(', ')}`,
    );
  }
  return t;
}

describe('memory passthrough wiring', () => {
  beforeEach(() => {
    createAgentCalls.length = 0;
    fakeCompiledAgent.invoke.mockClear();
    fakeCompiledAgent.stream.mockReset();
  });

  it('forwards the non-destructive memory tools to every sub-agent (visible in inner agent tool list)', async () => {
    await createMainAgent(
      baseArgs({ registries: registriesWith({ includeMemory: true }) }),
    );

    // Invoke the wrapped sub-agent tool — that triggers the inner createAgent
    // call inside `createSubagentAsTool`, whose `tools` field is the inner
    // agent's tool list (own + passthrough concatenated).
    const subTool = findSubAgentTool('call_search_agent');
    await subTool.invoke?.(
      { task: 'find stuff' },
      {
        configurable: { thread_id: 'parent' },
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@did-ixo-user1:ixo.world',
            ucanDelegation: { raw: 'test', capabilities: [] },
          },
          session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
        },
      },
    );

    const innerCall = createAgentCalls[1];
    expect(innerCall).toBeDefined();
    const innerToolNames = (innerCall!.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    // Sub-agent's own tool first, then the memory passthroughs
    // (everything except the destructive `memory-engine__clear`).
    expect(innerToolNames).toEqual([
      'do_search',
      'memory-engine__search_memory_engine',
      'memory-engine__add_memory',
      'memory-engine__delete_episode',
    ]);
  });

  it('never gives sub-agents `memory-engine__clear` but DOES bind it on the main agent', async () => {
    await createMainAgent(
      baseArgs({ registries: registriesWith({ includeMemory: true }) }),
    );

    const mainNames = (
      createAgentCalls[0]!.tools as Array<{ name: string }>
    ).map((t) => t.name);
    expect(mainNames).toContain('memory-engine__clear');

    const subTool = findSubAgentTool('call_search_agent');
    await subTool.invoke?.(
      { task: 'find stuff' },
      {
        configurable: { thread_id: 'parent' },
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@did-ixo-user1:ixo.world',
            ucanDelegation: { raw: 'test', capabilities: [] },
          },
          session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
        },
      },
    );

    const innerToolNames = (
      createAgentCalls[1]!.tools as Array<{ name: string }>
    ).map((t) => t.name);
    expect(innerToolNames).not.toContain('memory-engine__clear');
  });

  it('gives sub-agents only their own tools when the memory plugin is not loaded', async () => {
    await createMainAgent(
      baseArgs({ registries: registriesWith({ includeMemory: false }) }),
    );

    const subTool = findSubAgentTool('call_search_agent');
    await subTool.invoke?.(
      { task: 'find stuff' },
      {
        configurable: { thread_id: 'parent' },
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@did-ixo-user1:ixo.world',
            ucanDelegation: { raw: 'test', capabilities: [] },
          },
          session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
        },
      },
    );

    const innerToolNames = (
      createAgentCalls[1]!.tools as Array<{ name: string }>
    ).map((t) => t.name);
    expect(innerToolNames).toEqual(['do_search']);
  });
});
