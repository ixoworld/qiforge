import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { InMemoryBlueprintStore } from './blueprint-store.js';
import {
  notConfiguredChainGateway,
  type ChainGateway,
} from './chain-gateway.js';
import {
  InMemoryCreateSessionStore,
  type CreateSessionStore,
} from './create-session-store.js';
import { createCreateTools } from './create-tools.js';
import { DESIGN_POD_ROLES } from './design-pod-roles.js';

const { callAgActionMock } = vi.hoisted(() => ({
  callAgActionMock: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@ixo/common', () => ({ callAgAction: callAgActionMock }));

const ISO = '2026-06-12T00:00:00.000Z';
const BLOB = 'blob_00000000000000ab';
const USER = 'did:ixo:user1';
const THREAD = 'session-1';
const TX_HASH =
  'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2';

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

/** A ctx whose blob store returns a stored batch. */
function ctxWithStoredBlob(): RuntimeContext {
  return makeRuntimeContext({
    blobStore: {
      put: async () => BLOB,
      get: async () => ({ name: 'pod-unsigned-tx', value: 'BASE64' }),
      isValidBlobId: (v): v is string =>
        typeof v === 'string' && /^blob_[0-9a-f]{16}$/.test(v),
    },
  });
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

function makeTools(
  over: {
    gateway?: ChainGateway;
    blueprint?: InMemoryBlueprintStore;
    sessions?: CreateSessionStore;
  } = {},
): {
  tools: PluginTool[];
  blueprint: InMemoryBlueprintStore;
  sessions: CreateSessionStore;
} {
  const blueprint = over.blueprint ?? new InMemoryBlueprintStore();
  const sessions = over.sessions ?? new InMemoryCreateSessionStore();
  const tools = createCreateTools(
    blueprint,
    over.gateway ?? mockGateway(),
    sessions,
  );
  return { tools, blueprint, sessions };
}

beforeEach(() => {
  callAgActionMock.mockReset();
});

describe('create-path tools', () => {
  it('prepare_pod_transaction refuses until the launch-readiness gate passes', async () => {
    const blueprint = new InMemoryBlueprintStore();
    await blueprint.putSection(THREAD, {
      role: 'service_intent_scorer',
      stage: 'qualify',
      content: {},
      recordedAt: ISO,
      verdict: 'pass',
    });
    const { tools } = makeTools({ blueprint });
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
    const blueprint = new InMemoryBlueprintStore();
    await seedComplete(blueprint, THREAD);
    const prepareSpy = vi.fn(async () => ({
      unsignedTx: 'BASE64',
      summary: 'Creates POD X',
      messageCount: 3,
    }));
    const { tools } = makeTools({
      blueprint,
      gateway: mockGateway({ prepareUnsignedPodBatch: prepareSpy }),
    });
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

  it('prepare_pod_transaction refuses mainnet without the operator opt-in', async () => {
    const blueprint = new InMemoryBlueprintStore();
    await seedComplete(blueprint, THREAD);
    const prepareSpy = vi.fn(async () => ({
      unsignedTx: 'BASE64',
      summary: 'Creates POD X',
      messageCount: 3,
    }));
    const { tools } = makeTools({
      blueprint,
      gateway: mockGateway({ prepareUnsignedPodBatch: prepareSpy }),
    });
    const out = z
      .object({ prepared: z.boolean(), message: z.string() })
      .parse(
        await byName(tools, 'prepare_pod_transaction').handler(
          {},
          makeRuntimeContext({ config: { NETWORK: 'mainnet' } }),
        ),
      );
    expect(out.prepared).toBe(false);
    expect(out.message).toMatch(/mainnet/i);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('prepare_pod_transaction allows mainnet when the operator opted in', async () => {
    const blueprint = new InMemoryBlueprintStore();
    await seedComplete(blueprint, THREAD);
    const { tools } = makeTools({ blueprint });
    const out = z.object({ prepared: z.boolean() }).parse(
      await byName(tools, 'prepare_pod_transaction').handler(
        {},
        makeRuntimeContext({
          config: { NETWORK: 'mainnet', POD_CREATOR_ALLOW_MAINNET: true },
        }),
      ),
    );
    expect(out.prepared).toBe(true);
  });

  it('prepare and confirm report unavailability on the not-configured gateway instead of throwing', async () => {
    const blueprint = new InMemoryBlueprintStore();
    await seedComplete(blueprint, THREAD);
    const { tools } = makeTools({
      blueprint,
      gateway: notConfiguredChainGateway,
    });
    const prepared = z
      .object({ prepared: z.boolean(), message: z.string() })
      .parse(
        await byName(tools, 'prepare_pod_transaction').handler(
          {},
          makeRuntimeContext(),
        ),
      );
    expect(prepared.prepared).toBe(false);
    expect(prepared.message).toMatch(/not yet enabled/i);
    const confirmed = z
      .object({ created: z.boolean(), message: z.string() })
      .parse(
        await byName(tools, 'confirm_pod_creation').handler(
          { txHash: TX_HASH },
          makeRuntimeContext(),
        ),
      );
    expect(confirmed.created).toBe(false);
  });

  it('request_pod_signature runs the sign round-trip and returns the txHash', async () => {
    const { tools, sessions } = makeTools();
    await sessions.prepared(USER, THREAD, BLOB);
    callAgActionMock.mockResolvedValueOnce({ txHash: TX_HASH });
    const ctx = ctxWithStoredBlob();

    const approved = z
      .object({ approved: z.boolean() })
      .parse(
        await byName(tools, 'approve_pod_transaction').handler(
          { blobId: BLOB },
          ctx,
        ),
      );
    expect(approved.approved).toBe(true);

    const out = z
      .object({ requested: z.boolean(), txHash: z.string().nullable() })
      .parse(
        await byName(tools, 'request_pod_signature').handler(
          { blobId: BLOB },
          ctx,
        ),
      );
    expect(out.requested).toBe(true);
    expect(out.txHash).toBe(TX_HASH);
    expect(callAgActionMock).toHaveBeenCalledOnce();
    const dispatch = z
      .object({
        toolName: z.string(),
        args: z.object({
          blobId: z.string(),
          unsignedTx: z.string(),
          network: z.string(),
        }),
      })
      .parse(callAgActionMock.mock.calls[0]?.[0]);
    expect(dispatch.toolName).toBe('sign_transaction');
    expect(dispatch.args.unsignedTx).toBe('BASE64');
    expect(dispatch.args.network).toBe('testnet');
  });

  it('request_pod_signature cannot be replayed — the approval is spent on dispatch', async () => {
    const { tools, sessions } = makeTools();
    await sessions.prepared(USER, THREAD, BLOB);
    callAgActionMock.mockResolvedValue({ txHash: TX_HASH });
    const ctx = ctxWithStoredBlob();

    await byName(tools, 'approve_pod_transaction').handler(
      { blobId: BLOB },
      ctx,
    );
    await byName(tools, 'request_pod_signature').handler({ blobId: BLOB }, ctx);
    await expect(
      byName(tools, 'request_pod_signature').handler({ blobId: BLOB }, ctx),
    ).rejects.toThrow(/not approved|already used/i);

    // A fresh explicit approval re-arms exactly one more dispatch.
    await byName(tools, 'approve_pod_transaction').handler(
      { blobId: BLOB },
      ctx,
    );
    const again = z
      .object({ requested: z.boolean() })
      .parse(
        await byName(tools, 'request_pod_signature').handler(
          { blobId: BLOB },
          ctx,
        ),
      );
    expect(again.requested).toBe(true);
    expect(callAgActionMock).toHaveBeenCalledTimes(2);
  });

  it('the approval is spent even when the wallet round-trip fails', async () => {
    const { tools, sessions } = makeTools();
    await sessions.prepared(USER, THREAD, BLOB);
    callAgActionMock.mockRejectedValueOnce(new Error('Timeout'));
    const ctx = ctxWithStoredBlob();

    await byName(tools, 'approve_pod_transaction').handler(
      { blobId: BLOB },
      ctx,
    );
    const out = z
      .object({
        requested: z.boolean(),
        txHash: z.string().nullable(),
        message: z.string(),
      })
      .parse(
        await byName(tools, 'request_pod_signature').handler(
          { blobId: BLOB },
          ctx,
        ),
      );
    expect(out.txHash).toBeNull();
    expect(out.message).toMatch(/did not complete/i);
    await expect(
      byName(tools, 'request_pod_signature').handler({ blobId: BLOB }, ctx),
    ).rejects.toThrow(/not approved|already used/i);
  });

  it('approve_pod_transaction refuses a batch not prepared in this conversation', async () => {
    const { tools, sessions } = makeTools();
    await sessions.prepared(USER, 'some-other-thread', BLOB);
    const out = z
      .object({ approved: z.boolean(), message: z.string() })
      .parse(
        await byName(tools, 'approve_pod_transaction').handler(
          { blobId: BLOB },
          ctxWithStoredBlob(),
        ),
      );
    expect(out.approved).toBe(false);
    expect(out.message).toMatch(/not the batch prepared/i);
  });

  it('request_pod_signature refuses a batch that has not been approved', async () => {
    const { tools, sessions } = makeTools();
    await sessions.prepared(USER, THREAD, BLOB);
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: BLOB },
        ctxWithStoredBlob(),
      ),
    ).rejects.toThrow(/not approved/i);
    expect(callAgActionMock).not.toHaveBeenCalled();
  });

  it('request_pod_signature rejects a missing or expired batch', async () => {
    const { tools } = makeTools();
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: 'blob_0000000000000000' },
        makeRuntimeContext(),
      ),
    ).rejects.toThrow(/not found|expired/);
  });

  it('confirm_pod_creation resolves the POD DID and closes the session', async () => {
    const confirmSpy = vi.fn(async () => ({
      podDid: 'did:ixo:entity:pod123',
      summary: 'POD live',
    }));
    const { tools, sessions } = makeTools({
      gateway: mockGateway({ confirmPodCreation: confirmSpy }),
    });
    await sessions.prepared(USER, THREAD, BLOB);
    await sessions.approve(USER, THREAD, BLOB);
    const out = z
      .object({ created: z.boolean(), podDid: z.string() })
      .parse(
        await byName(tools, 'confirm_pod_creation').handler(
          { txHash: TX_HASH },
          makeRuntimeContext(),
        ),
      );
    expect(out.created).toBe(true);
    expect(out.podDid).toBe('did:ixo:entity:pod123');
    expect(confirmSpy).toHaveBeenCalledWith(
      { txHash: TX_HASH, network: 'testnet' },
      expect.anything(),
    );
    expect(await sessions.consume(USER, THREAD, BLOB)).toBe(false);
  });

  it('confirm_pod_creation rejects a malformed transaction hash', async () => {
    const { tools } = makeTools();
    await expect(
      byName(tools, 'confirm_pod_creation').handler(
        { txHash: '0xabc' },
        makeRuntimeContext(),
      ),
    ).rejects.toThrow(/64-character hex/);
  });
});
