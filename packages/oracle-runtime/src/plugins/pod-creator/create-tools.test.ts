import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { InMemoryBlueprintStore } from './blueprint-store.js';
import type { ChainGateway } from './chain-gateway.js';
import { createCreateTools } from './create-tools.js';
import { DESIGN_POD_ROLES } from './design-pod-roles.js';

const ISO = '2026-06-12T00:00:00.000Z';

function byName(tools: PluginTool[], name: string): PluginTool {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`tool ${name} not found`);
  }
  return found;
}

function mockGateway(over: Partial<ChainGateway> = {}): ChainGateway {
  return {
    prepareUnsignedPodBatch: async () => ({
      unsignedTx: 'BASE64',
      summary: 'Creates POD X',
      messageCount: 3,
    }),
    confirmPodCreation: async () => ({
      podDid: 'did:ixo:entity:pod123',
      summary: 'POD live',
    }),
    ...over,
  };
}

/** Seed every role with a passing section so the launch gate is satisfied. */
async function seedComplete(
  store: InMemoryBlueprintStore,
  thread: string,
): Promise<void> {
  for (const role of DESIGN_POD_ROLES) {
    await store.putSection(thread, {
      role: role.id,
      stage: role.stage,
      content: {},
      recordedAt: ISO,
      verdict: 'pass',
    });
  }
}

describe('create-path tools', () => {
  it('prepare_pod_transaction refuses until the launch-readiness gate passes', async () => {
    const store = new InMemoryBlueprintStore();
    await store.putSection('session-1', {
      role: 'service_intent_scorer',
      stage: 'qualify',
      content: {},
      recordedAt: ISO,
      verdict: 'pass',
    });
    const tools = createCreateTools(store, mockGateway());
    const out = z
      .object({
        prepared: z.boolean(),
        blockers: z.array(z.string()).optional(),
      })
      .parse(
        await byName(tools, 'prepare_pod_transaction').handler(
          {},
          makeRuntimeContext(),
        ),
      );
    expect(out.prepared).toBe(false);
    expect((out.blockers ?? []).length).toBeGreaterThan(0);
  });

  it('prepare_pod_transaction builds the unsigned batch once the gate passes', async () => {
    const store = new InMemoryBlueprintStore();
    await seedComplete(store, 'session-1');
    const prepareSpy = vi.fn(async () => ({
      unsignedTx: 'BASE64',
      summary: 'Creates POD X',
      messageCount: 3,
    }));
    const tools = createCreateTools(
      store,
      mockGateway({ prepareUnsignedPodBatch: prepareSpy }),
    );
    const out = z
      .object({
        prepared: z.boolean(),
        blobId: z.string().optional(),
        messageCount: z.number().optional(),
      })
      .parse(
        await byName(tools, 'prepare_pod_transaction').handler(
          {},
          makeRuntimeContext(),
        ),
      );
    expect(out.prepared).toBe(true);
    expect(out.messageCount).toBe(3);
    expect(out.blobId).toBe('blob_0000000000000000');
    expect(prepareSpy).toHaveBeenCalledOnce();
  });

  it('request_pod_signature emits sign_transaction for a stored batch', async () => {
    const store = new InMemoryBlueprintStore();
    const tools = createCreateTools(store, mockGateway());
    const actionCall = vi.fn();
    const ctx: RuntimeContext = makeRuntimeContext({
      blobStore: {
        put: async () => 'blob_00000000000000ab',
        get: async () => ({ name: 'pod-unsigned-tx', value: 'BASE64' }),
        isValidBlobId: (v): v is string =>
          typeof v === 'string' && /^blob_[0-9a-f]{16}$/.test(v),
      },
      emit: {
        toolCall: () => undefined,
        actionCall,
        renderComponent: () => undefined,
        reasoning: () => undefined,
        browserToolCall: () => undefined,
        router: () => undefined,
        messageCacheInvalidation: () => undefined,
      },
    });

    const out = z
      .object({ requested: z.boolean() })
      .parse(
        await byName(tools, 'request_pod_signature').handler(
          { blobId: 'blob_00000000000000ab' },
          ctx,
        ),
      );
    expect(out.requested).toBe(true);
    expect(actionCall).toHaveBeenCalledOnce();
    const payload = z
      .object({ toolName: z.string() })
      .parse(actionCall.mock.calls[0]?.[0]);
    expect(payload.toolName).toBe('sign_transaction');
  });

  it('request_pod_signature rejects a missing or expired batch', async () => {
    const store = new InMemoryBlueprintStore();
    const tools = createCreateTools(store, mockGateway());
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: 'blob_0000000000000000' },
        makeRuntimeContext(),
      ),
    ).rejects.toThrow(/not found|expired/);
  });

  it('confirm_pod_creation resolves the POD DID from the gateway', async () => {
    const store = new InMemoryBlueprintStore();
    const confirmSpy = vi.fn(async () => ({
      podDid: 'did:ixo:entity:pod123',
      summary: 'POD live',
    }));
    const tools = createCreateTools(
      store,
      mockGateway({ confirmPodCreation: confirmSpy }),
    );
    const out = z
      .object({ created: z.boolean(), podDid: z.string() })
      .parse(
        await byName(tools, 'confirm_pod_creation').handler(
          { txHash: '0xabc' },
          makeRuntimeContext(),
        ),
      );
    expect(out.created).toBe(true);
    expect(out.podDid).toBe('did:ixo:entity:pod123');
    expect(confirmSpy).toHaveBeenCalledWith(
      { txHash: '0xabc', network: 'testnet' },
      expect.anything(),
    );
  });
});
