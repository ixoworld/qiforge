/**
 * The ixo-transaction tools through the Workers plugin API, inside workerd.
 * The signing round trip runs against a fake AG-UI bridge built on the real
 * `FrontendCallRegistry` — the component the realtime endpoint parks a call
 * in and settles from `action_call_result` — so settlement, timeouts and the
 * session check are the runtime's own.
 */
import { buildSignTransactionActionArgs } from '@ixo/ixo-transaction';
import { ToolMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uncertainResultReason } from '../../core/middlewares/tool-execution';
import {
  createMemoryBlobStore,
  type BlobStoreAdapter,
} from '../../core/runtime-context';
import { makeBuildCtx, makeRuntimeContext } from '../../core/test-fixtures';
import type {
  FrontendCallParams,
  FrontendCallSurface,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { FrontendCallRegistry } from '../../realtime/frontend-call-registry';
import { IxoTransactionPlugin } from './ixo-transaction.plugin';
import { RECEIPT_NAME_PREFIX, messageDigest } from './receipts';

const SESSION = 'session-1';
const ROOM = '!room:ixo.test';
const OWNER = 'ixo1qwertyuiopasdfghjklzxcvbnmqwerty12345';
const TX_HASH = 'A'.repeat(64);
/** Well-formed, but never handed out by the blob store. */
const FAKE_RECEIPT = 'blob_0123456789abcdef';

const RETIRE_RISK = 'Permanently retires (burns) impact credits. Irreversible.';

function retireDraft(extra: Record<string, unknown> = {}) {
  return {
    command: '/ixo token retire',
    value: {
      owner: OWNER,
      tokens: [{ id: 'CARBON-1', amount: '10' }],
      jurisdiction: 'ZA',
      reason: 'offset',
    },
    riskConfirmation: { confirmed: true, acceptedRisks: [RETIRE_RISK] },
    ...extra,
  };
}

/**
 * The realtime endpoint's `frontend` surface without sockets: a call is
 * parked in a real `FrontendCallRegistry` before it is recorded (as
 * `RealtimeEndpoint.call` registers before it emits), and the test answers
 * it the way a socket's `action_call_result` does.
 */
function fakeBridge(opts: { connected?: boolean } = {}) {
  const registry = new FrontendCallRegistry();
  const calls: FrontendCallParams[] = [];
  const surface: FrontendCallSurface = {
    callBrowserTool: () =>
      Promise.reject(new Error('browser tools are not used here')),
    callAgAction: (params) => {
      const pending = registry.wait(
        {
          kind: 'agui',
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          sessionId: params.sessionId,
        },
        { timeoutMs: params.timeoutMs ?? 10_000 },
      );
      calls.push(params);
      return pending;
    },
    hasClient: (sessionId) => (opts.connected ?? true) && sessionId === SESSION,
  };
  /** Deliver `action_call_result` for the latest call from a socket of `sessionId`. */
  const answer = (
    payload: { result?: unknown; error?: string },
    sessionId = SESSION,
  ): boolean => {
    const call = calls.at(-1);
    if (!call) throw new Error('no action call to answer');
    return registry.settle('agui', {
      toolCallId: call.toolCallId,
      sessionId,
      ...payload,
    });
  };
  return { surface, calls, answer, registry };
}

function toolsFor(
  config: Record<string, unknown> = {},
): Map<string, PluginTool> {
  const plugin = new IxoTransactionPlugin();
  const tools = plugin.getTools(makeBuildCtx({ config }));
  return new Map(tools.map((t) => [t.name, t]));
}

function toolNamed(tools: Map<string, PluginTool>, name: string): PluginTool {
  const found = tools.get(name);
  if (!found) throw new Error(`tool ${name} not contributed`);
  return found;
}

function contextWith(
  frontend: FrontendCallSurface | undefined,
  posts: Array<{ roomId: string; eventType: string; content: object }> = [],
  blobStore: BlobStoreAdapter = createMemoryBlobStore(),
): RuntimeContext {
  const base = makeRuntimeContext(
    {},
    {
      ambient: { blobStore },
      runConfig: {
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@did-ixo-user1:ixo.world',
            ucanDelegation: { raw: 'test-ucan-delegation' },
          },
          session: {
            id: SESSION,
            client: 'portal',
            requestId: 'req-1',
            roomId: ROOM,
          },
        },
      },
    },
  );
  return {
    ...base,
    ...(frontend ? { frontend } : {}),
    matrix: {
      ...base.matrix,
      postEvent: async (roomId, eventType, content) => {
        posts.push({ roomId, eventType, content });
        return `$event${posts.length}`;
      },
    },
  };
}

