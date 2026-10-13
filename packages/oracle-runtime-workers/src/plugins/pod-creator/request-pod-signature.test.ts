/**
 * `request_pod_signature` through the real plugin API, inside workerd. The
 * POD creator sends the same `sign_transaction` contract as
 * `sign_ixo_transaction` (its batch form), so one Portal handler serves both:
 * the dispatched args are checked against `@ixo/ixo-transaction`'s own
 * Portal-side validation. The round trip runs against a fake AG-UI bridge
 * built on the real `FrontendCallRegistry` — settlement, lost sockets and
 * the turn's abort are the runtime's own.
 */
import {
  SignTransactionActionArgsSchema,
  buildBatchSignTransactionActionArgs,
  signIxoTransactionWithWallet,
  type ITrxMsg,
} from '@ixo/ixo-transaction';
import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRuntimeCore } from '../../core';
import { uncertainResultReason } from '../../core/middlewares/tool-execution';
import { createMemoryBlobStore } from '../../core/runtime-context';
import { makeEnv, makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  FrontendCallParams,
  FrontendCallSurface,
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import {
  FrontendCallRegistry,
  type FrontendExecutor,
} from '../../realtime/frontend-call-registry';
import { IxoTransactionPlugin } from '../ixo-transaction';
import { KvBlueprintStore } from './blueprint-store';
import { notConfiguredChainGateway, type ChainGateway } from './chain-gateway';
import { PodCreatorPlugin } from './pod-creator.plugin';
import {
  ALL_ROLE_IDS,
  THREAD,
  USER,
  acceptPodRisks,
  byName,
  podBatchMessages,
  seedRoles,
} from './test-fixtures';

const TX_HASH = 'B'.repeat(64);
const POD_DID = 'did:ixo:entity:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SUMMARY = 'Create the Solar POD: entity, claim collection and grants';

/** The socket every call is sent to, as the endpoint binds it after sending. */
const PORTAL_TAB: FrontendExecutor = {
  sid: 'sid-portal-tab',
  sessionId: THREAD,
  userDid: USER,
};

/**
 * The realtime endpoint's `frontend` surface without sockets: a call is
 * parked in a real `FrontendCallRegistry` before it is recorded (as
 * `RealtimeEndpoint.call` registers before it emits), bound to the session's
 * socket, and the test answers it the way a socket's `action_call_result`
 * does.
 */
function fakeBridge(opts: { connected?: boolean } = {}) {
  const registry = new FrontendCallRegistry();
  const calls: FrontendCallParams[] = [];
  const surface: FrontendCallSurface = {
    callBrowserTool: () =>
      Promise.reject(new Error('browser tools are not used here')),
    callAgAction: (params) => {
      const pending = registry.open(
        {
          kind: 'agui',
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          sessionId: params.sessionId,
        },
        {
          timeoutMs: params.timeoutMs ?? 10_000,
          ...(params.signal ? { signal: params.signal } : {}),
        },
      );
      registry.dispatched(params.toolCallId, PORTAL_TAB);
      calls.push(params);
      return pending;
    },
    hasClient: (sessionId) => (opts.connected ?? true) && sessionId === THREAD,
  };
  /** Deliver `action_call_result` for the latest call from the Portal tab. */
  const answer = (payload: { result?: unknown; error?: string }): boolean => {
    const call = calls.at(-1);
    if (!call) throw new Error('no action call to answer');
    return registry.settle('agui', {
      toolCallId: call.toolCallId,
      from: PORTAL_TAB,
      ...payload,
    }).settled;
  };
  return { surface, calls, answer, registry };
}

function gatewayFor(messages: ITrxMsg[] = podBatchMessages()): ChainGateway {
  return {
    preparePodBatch: async () => ({ messages, summary: SUMMARY }),
    confirmPodCreation: async () => ({ podDid: POD_DID, summary: 'live' }),
  };
}

function asToolMessage(result: unknown): ToolMessage {
  return new ToolMessage({
    tool_call_id: 'call-1',
    name: 'request_pod_signature',
    content: JSON.stringify(result),
  });
}

/**
 * A user whose design passed the launch gate, the batch prepared in one turn
 * and approved (every risk accepted) in the next, through the plugin's tools.
 * `turn` builds the context of a later turn of the same user and thread.
 */
async function approvedBatch(
  options: {
    gateway?: ChainGateway;
    config?: Record<string, unknown>;
    frontend?: FrontendCallSurface;
  } = {},
) {
  const kv: UserKvSurface = createMemoryUserKv();
  await seedRoles(new KvBlueprintStore(kv), THREAD, ALL_ROLE_IDS);
  const blobStore = createMemoryBlobStore();
  const tools: PluginTool[] = new PodCreatorPlugin({
    chainGateway: options.gateway ?? gatewayFor(),
  }).getTools();
  const turn = (
    requestId: string,
    over: Partial<RuntimeContext> = {},
  ): RuntimeContext => {
    const ctx = makeRuntimeContext(
      {
        config: options.config ?? {},
        ...(options.frontend ? { frontend: options.frontend } : {}),
        ...over,
      },
      { ambient: { kv, blobStore } },
    );
    return { ...ctx, session: { ...ctx.session, requestId } };
  };
  const prepared = z
    .object({ prepared: z.literal(true), blobId: z.string() })
    .parse(
      await byName(tools, 'prepare_pod_transaction').handler({}, turn('req-1')),
    );
  z.object({ approved: z.literal(true) }).parse(
    await byName(tools, 'approve_pod_transaction').handler(
      { blobId: prepared.blobId, riskConfirmation: acceptPodRisks() },
      turn('req-2'),
    ),
  );
  const sign = (over: Partial<RuntimeContext> = {}) =>
    byName(tools, 'request_pod_signature').handler(
      { blobId: prepared.blobId },
      turn('req-3', over),
    );
  return { tools, blobId: prepared.blobId, turn, sign };
}

/** Wait until the tool has dispatched its action call. */
async function dispatched(bridge: ReturnType<typeof fakeBridge>) {
  await vi.waitFor(() => expect(bridge.calls).toHaveLength(1));
}

describe('request_pod_signature sends the ixo-transaction sign_transaction contract', () => {
  it('dispatches the batch form, which the Portal handler validates and signs in one wallet call', async () => {
    const bridge = fakeBridge();
    const { sign, tools, turn } = await approvedBatch({
      frontend: bridge.surface,
    });

    const pending = sign();
    await dispatched(bridge);
    const call = bridge.calls[0];
    if (!call) throw new Error('nothing dispatched');
    expect(call.toolName).toBe('sign_transaction');
    expect(call.sessionId).toBe(THREAD);
    expect(call.timeoutMs).toBe(120_000);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.args).toEqual(
      buildBatchSignTransactionActionArgs({
        messages: podBatchMessages(),
        summary: SUMMARY,
        network: 'testnet',
        riskConfirmation: acceptPodRisks(),
      }),
    );
    expect(call.args).toMatchObject({
      action: 'sign_transaction',
      network: 'testnet',
      chainId: 'pandora-8',
      intent: { source: 'batch', summary: SUMMARY },
      riskLevel: 'critical',
      requiresConfirmation: true,
    });
    expect(SignTransactionActionArgsSchema.safeParse(call.args).success).toBe(
      true,
    );

    // The Portal side of the same contract (`@ixo/ixo-transaction`): every
    // message re-validated against the catalog, all signed in one call.
    const wallet = vi.fn(async () => ({
      transactionHash: TX_HASH,
      code: 0,
      height: 42,
    }));
    const portalAnswer = await signIxoTransactionWithWallet(call.args, wallet, {
      walletChainId: 'pandora-8',
    });
    expect(wallet).toHaveBeenCalledExactlyOnceWith(
      podBatchMessages(),
      undefined,
    );
    expect(bridge.answer({ result: portalAnswer })).toBe(true);

    const result = await pending;
    expect(result).toEqual({
      status: 'signed',
      network: 'testnet',
      chainId: 'pandora-8',
      txHash: TX_HASH,
      code: 0,
      height: 42,
      message:
        'The wallet signed and broadcast the batch. Call confirm_pod_creation with this txHash.',
    });
    expect(uncertainResultReason(asToolMessage(result))).toBeNull();
    expect(bridge.registry.size).toBe(0);

    await expect(
      byName(tools, 'confirm_pod_creation').handler(
        { txHash: TX_HASH },
        turn('req-3'),
      ),
    ).resolves.toEqual({ created: true, podDid: POD_DID, summary: 'live' });
  });

  it('names the chain of the configured network, with the shared IXO_TRANSACTION_CHAIN_ID_* overrides', async () => {
    const bridge = fakeBridge();
    const { sign } = await approvedBatch({
      frontend: bridge.surface,
      config: {
        NETWORK: 'devnet',
        IXO_TRANSACTION_CHAIN_ID_DEVNET: 'devnet-7',
      },
    });

    const pending = sign();
    await dispatched(bridge);
    expect(bridge.calls[0]?.args).toMatchObject({
      network: 'devnet',
      chainId: 'devnet-7',
    });
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
    await expect(pending).resolves.toMatchObject({
      status: 'signed',
      chainId: 'devnet-7',
    });
  });

  it('reports a signed batch without a hash, asking for it', async () => {
    const bridge = fakeBridge();
    const { sign } = await approvedBatch({ frontend: bridge.surface });

    const pending = sign();
    await dispatched(bridge);
    bridge.answer({ result: { success: true } });
    await expect(pending).resolves.toEqual({
      status: 'signed',
      network: 'testnet',
      chainId: 'pandora-8',
      message:
        'The wallet reports the batch signed but returned no transaction hash. Ask the user for it, then call confirm_pod_creation with it.',
    });
  });

  it('reports a batch that failed on chain as failed, with its code and hash', async () => {
    const bridge = fakeBridge();
    const { sign } = await approvedBatch({ frontend: bridge.surface });

    const pending = sign();
    await dispatched(bridge);
    bridge.answer({
      result: {
        success: true,
        delivered: { code: 18, transactionHash: TX_HASH, height: 9 },
        error: 'a document with did did:ixo:entity:… already exists',
      },
    });
    const result = await pending;
    expect(result).toEqual({
      status: 'failed',
      network: 'testnet',
      chainId: 'pandora-8',
      code: 18,
      txHash: TX_HASH,
      height: 9,
      error: 'a document with did did:ixo:entity:… already exists',
      message: expect.stringMatching(
        /^The transaction was included in a block but failed, so no POD was created/,
      ),
    });
    // A known outcome: the claim is released.
    expect(uncertainResultReason(asToolMessage(result))).toBeNull();
  });

  it('reports the user declining as rejected, and any other refusal as error', async () => {
    for (const [error, status] of [
      ['User rejected the request', 'rejected'],
      [
        'Chain mismatch: the transaction is for pandora-8 (testnet) but this Portal wallet is on ixo-5; nothing was signed',
        'error',
      ],
    ] as const) {
      const bridge = fakeBridge();
      const { sign } = await approvedBatch({ frontend: bridge.surface });
      const pending = sign();
      await dispatched(bridge);
      bridge.answer({ error });
      const result = await pending;
      expect(result).toEqual({
        status,
        network: 'testnet',
        error,
        message:
          'Nothing was signed and the approval was spent: to retry, the user confirms again in a new message and you call approve_pod_transaction, then request_pod_signature.',
      });
      expect(uncertainResultReason(asToolMessage(result))).toBeNull();
      // The approval was spent on the dispatch.
      await expect(sign()).rejects.toThrow(/not approved|already used/);
    }
  });

  it('is unavailable when the Portal has no sign_transaction handler', async () => {
    const bridge = fakeBridge();
    const { sign } = await approvedBatch({ frontend: bridge.surface });

    const pending = sign();
    await dispatched(bridge);
    bridge.answer({ error: 'Action tool sign_transaction not found' });
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      error: expect.stringMatching(/no sign_transaction handler is registered/),
    });
  });

  it('is unavailable without a connected browser, sends nothing and keeps the approval', async () => {
    const offline = fakeBridge({ connected: false });
    const { sign } = await approvedBatch({ frontend: offline.surface });

    await expect(sign()).resolves.toMatchObject({
      status: 'unavailable',
      error: expect.stringMatching(/No Portal browser is connected/),
    });
    expect(offline.calls).toHaveLength(0);

    const online = fakeBridge();
    const pending = sign({ frontend: online.surface });
    await dispatched(online);
    online.answer({ result: { success: true, transactionHash: TX_HASH } });
    await expect(pending).resolves.toMatchObject({ status: 'signed' });
  });

  it('reports a lost Portal socket as an unknown outcome that keeps the write claim', async () => {
    const bridge = fakeBridge();
    const { sign } = await approvedBatch({ frontend: bridge.surface });

    const pending = sign();
    await dispatched(bridge);
    expect(bridge.registry.executorGone(PORTAL_TAB.sid)).toBe(1);
    const result = await pending;
    expect(result).toEqual({
      status: 'timeout',
      outcome: 'unknown',
      network: 'testnet',
      error:
        'The Portal wallet did not answer within 120 s, or its tab disconnected, and the request timed out. The outcome is unknown: the user may still sign it in their wallet. Do not send it again; ask the user whether it went through.',
    });
    // The tool-execution middleware keeps the claim on this result, so an
    // identical request is not dispatched again in the thread.
    expect(uncertainResultReason(asToolMessage(result))).toBe(
      'outcome unknown',
    );
    expect(bridge.registry.size).toBe(0);
    // A late answer settles nothing.
    expect(
      bridge.answer({ result: { success: true, transactionHash: TX_HASH } }),
    ).toBe(false);
  });

  it("reports the turn's abort after dispatch as an unknown outcome", async () => {
    const bridge = fakeBridge();
    const { sign } = await approvedBatch({ frontend: bridge.surface });
    const controller = new AbortController();

    const pending = sign({ abortSignal: controller.signal });
    await dispatched(bridge);
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 'timeout', outcome: 'unknown' });
    expect(uncertainResultReason(asToolMessage(result))).toBe(
      'outcome unknown',
    );
  });
});

