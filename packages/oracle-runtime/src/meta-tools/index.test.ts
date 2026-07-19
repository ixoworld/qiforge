import { describe, expect, it } from 'vitest';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { makeBuildCtx } from '../registries/test-fixtures.js';
import { buildMetaTools } from './index.js';

describe('buildMetaTools', () => {
  it('returns the two meta-tools in a stable order', async () => {
    const manifestRegistry = new ManifestRegistry();
    const toolRegistry = new ToolRegistry();
    const collectedTools = await toolRegistry.collect(makeBuildCtx());

    const metas = buildMetaTools({ manifestRegistry, collectedTools });
    expect(metas.map((t) => t.name)).toEqual([
      'load_capability',
      'list_capabilities',
    ]);
  });
});