/** Wait until the tool has dispatched its action call. */
async function dispatched(bridge: ReturnType<typeof fakeBridge>, count = 1) {
  await vi.waitFor(() => expect(bridge.calls).toHaveLength(count));
}

function asToolMessage(result: unknown): ToolMessage {
  return new ToolMessage({
    tool_call_id: 'call-1',
    name: 'sign_ixo_transaction',
    content: JSON.stringify(result),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('list_ixo_transaction_routes', () => {
  it('lists every route, or one module, with fields and risks', async () => {
    const list = toolNamed(toolsFor(), 'list_ixo_transaction_routes');
    const ctx = contextWith(undefined);

    const all = await list.handler({}, ctx);
    expect(all).toMatchObject({
      slashCommandFormat: '/ixo {message-type} {message-action}',
      deferredModules: ['bonds', 'liquidstake', 'names'],
      queryOnlyModules: ['epochs', 'mint'],
    });

    const claims = await list.handler({ messageType: 'claims' }, ctx);
    expect(claims).toMatchObject({
      routes: expect.arrayContaining([
        expect.objectContaining({
          command: '/ixo claims update-collection-quota',
          typeUrl: '/ixo.claims.v1beta1.MsgUpdateCollectionQuota',
          riskLevel: 'high',
        }),
      ]),
    });
    expect(JSON.stringify(claims).includes('/ixo.token.v1beta1.')).toBe(false);
  });
});

describe('classify_ixo_transaction_intent', () => {
  it('resolves a request and reports one it cannot route', async () => {
    const classify = toolNamed(toolsFor(), 'classify_ixo_transaction_intent');
    const ctx = contextWith(undefined);

    await expect(
      classify.handler({ input: 'I want to create a new domain' }, ctx),
    ).resolves.toEqual({
      status: 'resolved',
      intent: expect.objectContaining({
        messageName: 'MsgCreateEntity',
        source: 'natural-language',
      }),
    });
    await expect(
      classify.handler({ input: '/ixo names register' }, ctx),
    ).resolves.toEqual({
      status: 'unresolved',
      error: expect.stringMatching(/The names module is not supported yet/),
    });
  });
});

describe('validate_ixo_transaction_draft', () => {
  it('returns the canonical message, its risks and the confirmation flag', async () => {
    const validate = toolNamed(toolsFor(), 'validate_ixo_transaction_draft');

    await expect(
      validate.handler(retireDraft(), contextWith(undefined)),
    ).resolves.toMatchObject({
      status: 'valid',
      network: 'testnet',
      message: {
        typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
        value: { owner: OWNER },
      },
      risks: [RETIRE_RISK],
      riskLevel: 'critical',
      requiresConfirmation: true,
    });
  });

  it('says what is wrong instead of throwing: bad address, unknown field, mainnet off', async () => {
    const validate = toolNamed(toolsFor(), 'validate_ixo_transaction_draft');
    const ctx = contextWith(undefined);

    await expect(
      validate.handler(
        retireDraft({
          value: {
            owner: 'cosmos1bad',
            tokens: [{ id: 'CARBON-1', amount: '10' }],
            jurisdiction: 'ZA',
            reason: 'offset',
          },
        }),
        ctx,
      ),
    ).resolves.toEqual({
      status: 'invalid',
      error: expect.stringMatching(/^owner: Expected an IXO bech32/),
    });
    await expect(
      validate.handler(retireDraft({ gasPrice: '1uixo' }), ctx),
    ).resolves.toEqual({
      status: 'invalid',
      error: expect.stringMatching(/gasPrice/),
    });
    await expect(
      validate.handler(
        retireDraft({
          network: 'mainnet',
          testnetReceipt: { transactionHash: TX_HASH, receiptId: FAKE_RECEIPT },
        }),
        ctx,
      ),
    ).resolves.toEqual({
      status: 'invalid',
      error: expect.stringMatching(/Mainnet transactions are disabled/),
    });
  });
});

describe('sign_ixo_transaction: refused before dispatch', () => {
  it('returns validation_error without risk confirmation and dispatches nothing', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    const result = await sign.handler(
      retireDraft({ riskConfirmation: undefined }),
      contextWith(bridge.surface),
    );

    expect(result).toEqual({
      status: 'validation_error',
      error: `Risk confirmation required before signing MsgRetireToken: the user must accept, word for word, ${JSON.stringify(RETIRE_RISK)}`,
    });
    expect(bridge.calls).toEqual([]);
  });

  it('refuses a confirmation that does not quote the risk word for word', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    const result = await sign.handler(
      retireDraft({
        riskConfirmation: { confirmed: true, acceptedRisks: ['ok'] },
      }),
      contextWith(bridge.surface),
    );

    expect(result).toMatchObject({ status: 'validation_error' });
    expect(bridge.calls).toEqual([]);
  });

  it('refuses mainnet by default, even with a testnet receipt', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    const result = await sign.handler(
      retireDraft({
        network: 'mainnet',
        testnetReceipt: { transactionHash: TX_HASH, receiptId: FAKE_RECEIPT },
      }),
      contextWith(bridge.surface),
    );

    expect(result).toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/Mainnet transactions are disabled/),
    });
    expect(bridge.calls).toEqual([]);
  });

  it('is unavailable without a realtime channel or a connected browser', async () => {
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    await expect(
      sign.handler(retireDraft(), contextWith(undefined)),
    ).resolves.toEqual({
      status: 'unavailable',
      error: expect.stringMatching(/realtime connection/),
    });

    const offline = fakeBridge({ connected: false });
    await expect(
      sign.handler(retireDraft(), contextWith(offline.surface)),
    ).resolves.toEqual({
      status: 'unavailable',
      error: expect.stringMatching(/No Portal browser is connected/),
    });
    expect(offline.calls).toEqual([]);
  });
});