describe('the mainnet gate and the gateway', () => {
  it('refuses mainnet unless the operator opted in; opted in, the request names the mainnet chain', async () => {
    const kv = createMemoryUserKv();
    await seedRoles(new KvBlueprintStore(kv), THREAD, ALL_ROLE_IDS);
    const gateway = gatewayFor();
    const prepareSpy = vi.spyOn(gateway, 'preparePodBatch');
    const tools = new PodCreatorPlugin({ chainGateway: gateway }).getTools();
    await expect(
      byName(tools, 'prepare_pod_transaction').handler(
        {},
        makeRuntimeContext(
          { config: { NETWORK: 'mainnet' } },
          { ambient: { kv } },
        ),
      ),
    ).resolves.toMatchObject({
      prepared: false,
      message: expect.stringMatching(/Mainnet POD creation is disabled/),
    });
    expect(prepareSpy).not.toHaveBeenCalled();

    const bridge = fakeBridge();
    const allowed = { NETWORK: 'mainnet', POD_CREATOR_ALLOW_MAINNET: 'true' };
    const { sign } = await approvedBatch({
      frontend: bridge.surface,
      config: allowed,
    });
    const pending = sign();
    await dispatched(bridge);
    expect(bridge.calls[0]?.args).toMatchObject({
      network: 'mainnet',
      chainId: 'ixo-5',
    });
    expect(bridge.calls[0]?.args).not.toHaveProperty('testnetReceipt');
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
    await expect(pending).resolves.toMatchObject({ status: 'signed' });
  });

  it('refuses to sign a mainnet batch once the opt-in is withdrawn, sending nothing', async () => {
    const bridge = fakeBridge();
    const { sign } = await approvedBatch({
      frontend: bridge.surface,
      config: { NETWORK: 'mainnet', POD_CREATOR_ALLOW_MAINNET: 'true' },
    });
    await expect(sign({ config: { NETWORK: 'mainnet' } })).rejects.toThrow(
      /Mainnet POD creation is disabled/,
    );
    expect(bridge.calls).toHaveLength(0);
  });

  it('the bundled plugin has no gateway: creation is reported unavailable, and the default gateway refuses explicitly', async () => {
    const kv = createMemoryUserKv();
    await seedRoles(new KvBlueprintStore(kv), THREAD, ALL_ROLE_IDS);
    const tools = new PodCreatorPlugin().getTools();
    await expect(
      byName(tools, 'prepare_pod_transaction').handler(
        {},
        makeRuntimeContext({}, { ambient: { kv } }),
      ),
    ).resolves.toEqual({
      prepared: false,
      message: expect.stringMatching(/chain gateway is not configured/),
    });
    await expect(
      notConfiguredChainGateway.preparePodBatch(
        {
          blueprint: {
            threadId: THREAD,
            stages: {
              qualify: [],
              architect: [],
              build: [],
              evaluate: [],
              package: [],
              gate: [],
            },
            assembledAt: '2026-10-07T00:00:00.000Z',
          },
          network: 'testnet',
        },
        makeRuntimeContext(),
      ),
    ).rejects.toThrow(/^ChainGateway not configured/);
  });

  it('boots beside IxoTransactionPlugin with one set of chain id variables and no collision warning', () => {
    const warn = vi.fn();
    const core = createRuntimeCore({
      config: { name: 'PodOracle' },
      plugins: [new IxoTransactionPlugin(), new PodCreatorPlugin()],
      env: makeEnv({ IXO_TRANSACTION_CHAIN_ID_TESTNET: 'pandora-9' }),
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });
    expect(core.validatedEnv.IXO_TRANSACTION_CHAIN_ID_TESTNET).toBe(
      'pandora-9',
    );
    expect(core.validatedEnv.IXO_TRANSACTION_CHAIN_ID_MAINNET).toBe('ixo-5');
    expect(
      warn.mock.calls.filter(([line]) =>
        String(line).includes('IXO_TRANSACTION_CHAIN_ID'),
      ),
    ).toEqual([]);
  });
});
