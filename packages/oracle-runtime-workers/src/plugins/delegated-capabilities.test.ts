/**
 * A bundled plugin's `manifest.requires` must be what it proves through the
 * user's delegation: a requirement it never mints for would refuse users
 * for nothing, and a mint it does not require would hide the plugin's
 * absence behind an empty tool list instead of telling the user.
 */
import { describe, expect, it } from 'vitest';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../core/runtime-context';
import { makeRuntimeContext } from '../core/test-fixtures';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import { ComposioPlugin } from './composio';
import {
  MEMORY_CAPABILITY,
  SANDBOX_CAPABILITY,
} from './delegated-capabilities';
import { MemoryPlugin } from './memory';
import { SandboxPlugin } from './sandbox';
import { VfsPlugin } from './vfs';

const CONFIG = {
  MEMORY_MCP_URL: 'https://memory.example/mcp',
  MEMORY_ENGINE_URL: 'https://engine.example',
  SANDBOX_MCP_URL: 'https://sandbox.example/mcp',
  COMPOSIO_API_KEY: 'ck-test',
  COMPOSIO_BASE_URL: 'https://composio.example',
};

/** Every `{ resource, action }` the plugin claims when it builds its tools. */
async function claimsOf(
  plugin: OraclePlugin,
): Promise<Array<{ resource: string; action: string }>> {
  const claims: Array<{ resource: string; action: string }> = [];
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    resolveServiceDid: async (url) => `did:web:${new URL(url).host}`,
    mintInvocation: async (_userDid, target, opts) => {
      claims.push({ resource: target.capability, action: opts?.can ?? '*' });
      // Refused, so the plugin stops before connecting anywhere.
      throw new Error('no delegation in this test');
    },
  };
  const ctx = makeRuntimeContext({}, { ambient: { ucan, config: CONFIG } });
  expect(await plugin.getRequestTools?.(ctx)).toEqual([]);
  return claims;
}

describe('bundled plugin requirements', () => {
  it.each([
    ['memory', new MemoryPlugin(), MEMORY_CAPABILITY],
    ['sandbox', new SandboxPlugin(), SANDBOX_CAPABILITY],
    ['composio', new ComposioPlugin(), SANDBOX_CAPABILITY],
  ])(
    '%s requires exactly the capability its invocations claim',
    async (_name, plugin, capability) => {
      expect(plugin.manifest.requires).toEqual([capability]);
      expect(await claimsOf(plugin)).toContainEqual(capability);
    },
  );

  it('vfs requires nothing of the delegation to the oracle: it proves through its own ixo:filesystem delegation from the UCAN store', () => {
    expect(new VfsPlugin().manifest.requires).toBeUndefined();
  });
});