describe('sign_ixo_transaction: the wallet round trip', () => {
  it('dispatches the validated sign_transaction action and reports a signed transaction', async () => {
    const bridge = fakeBridge();
    const posts: Array<{ roomId: string; eventType: string; content: object }> =
      [];
    const sign = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '45000' }),
      'sign_ixo_transaction',
    );

    const pending = sign.handler(
      retireDraft({ memo: 'offset 2026' }),
      contextWith(bridge.surface, posts),
    );
    await dispatched(bridge);

    const [call] = bridge.calls;
    expect(call).toEqual({
      sessionId: SESSION,
      toolCallId: expect.stringMatching(/^ixo_tx_req-1_[0-9a-f-]{8}$/),
      toolName: 'sign_transaction',
      args: buildSignTransactionActionArgs(
        retireDraft({ memo: 'offset 2026' }),
      ),
      timeoutMs: 45_000,
    });

    expect(
      bridge.answer({
        result: {
          success: true,
          transactionHash: TX_HASH,
          code: 0,
          height: 99,
        },
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      status: 'signed',
      network: 'testnet',
      chainId: 'pandora-8',
      typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
      transactionHash: TX_HASH,
      code: 0,
      height: 99,
      testnetReceipt: {
        transactionHash: TX_HASH,
        receiptId: expect.stringMatching(/^blob_[0-9a-f]{16}$/),
        expiresInHours: 24,
      },
    });

    // The outcome is logged to the turn's room, as AG-UI actions are.
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      roomId: ROOM,
      eventType: 'ixo.action.log',
      content: {
        action: {
          name: 'sign_transaction',
          success: true,
          result: { status: 'signed', transactionHash: TX_HASH },
        },
        threadId: SESSION,
      },
    });
  });

  it('reports a wallet refusal as rejected', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    const pending = sign.handler(retireDraft(), contextWith(bridge.surface));
    await dispatched(bridge);
    bridge.answer({
      result: { success: false, error: 'User rejected the request' },
    });

    await expect(pending).resolves.toEqual({
      status: 'rejected',
      network: 'testnet',
      typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
      error: 'User rejected the request',
    });
  });

  it('reports a transaction that failed on chain as failed, with its hash and code', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    const pending = sign.handler(retireDraft(), contextWith(bridge.surface));
    await dispatched(bridge);
    // What the Portal handler answers for an included-but-failed delivery,
    // here with a log that mentions "cancel": it must not read as a refusal.
    bridge.answer({
      result: {
        success: true,
        delivered: { code: 5, transactionHash: TX_HASH, height: 120 },
        error: 'failed to execute message; token batch was cancelled',
      },
    });

    await expect(pending).resolves.toEqual({
      status: 'failed',
      network: 'testnet',
      chainId: 'pandora-8',
      typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
      code: 5,
      transactionHash: TX_HASH,
      height: 120,
      error: 'failed to execute message; token batch was cancelled',
    });
  });

  it('reports a Portal refusal that is not the user declining as error', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');
    const ctx = contextWith(bridge.surface);

    const wrongNetwork = sign.handler(retireDraft({ memo: 'second' }), ctx);
    await dispatched(bridge, 1);
    const mismatch =
      'Chain mismatch: the transaction is for pandora-8 (testnet) but this Portal wallet is on ixo-5; nothing was signed';
    bridge.answer({
      result: { success: false, error: mismatch },
      error: mismatch,
    });
    await expect(wrongNetwork).resolves.toMatchObject({
      status: 'error',
      error: mismatch,
    });
  });

  it('is unavailable when the Portal has no sign_transaction handler', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    const pending = sign.handler(retireDraft(), contextWith(bridge.surface));
    await dispatched(bridge);
    // The client SDK's reply to an action_call it has no handler for.
    const missing = 'Action tool sign_transaction not found';
    bridge.answer({
      result: { success: false, error: missing },
      error: missing,
    });

    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      error: expect.stringMatching(/no sign_transaction handler is registered/),
    });
  });

  it('reports a timeout as an unknown outcome that keeps the write claim', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '40' }),
      'sign_ixo_transaction',
    );

    const result = await sign.handler(
      retireDraft(),
      contextWith(bridge.surface),
    );

    expect(result).toEqual({
      status: 'timeout',
      outcome: 'unknown',
      network: 'testnet',
      typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
      error: expect.stringMatching(/timed out\. The outcome is unknown/),
    });
    // The runtime's tool-execution middleware keeps the claim on this result
    // (an identical sign is not dispatched again in the thread) and releases
    // it on a known outcome.
    expect(uncertainResultReason(asToolMessage(result))).toBe('timed out');
    expect(
      uncertainResultReason(
        asToolMessage({
          status: 'rejected',
          error: 'User rejected the request',
        }),
      ),
    ).toBeNull();
    expect(bridge.registry.size).toBe(0);
  });

  it("ignores a result from another session's socket and times out; a late answer settles nothing", async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '80' }),
      'sign_ixo_transaction',
    );

    const pending = sign.handler(retireDraft(), contextWith(bridge.surface));
    await dispatched(bridge);
    expect(
      bridge.answer(
        { result: { success: true, transactionHash: 'F'.repeat(64) } },
        'session-of-another-tab',
      ),
    ).toBe(false);
    expect(bridge.registry.size).toBe(1);

    await expect(pending).resolves.toMatchObject({
      status: 'timeout',
      outcome: 'unknown',
    });
    expect(
      bridge.answer({ result: { success: true, transactionHash: TX_HASH } }),
    ).toBe(false);
  });

  it('names the chain of every request, from the plugin configuration', async () => {
    const bridge = fakeBridge();
    const sign = toolNamed(
      toolsFor({ IXO_TRANSACTION_CHAIN_ID_TESTNET: 'pandora-9' }),
      'sign_ixo_transaction',
    );

    const pending = sign.handler(retireDraft(), contextWith(bridge.surface));
    await dispatched(bridge);
    expect(bridge.calls[0]?.args).toMatchObject({
      network: 'testnet',
      chainId: 'pandora-9',
    });
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
    await expect(pending).resolves.toMatchObject({
      status: 'signed',
      chainId: 'pandora-9',
    });
  });
});

