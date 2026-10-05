import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMemoryBlobStore } from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  FrontendCallParams,
  FrontendCallSurface,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { KvBlueprintStore } from './blueprint-store';
import { notConfiguredChainGateway, type ChainGateway } from './chain-gateway';
import {
  KvCreateSessionStore,
  type CreateSessionStore,
} from './create-session-store';
import {
  SIGN_TIMEOUT_MS,
  SIGN_TRANSACTION_ACTION,
  createCreateTools,
} from './create-tools';
import {
  ALL_ROLE_IDS,
  ISO,
  THREAD,
  USER,
  byName,
  seedRoles,
} from './test-fixtures';

const BLOB = 'blob_00000000000000ab';
/** A request (turn) other than `makeRuntimeContext()`'s default `req-1`. */
const PREP = 'req-prepare';
const LATER = 'req-later';
const TX_HASH =
  'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2';

const callAgActionMock =
  vi.fn<(params: FrontendCallParams) => Promise<unknown>>();

/** The realtime bridge to the user's browser, with a connected client. */
function frontend(
  over: Partial<FrontendCallSurface> = {},
): FrontendCallSurface {
  return {
    callBrowserTool: async () => {
      throw new Error('no browser tools in these tests');
    },
    callAgAction: callAgActionMock,
    hasClient: () => true,
    ...over,
  };
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

/** A ctx whose blob store returns a stored batch, with a connected browser. */
function ctxWithStoredBlob(over: Partial<RuntimeContext> = {}): RuntimeContext {
  return makeRuntimeContext({
    blobStore: {
      put: async () => BLOB,
      get: async () => ({ name: 'pod-unsigned-tx', value: 'BASE64' }),
      isValidBlobId: (v): v is string =>
        typeof v === 'string' && /^blob_[0-9a-f]{16}$/.test(v),
    },
    frontend: frontend(),
    ...over,
  });
}

/** Seed every role with a passing section so the launch gate is satisfied. */
async function seedComplete(
  store: KvBlueprintStore,
  thread: string,
): Promise<void> {
  await seedRoles(store, thread, ALL_ROLE_IDS);
}

/**
 * The create tools over in-memory stores. Without an explicit blueprint store
 * the thread's design is complete (every gate passed), since
 * `request_pod_signature` re-checks the launch gate.
 */
async function makeTools(
  over: {
    gateway?: ChainGateway;
    blueprint?: KvBlueprintStore;
    sessions?: CreateSessionStore;
  } = {},
): Promise<{
  tools: PluginTool[];
  blueprint: KvBlueprintStore;
  sessions: CreateSessionStore;
}> {
  let blueprint = over.blueprint;
  if (!blueprint) {
    blueprint = new KvBlueprintStore(createMemoryUserKv());
    await seedComplete(blueprint, THREAD);
  }
  const sessions =
    over.sessions ?? new KvCreateSessionStore(createMemoryUserKv());
  const tools = createCreateTools(
    () => blueprint,
    over.gateway ?? mockGateway(),
    () => sessions,
  );
  return { tools, blueprint, sessions };
}

beforeEach(() => {
  callAgActionMock.mockReset();
});

describe('create-path tools', () => {
  it('prepare_pod_transaction refuses until the launch-readiness gate passes', async () => {
    const blueprint = new KvBlueprintStore(createMemoryUserKv());
    await blueprint.putSection(THREAD, {
      role: 'service_intent_scorer',
      stage: 'qualify',
      content: {},
      recordedAt: ISO,
      verdict: 'pass',
    });
    const { tools } = await makeTools({ blueprint });
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

  it('prepare_pod_transaction builds the unsigned batch once the gate passes and stashes it out of model context', async () => {
    const blueprint = new KvBlueprintStore(createMemoryUserKv());
    await seedComplete(blueprint, THREAD);
    const prepareSpy = vi.fn(async () => ({
      unsignedTx: 'BASE64',
      summary: 'Creates POD X',
      messageCount: 3,
    }));
    const { tools } = await makeTools({
      blueprint,
      gateway: mockGateway({ prepareUnsignedPodBatch: prepareSpy }),
    });
    const blobStore = createMemoryBlobStore();
    const ctx = makeRuntimeContext({}, { ambient: { blobStore } });
    const raw = await byName(tools, 'prepare_pod_transaction').handler({}, ctx);
    const out = z
      .object({
        prepared: z.boolean(),
        blobId: z.string().optional(),
        messageCount: z.number().optional(),
      })
      .parse(raw);
    expect(out.prepared).toBe(true);
    expect(out.messageCount).toBe(3);
    expect(out.blobId).toMatch(/^blob_[0-9a-f]{16}$/);
    expect(prepareSpy).toHaveBeenCalledOnce();
    // The bytes sit in the user's blob store; the model only sees the id.
    expect(JSON.stringify(raw)).not.toContain('BASE64');
    expect(
      await blobStore.get({ userDid: USER, blobId: out.blobId ?? '' }),
    ).toEqual({ name: 'pod-unsigned-tx', value: 'BASE64' });
  });

  it('prepare_pod_transaction refuses mainnet without the operator opt-in', async () => {
    const blueprint = new KvBlueprintStore(createMemoryUserKv());
    await seedComplete(blueprint, THREAD);
    const prepareSpy = vi.fn(async () => ({
      unsignedTx: 'BASE64',
      summary: 'Creates POD X',
      messageCount: 3,
    }));
    const { tools } = await makeTools({
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

  it('prepare_pod_transaction allows mainnet when the operator opted in (string env form)', async () => {
    const blueprint = new KvBlueprintStore(createMemoryUserKv());
    await seedComplete(blueprint, THREAD);
    const { tools } = await makeTools({ blueprint });
    const out = z.object({ prepared: z.boolean() }).parse(
      await byName(tools, 'prepare_pod_transaction').handler(
        {},
        makeRuntimeContext({
          config: { NETWORK: 'mainnet', POD_CREATOR_ALLOW_MAINNET: 'true' },
        }),
      ),
    );
    expect(out.prepared).toBe(true);
  });

  it('prepare and confirm report unavailability on the not-configured gateway instead of throwing', async () => {
    const blueprint = new KvBlueprintStore(createMemoryUserKv());
    await seedComplete(blueprint, THREAD);
    const { tools } = await makeTools({
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
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
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
    const dispatch = callAgActionMock.mock.calls[0]?.[0];
    expect(dispatch?.toolName).toBe(SIGN_TRANSACTION_ACTION);
    expect(dispatch?.toolName).toBe('sign_transaction');
    expect(dispatch?.sessionId).toBe(THREAD);
    expect(dispatch?.timeoutMs).toBe(SIGN_TIMEOUT_MS);
    expect(dispatch?.args).toEqual({
      blobId: BLOB,
      unsignedTx: 'BASE64',
      network: 'testnet',
    });
  });

  it('request_pod_signature cannot be replayed — the approval is spent on dispatch', async () => {
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
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
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
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

  it('reports the wallet unreachable when no browser is connected to the session (approval still spent)', async () => {
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
    const ctx = ctxWithStoredBlob({
      frontend: frontend({ hasClient: () => false }),
    });

    await byName(tools, 'approve_pod_transaction').handler(
      { blobId: BLOB },
      ctx,
    );
    const out = z
      .object({ txHash: z.string().nullable(), message: z.string() })
      .parse(
        await byName(tools, 'request_pod_signature').handler(
          { blobId: BLOB },
          ctx,
        ),
      );
    expect(out.txHash).toBeNull();
    expect(out.message).toMatch(/did not complete/i);
    expect(callAgActionMock).not.toHaveBeenCalled();
    expect(await sessions.consume(USER, THREAD, BLOB)).toBe(false);
  });

  it('reports the wallet unreachable on a host without a realtime channel', async () => {
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
    await sessions.approve(USER, THREAD, BLOB, LATER);
    const ctx = ctxWithStoredBlob({ frontend: undefined });
    const out = z
      .object({ txHash: z.string().nullable(), message: z.string() })
      .parse(
        await byName(tools, 'request_pod_signature').handler(
          { blobId: BLOB },
          ctx,
        ),
      );
    expect(out.txHash).toBeNull();
    expect(out.message).toMatch(/did not complete/i);
  });

  it('approve_pod_transaction refuses a batch not prepared in this conversation', async () => {
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, 'some-other-thread', BLOB, PREP);
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
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: BLOB },
        ctxWithStoredBlob(),
      ),
    ).rejects.toThrow(/not approved/i);
    expect(callAgActionMock).not.toHaveBeenCalled();
  });

  it('request_pod_signature refuses mainnet without the opt-in, before spending the approval', async () => {
    const { tools, sessions } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
    await sessions.approve(USER, THREAD, BLOB, LATER);
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: BLOB },
        ctxWithStoredBlob({ config: { NETWORK: 'mainnet' } }),
      ),
    ).rejects.toThrow(/mainnet/i);
    expect(callAgActionMock).not.toHaveBeenCalled();
    expect(await sessions.consume(USER, THREAD, BLOB)).toBe(true);
  });

  it('approve_pod_transaction refuses in the turn that prepared the batch; a later turn can approve', async () => {
    const { tools } = await makeTools();
    const blobStore = createMemoryBlobStore();
    const turn = (requestId: string): RuntimeContext => {
      const ctx = makeRuntimeContext(
        { frontend: frontend() },
        { ambient: { blobStore } },
      );
      return { ...ctx, session: { ...ctx.session, requestId } };
    };
    const prepared = z
      .object({ prepared: z.literal(true), blobId: z.string() })
      .parse(
        await byName(tools, 'prepare_pod_transaction').handler(
          {},
          turn('req-1'),
        ),
      );

    const sameTurn = z
      .object({ approved: z.boolean(), message: z.string() })
      .parse(
        await byName(tools, 'approve_pod_transaction').handler(
          { blobId: prepared.blobId },
          turn('req-1'),
        ),
      );
    expect(sameTurn.approved).toBe(false);
    expect(sameTurn.message).toMatch(/same turn/i);
    // Nothing reaches the wallet from that turn.
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: prepared.blobId },
        turn('req-1'),
      ),
    ).rejects.toThrow(/not approved/i);
    expect(callAgActionMock).not.toHaveBeenCalled();

    const nextTurn = z
      .object({ approved: z.boolean() })
      .parse(
        await byName(tools, 'approve_pod_transaction').handler(
          { blobId: prepared.blobId },
          turn('req-2'),
        ),
      );
    expect(nextTurn.approved).toBe(true);
  });

  it('request_pod_signature re-checks the launch gate and keeps the approval when it no longer passes', async () => {
    const blueprint = new KvBlueprintStore(createMemoryUserKv());
    await seedRoles(blueprint, THREAD, ALL_ROLE_IDS, [
      'qa_launch_readiness_oracle',
    ]);
    const { tools, sessions } = await makeTools({ blueprint });
    await sessions.prepared(USER, THREAD, BLOB, PREP);
    await sessions.approve(USER, THREAD, BLOB, LATER);
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: BLOB },
        ctxWithStoredBlob(),
      ),
    ).rejects.toThrow(/no longer passes/i);
    expect(callAgActionMock).not.toHaveBeenCalled();
    expect(await sessions.consume(USER, THREAD, BLOB)).toBe(true);
  });

  it('request_pod_signature refuses once the design is gone (restarted or expired)', async () => {
    const { tools, sessions, blueprint } = await makeTools();
    await sessions.prepared(USER, THREAD, BLOB, PREP);
    await sessions.approve(USER, THREAD, BLOB, LATER);
    await blueprint.reset(THREAD);
    await expect(
      byName(tools, 'request_pod_signature').handler(
        { blobId: BLOB },
        ctxWithStoredBlob(),
      ),
    ).rejects.toThrow(/no longer passes/i);
    expect(callAgActionMock).not.toHaveBeenCalled();
  });

  it('request_pod_signature rejects a missing or expired batch', async () => {
    const { tools } = await makeTools();
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
    const { tools, sessions } = await makeTools({
      gateway: mockGateway({ confirmPodCreation: confirmSpy }),
    });
    await sessions.prepared(USER, THREAD, BLOB, PREP);
    await sessions.approve(USER, THREAD, BLOB, LATER);
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
    const { tools } = await makeTools();
    await expect(
      byName(tools, 'confirm_pod_creation').handler(
        { txHash: '0xabc' },
        makeRuntimeContext(),
      ),
    ).rejects.toThrow(/64-character hex/);
  });
});

