import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OracleIdentity } from '../plugin-api/types.js';
import {
  makePlugin,
  makeSubAgent,
  makeTool,
} from '../registries/test-fixtures.js';
import { inspect, type CollectedRegistries } from './inspect.js';
import type { ResolvePluginsResult } from './plugin-loader.js';

const identity: OracleIdentity = {
  name: 'TestOracle',
  org: 'Acme',
  description: 'inspect test',
  entityDid: 'did:ixo:test',
};

const emptyCollected = (): CollectedRegistries => ({
  tools: [],
  subAgents: [],
  middlewares: [],
  manifests: [],
  configSchemas: [],
  sharedState: [],
});

describe('inspect()', () => {
  it('returns a JSON object with the expected envelope and shape', () => {
    const memory = makePlugin({ name: 'memory' });
    const sandbox = makePlugin({ name: 'sandbox' });
    const skills = makePlugin({ name: 'skills', dependsOn: ['sandbox'] });

    const resolved: ResolvePluginsResult = {
      loaded: [memory, sandbox, skills],
      excluded: [],
      softDepGaps: [],
    };

    const collected: CollectedRegistries = {
      ...emptyCollected(),
      tools: [
        { pluginName: 'memory', tool: makeTool('remember_fact') },
        {
          pluginName: 'skills',
          tool: makeTool('call_skill', { visibility: 'always' }),
        },
      ],
      subAgents: [
        {
          pluginName: 'memory',
          subAgent: makeSubAgent('call_memory_agent'),
        },
      ],
      configSchemas: [
        {
          pluginName: 'memory',
          schema: z.object({ MEMORY_MCP_URL: z.string() }),
        },
      ],
      sharedState: [
        {
          pluginName: 'memory',
          key: 'userProfile',
          accessor: () => ({}),
        },
      ],
    };

    const out = inspect({
      resolved,
      collected,
      identity,
      runtimeVersion: '1.2.3',
      bundledPluginNames: new Set(['memory', 'sandbox', 'skills']),
    });

    expect(out.schema).toBe('qiforge.boot.v1');
    expect(out.runtime.version).toBe('1.2.3');
    expect(out.runtime.node).toBe(process.version);
    expect(out.identity).toEqual(identity);
    expect(out.topo).toEqual(['memory', 'sandbox', 'skills']);
    expect(out.excluded).toEqual([]);
    expect(out.collisions).toEqual([]);
    expect(out.warnings).toEqual([]);

    const memoryEntry = out.plugins.find((p) => p.name === 'memory')!;
    expect(memoryEntry.source).toBe('bundled');
    expect(memoryEntry.tools.map((t) => t.name)).toEqual(['remember_fact']);
    expect(memoryEntry.subAgents.map((s) => s.name)).toEqual([
      'call_memory_agent',
    ]);
    expect(memoryEntry.configFields).toEqual(['MEMORY_MCP_URL']);
    expect(memoryEntry.stateFields).toEqual(['userProfile']);

    const skillsEntry = out.plugins.find((p) => p.name === 'skills')!;
    expect(skillsEntry.dependsOn).toEqual(['sandbox']);
    expect(skillsEntry.tools[0]?.visibility).toBe('always');
  });

  it('orders the topo field consistently with resolved.loaded', () => {
    const a = makePlugin({ name: 'a' });
    const b = makePlugin({ name: 'b' });
    const c = makePlugin({ name: 'c' });
    const resolved: ResolvePluginsResult = {
      loaded: [a, b, c],
      excluded: [],
      softDepGaps: [],
    };
    const out = inspect({
      resolved,
      collected: emptyCollected(),
      identity,
      runtimeVersion: '1.0.0',
    });
    expect(out.topo).toEqual(['a', 'b', 'c']);
  });

  it('marks fork-authored plugins as source: "user"', () => {
    const userPlug = makePlugin({ name: 'climate' });
    const out = inspect({
      resolved: {
        loaded: [userPlug],
        excluded: [],
        softDepGaps: [],
      },
      collected: emptyCollected(),
      identity,
      runtimeVersion: '1.0.0',
      bundledPluginNames: new Set<string>(),
    });
    expect(out.plugins[0]?.source).toBe('user');
  });

  it('populates softDepsMissing and softDepsResolved', () => {
    const tasks = makePlugin({
      name: 'tasks',
      softDependsOn: ['memory', 'sandbox'],
    });
    const memory = makePlugin({ name: 'memory' });
    const out = inspect({
      resolved: {
        loaded: [memory, tasks],
        excluded: [],
        softDepGaps: [{ plugin: 'tasks', missing: 'sandbox' }],
      },
      collected: emptyCollected(),
      identity,
      runtimeVersion: '1.0.0',
    });
    const tasksEntry = out.plugins.find((p) => p.name === 'tasks')!;
    expect(tasksEntry.softDepsResolved).toEqual(['memory']);
    expect(tasksEntry.softDepsMissing).toEqual(['sandbox']);
  });

  it('detects tool / sub-agent / shared-state collisions', () => {
    const a = makePlugin({ name: 'a' });
    const b = makePlugin({ name: 'b' });
    const out = inspect({
      resolved: {
        loaded: [a, b],
        excluded: [],
        softDepGaps: [],
      },
      collected: {
        ...emptyCollected(),
        tools: [
          { pluginName: 'a', tool: makeTool('t') },
          { pluginName: 'b', tool: makeTool('t') },
        ],
        subAgents: [
          { pluginName: 'a', subAgent: makeSubAgent('s') },
          { pluginName: 'b', subAgent: makeSubAgent('s') },
        ],
        sharedState: [
          { pluginName: 'a', key: 'k', accessor: () => 1 },
          { pluginName: 'b', key: 'k', accessor: () => 2 },
        ],
      },
      identity,
      runtimeVersion: '1.0.0',
    });
    expect(out.collisions.some((c) => c.includes("tool 't'"))).toBe(true);
    expect(out.collisions.some((c) => c.includes("sub-agent 's'"))).toBe(
      true,
    );
    expect(out.collisions.some((c) => c.includes("shared-state key 'k'"))).toBe(
      true,
    );
  });

  it('forwards the supplied warnings list', () => {
    const out = inspect({
      resolved: { loaded: [], excluded: [], softDepGaps: [] },
      collected: emptyCollected(),
      identity,
      runtimeVersion: '1.0.0',
      warnings: ['env key X redefined'],
    });
    expect(out.warnings).toEqual(['env key X redefined']);
  });

  it('forwards the excluded list from the loader result', () => {
    const out = inspect({
      resolved: {
        loaded: [],
        excluded: [{ plugin: 'slack', reason: 'auto-detect' }],
        softDepGaps: [],
      },
      collected: emptyCollected(),
      identity,
      runtimeVersion: '1.0.0',
    });
    expect(out.excluded).toEqual([
      { plugin: 'slack', reason: 'auto-detect' },
    ]);
  });
});