describe('sign_ixo_transaction: mainnet needs a recorded testnet signing of the same message', () => {
  const MAINNET_HASH = 'B'.repeat(64);

  /** Sign the draft on testnet through the bridge; returns the receipt it recorded. */
  async function signOnTestnet(
    sign: PluginTool,
    ctx: RuntimeContext,
    bridge: ReturnType<typeof fakeBridge>,
    draft: Record<string, unknown>,
  ) {
    const before = bridge.calls.length;
    const pending = sign.handler(draft, ctx);
    await dispatched(bridge, before + 1);
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
    const result = await pending;
    if (
      typeof result !== 'object' ||
      result === null ||
      !('testnetReceipt' in result) ||
      typeof result.testnetReceipt !== 'object' ||
      result.testnetReceipt === null ||
      !('receiptId' in result.testnetReceipt) ||
      typeof result.testnetReceipt.receiptId !== 'string'
    ) {
      throw new Error(`no receipt in ${JSON.stringify(result)}`);
    }
    return {
      transactionHash: TX_HASH,
      receiptId: result.testnetReceipt.receiptId,
    };
  }

  function mainnetSetup() {
    const bridge = fakeBridge();
    const blobStore = createMemoryBlobStore();
    const ctx = contextWith(bridge.surface, [], blobStore);
    const sign = toolNamed(
      toolsFor({ IXO_TRANSACTION_ALLOW_MAINNET: 'true' }),
      'sign_ixo_transaction',
    );
    return { bridge, blobStore, ctx, sign };
  }

  it('refuses a mainnet draft without a receipt, or with one the oracle never recorded', async () => {
    const { bridge, ctx, sign } = mainnetSetup();

    await expect(
      sign.handler(retireDraft({ network: 'mainnet' }), ctx),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/Mainnet draft blocked/),
    });
    // A well-formed receipt the model made up: its own mainnet hash and a
    // blob id that was never handed out.
    await expect(
      sign.handler(
        retireDraft({
          network: 'mainnet',
          testnetReceipt: {
            transactionHash: MAINNET_HASH,
            receiptId: FAKE_RECEIPT,
          },
        }),
        ctx,
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(
        /^Testnet receipt blob_0123456789abcdef is not one this oracle recorded for this user/,
      ),
    });
    expect(bridge.calls).toEqual([]);
  });

  it('dispatches the mainnet draft of the same message, citing the recorded receipt, to the mainnet chain', async () => {
    const { bridge, ctx, sign } = mainnetSetup();
    const receipt = await signOnTestnet(sign, ctx, bridge, retireDraft());

    const pending = sign.handler(
      retireDraft({ network: 'mainnet', testnetReceipt: receipt }),
      ctx,
    );
    await dispatched(bridge, 2);
    expect(bridge.calls[1]?.args).toMatchObject({
      network: 'mainnet',
      chainId: 'ixo-5',
      testnetReceipt: receipt,
    });
    bridge.answer({ result: { success: true, transactionHash: MAINNET_HASH } });
    await expect(pending).resolves.toEqual({
      status: 'signed',
      network: 'mainnet',
      chainId: 'ixo-5',
      typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
      transactionHash: MAINNET_HASH,
    });
  });

  it("refuses the receipt for a different message, another hash, or another plugin's blob", async () => {
    const { bridge, blobStore, ctx, sign } = mainnetSetup();
    const receipt = await signOnTestnet(sign, ctx, bridge, retireDraft());

    const otherMessage = retireDraft({
      network: 'mainnet',
      testnetReceipt: receipt,
      value: {
        owner: OWNER,
        tokens: [{ id: 'CARBON-1', amount: '9999' }],
        jurisdiction: 'ZA',
        reason: 'offset',
      },
    });
    await expect(sign.handler(otherMessage, ctx)).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/is for a different transaction/),
    });

    await expect(
      sign.handler(
        retireDraft({
          network: 'mainnet',
          testnetReceipt: { ...receipt, transactionHash: MAINNET_HASH },
        }),
        ctx,
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/is not for transaction B{64}$/),
    });

    // Another plugin's blob shaped exactly like a receipt for this message.
    const message = buildSignTransactionActionArgs(retireDraft()).messages[0];
    if (!message) throw new Error('no message');
    const foreignBlob = await blobStore.put({
      userDid: 'did:ixo:user1',
      name: 'some-other-plugin/report',
      value: JSON.stringify({
        transactionHash: TX_HASH,
        digest: await messageDigest(message),
        chainId: 'pandora-8',
      }),
    });
    await expect(
      sign.handler(
        retireDraft({
          network: 'mainnet',
          testnetReceipt: { transactionHash: TX_HASH, receiptId: foreignBlob },
        }),
        ctx,
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: `Testnet receipt ${foreignBlob} is not for transaction ${TX_HASH}`,
    });
    expect(bridge.calls).toHaveLength(1);
  });

  it("does not accept another user's receipt", async () => {
    const { bridge, blobStore, ctx, sign } = mainnetSetup();
    const receiptId = await blobStore.put({
      userDid: 'did:ixo:someone-else',
      name: `${RECEIPT_NAME_PREFIX}${TX_HASH}`,
      value: JSON.stringify({
        transactionHash: TX_HASH,
        digest: '0'.repeat(64),
        chainId: 'pandora-8',
      }),
    });

    await expect(
      sign.handler(
        retireDraft({
          network: 'mainnet',
          testnetReceipt: { transactionHash: TX_HASH, receiptId },
        }),
        ctx,
      ),
    ).resolves.toMatchObject({
      status: 'validation_error',
      error: expect.stringMatching(
        /is not one this oracle recorded for this user/,
      ),
    });
    expect(bridge.calls).toEqual([]);
  });

  it('fails closed when the receipt store cannot be read', async () => {
    const bridge = fakeBridge();
    const broken: BlobStoreAdapter = {
      ...createMemoryBlobStore(),
      get: () => Promise.reject(new Error('storage offline')),
    };
    const sign = toolNamed(
      toolsFor({ IXO_TRANSACTION_ALLOW_MAINNET: 'true' }),
      'sign_ixo_transaction',
    );

    await expect(
      sign.handler(
        retireDraft({
          network: 'mainnet',
          testnetReceipt: { transactionHash: TX_HASH, receiptId: FAKE_RECEIPT },
        }),
        contextWith(bridge.surface, [], broken),
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(
        /cannot be checked right now \(storage offline\)/,
      ),
    });
    expect(bridge.calls).toEqual([]);
  });

  it('validate_ixo_transaction_draft applies the same receipt check', async () => {
    const { bridge, ctx, sign } = mainnetSetup();
    const validate = toolNamed(
      toolsFor({ IXO_TRANSACTION_ALLOW_MAINNET: 'true' }),
      'validate_ixo_transaction_draft',
    );
    await expect(
      validate.handler(
        retireDraft({
          network: 'mainnet',
          testnetReceipt: { transactionHash: TX_HASH, receiptId: FAKE_RECEIPT },
        }),
        ctx,
      ),
    ).resolves.toMatchObject({ status: 'invalid' });

    const receipt = await signOnTestnet(sign, ctx, bridge, retireDraft());
    await expect(
      validate.handler(
        retireDraft({ network: 'mainnet', testnetReceipt: receipt }),
        ctx,
      ),
    ).resolves.toMatchObject({ status: 'valid', chainId: 'ixo-5' });
  });

  it('makes no network request of its own: the wallet signs and broadcasts', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.reject(new Error('the plugin must not reach the network')),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const bridge = fakeBridge();
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');

    const pending = sign.handler(retireDraft(), contextWith(bridge.surface));
    await dispatched(bridge);
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });

    await expect(pending).resolves.toMatchObject({ status: 'signed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
