import { describe, expect, it } from 'vitest';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { makeBuildCtx } from '../registries/test-fixtures.js';
import { buildMetaTools } from './index.js';

describe('buildMetaTools', () => {
  it('returns the four meta-tools in a stable order', async () => {
    const manifestRegistry = new ManifestRegistry();
    const toolRegistry = new ToolRegistry();
    await toolRegistry.collect(makeBuildCtx());

    const metas = buildMetaTools({ manifestRegistry, toolRegistry });
    expect(metas.map((t) => t.name)).toEqual([
      'find_capability',
      'load_capability',
      'list_capabilities',
      'list_capability_details',
    ]);
  });
});
