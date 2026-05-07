import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeRuntimeContext,
  makeTool,
} from '../registries/test-fixtures.js';
import {
  buildListCapabilityDetailsTool,
  summarizeSchema,
} from './list-capability-details.js';
import type { PluginManifest } from '../plugin-api/types.js';

interface Detail extends PluginManifest {
  tools: { name: string; description: string; schemaSummary: string }[];
}

async function buildRegistries(): Promise<{
  manifests: ManifestRegistry;
  tools: ToolRegistry;
}> {
  const manifests = new ManifestRegistry();
  const tools = new ToolRegistry();

  const climate = makePlugin({
    name: 'climate',
    manifest: makeManifest({
      title: 'Climate',
      summary: 'Facility emissions and carbon footprint analysis.',
      whenToUse: ['User asks about emissions.'],
      tags: ['climate', 'emissions'],
      category: 'data',
      visibility: 'on-demand',
      examples: [{ user: 'Q1 emissions?', tool: 'get_emissions' }],
    }),
    getTools: () => [
      makeTool('get_emissions', {
        description: 'Get emissions for a facility.',
        schema: z.object({
          facilityId: z.string(),
          year: z.number().int().optional(),
        }),
      }),
      makeTool('compare_emissions', {
        description: 'Compare emissions across facilities.',
        schema: z.object({
          facilityIds: z.array(z.string()),
          year: z.number().int(),
        }),
      }),
    ],
  });

  manifests.register(climate);
  tools.register(climate);
  await tools.collect(makeBuildCtx());

  return { manifests, tools };
}

describe('list_capability_details', () => {
  it('declares its name and schema', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildListCapabilityDetailsTool(manifests, tools);
    expect(tool.name).toBe('list_capability_details');
  });

  it('returns the manifest plus the plugin tool list', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildListCapabilityDetailsTool(manifests, tools);

    const result = (await tool.handler(
      { name: 'climate' },
      makeRuntimeContext(),
    )) as Detail;

    expect(result.title).toBe('Climate');
    expect(result.summary).toMatch(/emissions/);
    expect(result.examples?.[0]?.tool).toBe('get_emissions');
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      'compare_emissions',
      'get_emissions',
    ]);
    const getEmissions = result.tools.find((t) => t.name === 'get_emissions');
    expect(getEmissions?.description).toBe('Get emissions for a facility.');
    expect(getEmissions?.schemaSummary).toContain('facilityId: string');
    expect(getEmissions?.schemaSummary).toContain('year?: number');
  });

  it('throws when the plugin name is unknown', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildListCapabilityDetailsTool(manifests, tools);

    await expect(
      tool.handler({ name: 'nope' }, makeRuntimeContext()),
    ).rejects.toThrow(/list_capabilities|does not exist/);
  });
});

describe('summarizeSchema', () => {
  it('renders a flat object schema with type tags', () => {
    const s = z.object({
      name: z.string(),
      age: z.number().int(),
    });
    expect(summarizeSchema(s)).toBe('{ name: string, age: number }');
  });

  it('marks optional and nullable fields with a trailing ?', () => {
    const s = z.object({
      name: z.string(),
      bio: z.string().optional(),
      avatar: z.string().nullable(),
    });
    const out = summarizeSchema(s);
    expect(out).toContain('name: string');
    expect(out).toContain('bio?: string');
    expect(out).toContain('avatar?: string');
  });

  it('unwraps default-wrapped fields without marking them optional', () => {
    const s = z.object({
      limit: z.number().default(5),
    });
    expect(summarizeSchema(s)).toBe('{ limit: number }');
  });

  it('returns just the type tag for a non-object schema', () => {
    expect(summarizeSchema(z.string())).toBe('string');
    expect(summarizeSchema(z.array(z.number()))).toBe('array');
  });
});