/** Method names that sign or broadcast a transaction (cosmjs / wallet shapes). */
const SIGNING_METHOD =
  /^(sign|signDirect|signAmino|signAndBroadcast|broadcast\w*|signTx\w*)$/i;

/**
 * `ctx` with every method call on it (and on copies of its plain-object
 * members) recorded by path. Class instances such as the abort signal are returned
 * as they are, so native methods keep their receiver.
 */
function recordCalls(ctx: RuntimeContext): {
  ctx: RuntimeContext;
  calls: string[];
} {
  const calls: string[] = [];
  const wrap = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value: unknown = Reflect.get(obj, prop, receiver);
        if (typeof prop !== 'string') return value;
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            calls.push(`${path}${prop}`);
            return Reflect.apply(value, obj, args);
          };
        }
        if (
          value !== null &&
          typeof value === 'object' &&
          Object.getPrototypeOf(value) === Object.prototype
        ) {
          // A copy: a frozen member (the no-op logger) would break the
          // proxy invariant for non-configurable properties.
          return wrap({ ...value }, `${path}${prop}.`);
        }
        return value;
      },
    });
  return { ctx: wrap({ ...ctx }, ''), calls };
}

describe('the oracle never signs a POD creation', () => {
  it('drives prepare → approve (next turn) → sign → confirm without the oracle signing, handing the wallet the gateway bytes unchanged', async () => {
    const blueprint = new KvBlueprintStore(createMemoryUserKv());
    await seedComplete(blueprint, THREAD);
    const UNSIGNED = 'CgsKCQoHdW5zaWduZWQSABoA';
    // A realistic gateway authenticates to its server with a per-user UCAN
    // invocation. That is auth, not signing creation, and is allowed.
    const authMint = vi.fn(async () => 'auth-invocation');
    const { tools } = await makeTools({
      blueprint,
      gateway: mockGateway({
        prepareUnsignedPodBatch: async (_input, gatewayCtx) => {
          await gatewayCtx.ucan.mintInvocation({
            did: 'did:web:mcp.ixo.example',
            capability: 'ixo:chain',
          });
          return {
            unsignedTx: UNSIGNED,
            summary: 'Creates POD X',
            messageCount: 3,
          };
        },
      }),
    });
    callAgActionMock.mockResolvedValueOnce({ txHash: TX_HASH });

    const base = makeRuntimeContext(
      { frontend: frontend() },
      { ambient: { blobStore: createMemoryBlobStore() } },
    );
    const turn = (requestId: string) =>
      recordCalls({
        ...base,
        session: { ...base.session, requestId },
        ucan: {
          ...base.ucan,
          hasSigningKey: () => true,
          mintInvocation: authMint,
        },
      });
    const first = turn('req-1');
    const second = turn('req-2');

    const prepared = z
      .object({ prepared: z.literal(true), blobId: z.string() })
      .parse(
        await byName(tools, 'prepare_pod_transaction').handler({}, first.ctx),
      );
    // The user confirms in their next message.
    z.object({ approved: z.literal(true) }).parse(
      await byName(tools, 'approve_pod_transaction').handler(
        { blobId: prepared.blobId },
        second.ctx,
      ),
    );
    const signed = z
      .object({ txHash: z.string() })
      .parse(
        await byName(tools, 'request_pod_signature').handler(
          { blobId: prepared.blobId },
          second.ctx,
        ),
      );
    const created = z
      .object({ created: z.literal(true) })
      .parse(
        await byName(tools, 'confirm_pod_creation').handler(
          { txHash: signed.txHash },
          second.ctx,
        ),
      );

    expect(created.created).toBe(true);
    // Auth minting happened (through the gateway) and is fine…
    expect(authMint).toHaveBeenCalledOnce();
    // …but nothing on the request context was asked to sign or broadcast.
    const calls = [...first.calls, ...second.calls];
    expect(calls).toContain('ucan.mintInvocation');
    expect(
      calls.filter((path) => SIGNING_METHOD.test(path.split('.').at(-1) ?? '')),
    ).toEqual([]);
    // The wallet receives exactly the unsigned bytes the gateway produced:
    // nothing between prepare and the wallet signs, wraps or re-encodes them.
    expect(callAgActionMock).toHaveBeenCalledOnce();
    expect(callAgActionMock.mock.calls[0]?.[0].args).toMatchObject({
      unsignedTx: UNSIGNED,
    });
    expect(calls).toContain('frontend.callAgAction');
  });
});
