import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import {
  makeManifest,
  makePlugin,
  makeRuntimeContext,
} from '../registries/test-fixtures.js';
import { buildFindCapabilityTool } from './find-capability.js';

interface FindHit {
  name: string;
  score: number;
  summary: string;
  matchReason: string;
}

function newRegistryWithStandardPlugins(): ManifestRegistry {
  const reg = new ManifestRegistry();
  reg.register(
    makePlugin({
      name: 'tasksPlugin',
      manifest: makeManifest({
        title: 'Tasks',
        summary: 'Reminders, todos, and follow-ups for the user.',
        whenToUse: [
          'User asks to remind them later.',
          'User wants to add a todo or follow-up.',
        ],
        tags: ['reminders', 'tasks', 'todos'],
        visibility: 'on-demand',
      }),
    }),
  );
  reg.register(
    makePlugin({
      name: 'memory',
      manifest: makeManifest({
        title: 'Memory',
        summary: 'Persistent memory for users and conversations.',
        whenToUse: ['Recall something the user mentioned earlier.'],
        tags: ['memory', 'recall'],
        visibility: 'always',
      }),
    }),
  );
  reg.register(
    makePlugin({
      name: 'slack',
      manifest: makeManifest({
        title: 'Slack',
        summary: 'Send messages to Slack channels and DMs.',
        whenToUse: ['User wants to post a message in slack.'],
        tags: ['slack', 'messaging'],
        visibility: 'on-demand',
      }),
    }),
  );
  return reg;
}

describe('find_capability', () => {
  it('declares its name, description, and schema', () => {
    const tool = buildFindCapabilityTool(new ManifestRegistry());
    expect(tool.name).toBe('find_capability');
    expect(tool.description).toMatch(/search/i);
    expect(tool.schema).toBeInstanceOf(z.ZodObject);
  });

  it('ranks the tasks plugin first for "remind me" intent', async () => {
    const tool = buildFindCapabilityTool(newRegistryWithStandardPlugins());
    const hits = (await tool.handler(
      { query: 'remind me to call mom tomorrow', limit: 5 },
      makeRuntimeContext(),
    )) as FindHit[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.name).toBe('tasksPlugin');
    expect(hits[0]?.matchReason).toMatch(/matched:/);
  });

  it('returns an empty array for queries with no matches', async () => {
    const tool = buildFindCapabilityTool(newRegistryWithStandardPlugins());
    const hits = (await tool.handler(
      { query: 'xyzzy_no_such_capability', limit: 5 },
      makeRuntimeContext(),
    )) as FindHit[];
    expect(hits).toEqual([]);
  });

  it('honors the limit argument', async () => {
    const tool = buildFindCapabilityTool(newRegistryWithStandardPlugins());
    const hits = (await tool.handler(
      { query: 'message memory tasks slack', limit: 1 },
      makeRuntimeContext(),
    )) as FindHit[];
    expect(hits).toHaveLength(1);
  });

  it('applies the default limit of 5 when omitted', async () => {
    const reg = new ManifestRegistry();
    for (let i = 0; i < 8; i++) {
      reg.register(
        makePlugin({
          name: `p${i}`,
          manifest: makeManifest({
            summary: `plugin ${i} for messaging tests`,
            whenToUse: ['user wants to send a message'],
            tags: ['messaging'],
            visibility: 'on-demand',
          }),
        }),
      );
    }
    const tool = buildFindCapabilityTool(reg);
    const hits = (await tool.handler(
      { query: 'messaging' },
      makeRuntimeContext(),
    )) as FindHit[];
    expect(hits.length).toBeLessThanOrEqual(5);
  });
});
