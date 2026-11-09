/**
 * The ixo-transaction tools through the Workers plugin API, inside workerd.
 * The signing round trip runs against a fake AG-UI bridge built on the real
 * `FrontendCallRegistry` — the component the realtime endpoint parks a call
 * in and settles from `action_call_result` — so settlement, timeouts and the
 * session check are the runtime's own.
 */
import {
  DAODAO_MAX_NAME_LENGTH,
  DAODAO_VOTING_PERIOD_SECONDS,
  MAX_BATCH_SUMMARY_LENGTH,
  SignTransactionActionArgsSchema,
  buildSignTransactionActionArgs,
  findMessageByRoute,
} from '@ixo/ixo-transaction';
import { ToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { uncertainResultReason } from '../../core/middlewares/tool-execution';
import {
  createMemoryBlobStore,
  type BlobStoreAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  FrontendCallParams,
  FrontendCallSurface,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import {
  FrontendCallRegistry,
  type FrontendExecutor,
} from '../../realtime/frontend-call-registry';
import { MsgSend } from '@ixo/impactxclient-sdk/module/codegen/cosmos/bank/v1beta1/tx.js';
import protobuf from 'protobufjs/minimal.js';
import { base64ToBytes, bytesToBase64 } from '../base64';
import { resetUpstreamHealth } from '../ixo-chain/http';
import { daoStepHint } from './dao-tools';
import devnetGroupTx from './fixtures/devnet-dao-group-tx.json';
import { WALLET_ERROR_MAX_CHARS } from './wallet-signing';
import { IxoTransactionPlugin } from './ixo-transaction.plugin';
import { RECEIPT_NAME_PREFIX, messageDigest } from './receipts';

const SESSION = 'session-1';
const USER_DID = 'did:ixo:user1';
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

/** The socket every call is sent to, as the endpoint binds it after sending. */
const PORTAL_TAB: FrontendExecutor = {
  sid: 'sid-portal-tab',
  sessionId: SESSION,
  userDid: USER_DID,
};

/**
 * The realtime endpoint's `frontend` surface without sockets: a call is
 * parked in a real `FrontendCallRegistry` before it is recorded (as
 * `RealtimeEndpoint.call` registers before it emits), bound to the session's
 * socket, and the test answers it the way a socket's `action_call_result`
 * does.
 */
function fakeBridge(
  opts: {
    connected?: boolean;
    /** Only a background executor is connected: it never runs an AG-UI action. */
    backgroundOnly?: boolean;
  } = {},
) {
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
    hasClient: (sessionId) => (opts.connected ?? true) && sessionId === SESSION,
    canDispatch: (sessionId, kind) =>
      (opts.connected ?? true) &&
      sessionId === SESSION &&
      (kind === 'browser' || !opts.backgroundOnly),
    parkedFor: () => null,
  };
  /** Deliver `action_call_result` for the latest call from the socket `from`. */
  const answer = (
    payload: { result?: unknown; error?: string },
    from: FrontendExecutor = PORTAL_TAB,
  ): boolean => {
    const call = calls.at(-1);
    if (!call) throw new Error('no action call to answer');
    return registry.settle('agui', {
      toolCallId: call.toolCallId,
      from,
      ...payload,
    }).settled;
  };
  return { surface, calls, answer, registry };
}

/** The plugin's tools on a Portal turn of an oracle with `config`. */
function toolsFor(
  config: Record<string, unknown> = {},
): Map<string, PluginTool> {
  const plugin = new IxoTransactionPlugin();
  const tools = plugin.getRequestTools(
    makeRuntimeContext({}, { ambient: { config } }),
  );
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
            did: USER_DID,
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

afterEach(() => {
  vi.unstubAllGlobals();
  resetUpstreamHealth();
});

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

  it('is unavailable at once when only a background executor of the session is connected: nothing is sent, nothing parks', async () => {
    const sign = toolNamed(toolsFor(), 'sign_ixo_transaction');
    const background = fakeBridge({ backgroundOnly: true });
    expect(background.surface.hasClient(SESSION)).toBe(true);
    await expect(
      sign.handler(retireDraft(), contextWith(background.surface)),
    ).resolves.toEqual({
      status: 'unavailable',
      error: expect.stringMatching(/No Portal browser is connected/),
    });
    expect(background.calls).toEqual([]);
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
      signal: expect.any(AbortSignal),
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
    // The runtime's tool-execution middleware reads `outcome: 'unknown'` and
    // keeps the claim on this result (an identical sign is not dispatched
    // again in the thread); it releases it on a known outcome.
    expect(uncertainResultReason(asToolMessage(result))).toBe(
      'outcome unknown',
    );
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
        {
          sid: 'sid-other-tab',
          sessionId: 'session-of-another-tab',
          userDid: USER_DID,
        },
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

/* ── the DAO DAO group proposal steps ──────────────────────────────────── */

/** Checksummed 20-byte accounts and 32-byte contracts (bech32 of filled bytes). */
const MEMBER = 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
const RECIPIENT = 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze';
const GROUP = 'ixo1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zsrtecm8';
const INTAKE = 'ixo1qcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqwa7lw0';
const PROPOSALS =
  'ixo1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurst089cd';

const riskOf = (step: 'propose' | 'vote' | 'execute' | 'close'): string[] => {
  const spec = findMessageByRoute('daodao', step);
  if (!spec) throw new Error(`no daodao ${step} route`);
  return spec.risks;
};
const accept = (step: 'propose' | 'vote' | 'execute' | 'close') => ({
  confirmed: true,
  acceptedRisks: riskOf(step),
});
const SEND_RISKS = findMessageByRoute('bank', 'send')?.risks ?? [];

/** Voting closes far in the future, or closed long ago (cw-utils `at_time`, ns). */
const OPEN_UNTIL = '2099-01-01T00:00:00Z';
const CLOSED_AT = '2020-01-01T00:00:00Z';
const atTime = (iso: string) => ({
  at_time: String(BigInt(Date.parse(iso)) * 1_000_000n),
});

/**
 * A `dao-proposal-single` 2.0.3 `{ proposal: { proposal_id } }` answer, in
 * the shape devnet answered for a POD group's proposal on Nov 9 2026: an
 * absolute count of 1 of 3 members, one yes vote, vote changes allowed.
 */
function proposalAnswer(over: Record<string, unknown> = {}, id = 3) {
  return {
    data: {
      id,
      proposal: {
        title: 'Fix the borehole',
        description: 'The group pays the fixer',
        proposer: MEMBER,
        start_height: 16_270_518,
        min_voting_period: null,
        expiration: atTime(OPEN_UNTIL),
        threshold: { absolute_count: { threshold: '1' } },
        total_power: '3',
        msgs: [],
        status: 'open',
        votes: { yes: '1', no: '0', abstain: '0' },
        allow_revoting: true,
        ...over,
      },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Chain REST answering every request with `answer` (the n-th request is
 * `n`); the URLs asked are recorded.
 */
function stubChain(answer: (n: number) => Response | Promise<Response>) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return answer(urls.length - 1);
    }),
  );
  return urls;
}

/** The smart query a chain REST URL carries, decoded. */
function smartQueryOf(url: string): { contract: string; query: unknown } {
  const match =
    /\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/([^/?]+)$/.exec(url);
  if (!match?.[1] || !match[2]) throw new Error(`not a smart query: ${url}`);
  return {
    contract: match[1],
    query: JSON.parse(
      new TextDecoder().decode(base64ToBytes(decodeURIComponent(match[2]))),
    ),
  };
}

/** The `sign_transaction` args of the bridge's first call, as the Portal reads them. */
function sentArgs(bridge: ReturnType<typeof fakeBridge>) {
  return SignTransactionActionArgsSchema.parse(bridge.calls[0]?.args);
}

/**
 * The user's own store (`ctx.kv`) for the conversation of one test: what the
 * DAO DAO tools showed and sent is kept there between its requests.
 */
let conversation = createMemoryUserKv();
beforeEach(() => {
  conversation = createMemoryUserKv();
});

/** The request that showed a DAO DAO step before the user confirmed it. */
const SHOWN_REQUEST = 'req-0';

/**
 * A Portal turn (`requestId`) of a member of a group (`did:ixo:<member>`)
 * on an oracle whose chain network is `network`, in the test's
 * conversation.
 */
function memberContext(
  frontend: FrontendCallSurface | undefined,
  network: string = 'testnet',
  did = `did:ixo:${MEMBER}`,
  requestId = 'req-1',
): RuntimeContext {
  const base = makeRuntimeContext(
    {},
    {
      ambient: { config: { NETWORK: network } },
      runConfig: {
        context: {
          user: {
            did,
            matrixUserId: '@member:ixo.world',
            ucanDelegation: { raw: 'test-ucan-delegation' },
          },
          session: { id: SESSION, client: 'portal', requestId },
        },
      },
    },
  );
  return {
    ...base,
    kv: conversation,
    ...(frontend ? { frontend } : {}),
  };
}

/**
 * Show `args` (without its riskConfirmation) to the user in an earlier
 * request of the conversation, as every DAO DAO signing call needs; the
 * preview is `confirm`.
 */
async function showFirst(
  tool: PluginTool,
  args: Record<string, unknown>,
  network = 'testnet',
  did = `did:ixo:${MEMBER}`,
) {
  const { riskConfirmation: _accepted, ...shown } = args;
  const bridge = fakeBridge();
  await expect(
    tool.handler(
      shown,
      memberContext(bridge.surface, network, did, SHOWN_REQUEST),
    ),
  ).resolves.toMatchObject({ status: 'confirm' });
  expect(bridge.calls).toEqual([]);
}

describe('the DAO DAO step tools: confirm first, nothing sent', () => {
  it('reads the proposal, then answers the summary with its title, its state and the catalog risks of a vote, and sends nothing', async () => {
    const urls = stubChain(() => json(proposalAnswer()));
    const bridge = fakeBridge();
    const vote = toolNamed(toolsFor(), 'vote_on_dao_proposal');

    const result = await vote.handler(
      { proposalModule: PROPOSALS, proposalId: 3, vote: 'yes' },
      memberContext(bridge.surface),
    );

    expect(result).toEqual({
      status: 'confirm',
      network: 'testnet',
      summary: `Vote YES on proposal 3 ("Fix the borehole") of the group proposal list ${PROPOSALS} on testnet, from your account ${MEMBER}, with no reason.`,
      risks: riskOf('vote'),
      proposal:
        'Proposal 3 ("Fix the borehole") is open for votes. Votes so far: 1 yes, 0 no, 0 abstain, of 3 voting power; it needs 1 yes vote to pass. Voting closes at 2099-01-01 00:00 UTC.',
      message: expect.stringContaining('Nothing was sent'),
    });
    expect(bridge.calls).toEqual([]);
    // One smart query of the proposal module, on the oracle's network.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/testnet\.ixo\.earth\/rest\//);
    expect(smartQueryOf(urls[0] ?? '')).toEqual({
      contract: PROPOSALS,
      query: { proposal: { proposal_id: 3 } },
    });
  });

  it('refuses a confirmation that misses a risk, a bad address, or both or neither proposal targets', async () => {
    const bridge = fakeBridge();
    const tools = toolsFor();
    const ctx = memberContext(bridge.surface);

    await expect(
      toolNamed(tools, 'execute_dao_proposal').handler(
        {
          proposalModule: PROPOSALS,
          proposalId: 3,
          riskConfirmation: { confirmed: true, acceptedRisks: ['ok'] },
        },
        ctx,
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/Risk confirmation required/),
    });
    await expect(
      toolNamed(tools, 'close_dao_proposal').handler(
        { proposalModule: `${PROPOSALS.slice(0, -1)}q`, proposalId: 3 },
        ctx,
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/proposalModule: .*valid checksum/),
    });
    const propose = toolNamed(tools, 'create_dao_proposal');
    for (const targets of [{}, { intake: INTAKE, proposalModule: PROPOSALS }])
      await expect(
        propose.handler(
          { ...targets, title: 'Fix the pump', description: 'Pay the fixer' },
          ctx,
        ),
      ).resolves.toEqual({
        status: 'validation_error',
        error: expect.stringMatching(/exactly one of `intake`/),
      });
    expect(bridge.calls).toEqual([]);
  });

  it('refuses a user without an IXO account, and mainnet unless the oracle allows it', async () => {
    const bridge = fakeBridge();
    const args = { proposalModule: PROPOSALS, proposalId: 3 };

    await expect(
      toolNamed(toolsFor(), 'close_dao_proposal').handler(
        args,
        memberContext(bridge.surface, 'testnet', USER_DID),
      ),
    ).resolves.toEqual({
      status: 'unavailable',
      error: expect.stringMatching(/not an IXO account/),
    });
    await expect(
      toolNamed(toolsFor(), 'close_dao_proposal').handler(
        args,
        memberContext(bridge.surface, 'mainnet'),
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/IXO_TRANSACTION_ALLOW_MAINNET/),
    });
    // Allowed: a group lives on one network, so no testnet receipt is asked for.
    stubChain(() => json(proposalAnswer({ status: 'rejected' })));
    await expect(
      toolNamed(
        toolsFor({ IXO_TRANSACTION_ALLOW_MAINNET: 'true' }),
        'close_dao_proposal',
      ).handler(args, memberContext(bridge.surface, 'mainnet')),
    ).resolves.toMatchObject({ status: 'confirm', network: 'mainnet' });
    expect(bridge.calls).toEqual([]);
  });
});

describe('the DAO DAO step tools: the wallet round trip', () => {
  it('sends a vote as a one-message batch with its summary, built from the fields, to the network’s chain', async () => {
    stubChain(() => json(proposalAnswer()));
    const bridge = fakeBridge();
    const posts: Array<{ roomId: string; eventType: string; content: object }> =
      [];
    const vote = toolNamed(toolsFor(), 'vote_on_dao_proposal');
    const ctx = {
      ...memberContext(bridge.surface),
      session: {
        id: SESSION,
        client: 'portal' as const,
        requestId: 'req-1',
        roomId: ROOM,
      },
      matrix: {
        ...memberContext(bridge.surface).matrix,
        postEvent: async (
          roomId: string,
          eventType: string,
          content: object,
        ) => {
          posts.push({ roomId, eventType, content });
          return '$event';
        },
      },
    };

    const args = {
      proposalModule: PROPOSALS,
      proposalId: 3,
      vote: 'no',
      rationale: 'Too expensive',
      riskConfirmation: accept('vote'),
    };
    await showFirst(vote, args);
    const pending = vote.handler(args, ctx);
    await dispatched(bridge);

    const [call] = bridge.calls;
    expect(call?.toolName).toBe('sign_transaction');
    expect(call?.toolCallId).toMatch(/^dao_vote_req-1_/);
    expect(call?.args).toMatchObject({
      network: 'testnet',
      chainId: 'pandora-8',
      intent: {
        source: 'batch',
        summary: `Vote NO on proposal 3 ("Fix the borehole") of the group proposal list ${PROPOSALS} on testnet, from your account ${MEMBER}, with the reason "Too expensive".`,
        messages: [
          {
            module: 'daodao',
            action: 'vote',
            typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          },
        ],
      },
      messages: [
        {
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: {
            sender: MEMBER,
            contract: PROPOSALS,
            msg: {
              vote: { proposal_id: 3, vote: 'no', rationale: 'Too expensive' },
            },
            funds: [],
          },
        },
      ],
      risks: riskOf('vote'),
    });

    bridge.answer({
      result: { success: true, transactionHash: TX_HASH, code: 0 },
    });
    await expect(pending).resolves.toEqual({
      status: 'signed',
      step: 'vote',
      network: 'testnet',
      chainId: 'pandora-8',
      transactionHash: TX_HASH,
      code: 0,
      message: expect.stringContaining('dao_proposals'),
    });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.content).toMatchObject({
      action: { name: 'sign_transaction', success: true },
    });
  });

  it('proposes through the group’s intake with the actions the group would take, and names them with their values in the summary', async () => {
    const bridge = fakeBridge();
    const propose = toolNamed(toolsFor(), 'create_dao_proposal');
    const send = {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: GROUP,
        toAddress: RECIPIENT,
        amount: [{ denom: 'uixo', amount: '5000000' }],
      },
    };
    const args = {
      intake: INTAKE,
      title: 'Fix the pump',
      description: 'The group pays 5 IXO to the fixer',
      actions: [send],
    };

    await expect(
      propose.handler(
        args,
        memberContext(bridge.surface, 'testnet', undefined, SHOWN_REQUEST),
      ),
    ).resolves.toMatchObject({
      status: 'confirm',
      summary: `Create a group proposal on testnet through the group’s intake ${INTAKE}, from your account ${MEMBER}: title "Fix the pump"; description "The group pays 5 IXO to the fixer". If it passes, the group’s own account does MsgSend (to address ${RECIPIENT}, amount 5000000 uixo).`,
      // The send's risk joins the proposal's: the user accepts both.
      risks: [...riskOf('propose'), ...SEND_RISKS],
    });

    const pending = propose.handler(
      {
        ...args,
        riskConfirmation: {
          confirmed: true,
          acceptedRisks: [...riskOf('propose'), ...SEND_RISKS],
        },
      },
      memberContext(bridge.surface),
    );
    await dispatched(bridge);
    expect(sentArgs(bridge)).toMatchObject({
      risks: [...riskOf('propose'), ...SEND_RISKS],
      riskLevel: 'high',
    });
    expect(sentArgs(bridge).messages).toEqual([
      {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: {
          sender: MEMBER,
          contract: INTAKE,
          msg: {
            propose: {
              msg: {
                propose: {
                  title: 'Fix the pump',
                  description: 'The group pays 5 IXO to the fixer',
                  msgs: [
                    { stargate: { type_url: send.typeUrl, value: send.value } },
                  ],
                },
              },
            },
          },
          funds: [],
        },
      },
    ]);
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
    await expect(pending).resolves.toMatchObject({
      status: 'signed',
      step: 'propose',
    });
  });

  it('refuses a proposal action the group cannot take: one that names someone else as its actor', async () => {
    const propose = toolNamed(toolsFor(), 'create_dao_proposal');
    await expect(
      propose.handler(
        {
          intake: INTAKE,
          title: 'Pay me',
          description: 'From my own account',
          actions: [
            {
              typeUrl: '/cosmos.bank.v1beta1.MsgSend',
              value: {
                fromAddress: MEMBER,
                toAddress: RECIPIENT,
                amount: [{ denom: 'uixo', amount: '1' }],
              },
            },
          ],
        },
        memberContext(fakeBridge().surface),
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/The group itself carries out the action/),
    });
  });

  it('carries out a passed proposal and closes a rejected one, by its list and number', async () => {
    for (const step of ['execute', 'close'] as const) {
      stubChain(() =>
        json(
          proposalAnswer(
            { status: step === 'execute' ? 'passed' : 'rejected' },
            12,
          ),
        ),
      );
      const bridge = fakeBridge();
      const tool = toolNamed(toolsFor(), `${step}_dao_proposal`);
      const args = {
        proposalModule: PROPOSALS,
        proposalId: 12,
        riskConfirmation: accept(step),
      };
      await showFirst(tool, args);
      const pending = tool.handler(args, memberContext(bridge.surface));
      await dispatched(bridge);
      expect(sentArgs(bridge).messages[0]?.value).toEqual({
        sender: MEMBER,
        contract: PROPOSALS,
        msg: { [step]: { proposal_id: 12 } },
        funds: [],
      });
      expect(sentArgs(bridge).intent).toMatchObject({
        summary: expect.stringContaining(
          `${step === 'execute' ? 'Carry out the passed' : 'Close the rejected'} proposal 12 ("Fix the borehole")`,
        ),
      });
      bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
      await expect(pending).resolves.toMatchObject({ status: 'signed', step });
    }
  });

  it('explains a vote the group refuses: a non-member’s, on chain or in the wallet’s simulation', async () => {
    stubChain(() => json(proposalAnswer()));
    const vote = toolNamed(toolsFor(), 'vote_on_dao_proposal');
    const args = {
      proposalModule: PROPOSALS,
      proposalId: 3,
      vote: 'yes',
      riskConfirmation: accept('vote'),
    };
    const notMember =
      'failed to execute message; message index: 0: Not registered to vote (no voting power) at time of proposal creation.: execute wasm contract failed';

    const onChain = fakeBridge();
    await showFirst(vote, args);
    const delivered = vote.handler(args, memberContext(onChain.surface));
    await dispatched(onChain);
    onChain.answer({
      result: {
        success: true,
        delivered: { code: 5, transactionHash: TX_HASH, height: 9 },
        error: notMember,
      },
    });
    await expect(delivered).resolves.toMatchObject({
      status: 'failed',
      step: 'vote',
      code: 5,
      error: notMember,
      hint: expect.stringMatching(/Only members of the group vote/),
    });

    const simulated = fakeBridge();
    // A preview is spent by its signing: the retry is shown again first.
    await showFirst(vote, args);
    const refused = vote.handler(args, memberContext(simulated.surface));
    await dispatched(simulated);
    simulated.answer({ error: notMember });
    await expect(refused).resolves.toMatchObject({
      status: 'error',
      hint: expect.stringMatching(/Only members of the group vote/),
      message: expect.stringContaining('Nothing was signed'),
    });
  });

  it('reports a timeout as an unknown outcome that keeps the write claim', async () => {
    stubChain(() => json(proposalAnswer()));
    const bridge = fakeBridge();
    const vote = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '30' }),
      'vote_on_dao_proposal',
    );
    const args = {
      proposalModule: PROPOSALS,
      proposalId: 3,
      vote: 'abstain',
      riskConfirmation: accept('vote'),
    };
    await showFirst(vote, args);
    const result = await vote.handler(args, memberContext(bridge.surface));
    expect(result).toMatchObject({ status: 'timeout', outcome: 'unknown' });
    expect(uncertainResultReason(asToolMessage(result))).toBe(
      'outcome unknown',
    );
  });
});

/** The tool `name`'s preview of `args` on proposal 3 (no riskConfirmation). */
async function preview(name: string, args: Record<string, unknown> = {}) {
  const bridge = fakeBridge();
  const result = await toolNamed(toolsFor(), name).handler(
    { proposalModule: PROPOSALS, proposalId: 3, ...args },
    memberContext(bridge.surface),
  );
  expect(bridge.calls).toEqual([]);
  return result;
}

describe('the DAO DAO step tools: the proposal is checked on chain first', () => {
  it('refuses to carry out an open proposal of a group that lets votes change, saying it passes when voting closes', async () => {
    stubChain(() => json(proposalAnswer()));
    await expect(preview('execute_dao_proposal')).resolves.toEqual({
      status: 'refused',
      step: 'execute',
      retryable: false,
      message:
        'Nothing was sent: proposal 3 ("Fix the borehole") cannot be carried out yet. Proposal 3 ("Fix the borehole") is open for votes. Votes so far: 1 yes, 0 no, 0 abstain, of 3 voting power; it needs 1 yes vote to pass. Voting closes at 2099-01-01 00:00 UTC. The group lets members change their votes until voting closes, so DAO DAO decides a proposal only when voting closes, even once enough members voted yes: it already has enough yes votes, so it will pass when voting closes at 2099-01-01 00:00 UTC and can be carried out then.',
    });
  });

  it('says what an open proposal still needs, with and without vote changes', async () => {
    stubChain(() =>
      json(
        proposalAnswer({
          threshold: { absolute_count: { threshold: '2' } },
        }),
      ),
    );
    await expect(preview('execute_dao_proposal')).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(
        /needs 2 yes votes to pass\..*it passes if it has enough yes votes when voting closes at 2099-01-01 00:00 UTC\.$/,
      ),
    });
    stubChain(() =>
      json(
        proposalAnswer({
          allow_revoting: false,
          threshold: { absolute_count: { threshold: '2' } },
        }),
      ),
    );
    await expect(preview('execute_dao_proposal')).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(
        /It passes as soon as enough members vote yes\.$/,
      ),
    });
  });

  it.each([
    [
      'execute_dao_proposal',
      'rejected',
      /did not pass, so it cannot be carried out; it can be closed instead/,
    ],
    ['execute_dao_proposal', 'closed', /did not pass and is already closed/],
    ['execute_dao_proposal', 'executed', /was already carried out/],
    [
      'execute_dao_proposal',
      'execution_failed',
      /its actions failed; DAO DAO does not run a proposal again/,
    ],
    [
      'close_dao_proposal',
      'open',
      /cannot be closed while it is open: only a proposal that did not pass can be closed.*It is decided when voting closes\.$/,
    ],
    [
      'close_dao_proposal',
      'passed',
      /passed, so it cannot be closed; it can be carried out instead/,
    ],
    ['close_dao_proposal', 'closed', /is already closed/],
    [
      'close_dao_proposal',
      'executed',
      /was carried out, so there is nothing to close/,
    ],
    [
      'close_dao_proposal',
      'execution_failed',
      /its actions failed; that is final and it cannot be closed/,
    ],
  ] as const)(
    '%s refuses a proposal that is %s',
    async (name, status, expected) => {
      stubChain(() => json(proposalAnswer({ status })));
      await expect(preview(name)).resolves.toEqual({
        status: 'refused',
        step: name === 'execute_dao_proposal' ? 'execute' : 'close',
        retryable: false,
        message: expect.stringMatching(expected),
      });
    },
  );

  it('refuses a vote once voting closed, and warns on a decided proposal still open for votes', async () => {
    stubChain(() =>
      json(proposalAnswer({ status: 'passed', expiration: atTime(CLOSED_AT) })),
    );
    await expect(
      preview('vote_on_dao_proposal', { vote: 'no' }),
    ).resolves.toEqual({
      status: 'refused',
      step: 'vote',
      retryable: false,
      message: expect.stringMatching(
        /^Nothing was sent: voting on proposal 3 \("Fix the borehole"\) closed at 2020-01-01 00:00 UTC, so the group no longer takes votes on it\. .* Voting closed at 2020-01-01 00:00 UTC\.$/,
      ),
    });

    // DAO DAO records a vote until voting closes, even on a decided proposal.
    stubChain(() =>
      json(proposalAnswer({ status: 'passed', allow_revoting: false })),
    );
    await expect(
      preview('vote_on_dao_proposal', { vote: 'no' }),
    ).resolves.toMatchObject({
      status: 'confirm',
      message: expect.stringContaining(
        'Its result is already decided (passed (not carried out yet)): DAO DAO still records a vote until voting closes at 2099-01-01 00:00 UTC, but the vote cannot change the result.',
      ),
    });
  });

  it('describes a percentage threshold without claiming it is met', async () => {
    stubChain(() =>
      json(
        proposalAnswer({
          threshold: {
            absolute_percentage: { percentage: { majority: {} } },
          },
        }),
      ),
    );
    await expect(preview('execute_dao_proposal')).resolves.toMatchObject({
      message: expect.stringMatching(
        /it needs more than half of the voting power \(abstentions aside\) to vote yes\..*it passes if it has enough yes votes when voting closes/,
      ),
    });
  });

  it('says a proposal the chain does not have is not there, and never guesses when the chain cannot be read', async () => {
    stubChain(() =>
      json(
        {
          code: 2,
          message:
            'codespace wasm code 9: query wasm contract failed: dao_proposal_single::proposal::SingleChoiceProposal not found',
          details: [],
        },
        500,
      ),
    );
    await expect(preview('execute_dao_proposal')).resolves.toEqual({
      status: 'refused',
      step: 'execute',
      retryable: false,
      message: `Nothing was sent: the chain has no proposal 3 in the proposal list ${PROPOSALS} (The contract refused the query: dao_proposal_single::proposal::SingleChoiceProposal not found). Check the proposalModule and the proposal id with chain_lookup dao_proposals.`,
    });

    const urls = stubChain(() => json({ error: 'busy' }, 503));
    await expect(
      preview('vote_on_dao_proposal', { vote: 'yes' }),
    ).resolves.toEqual({
      status: 'refused',
      step: 'vote',
      retryable: true,
      message: expect.stringMatching(
        /^Nothing was sent: proposal 3 could not be read from the chain to check that it can be voted on \(The chain node is unavailable right now \(HTTP 503\)\.\) Try again in a moment\.$/,
      ),
    });
    // The read's one retry, never more.
    expect(urls.length).toBeLessThanOrEqual(2);
  });

  it('refuses an answer that is not a single-choice proposal', async () => {
    stubChain(() =>
      json({ data: { id: 3, proposal: { title: 'Pick one', choices: [] } } }),
    );
    await expect(preview('close_dao_proposal')).resolves.toMatchObject({
      status: 'refused',
      retryable: false,
      message: expect.stringContaining(
        'It may not be a single-choice DAO DAO proposal',
      ),
    });
  });

  it('reads the proposal again right before sending, and sends nothing when it changed', async () => {
    const urls = stubChain((n) =>
      json(proposalAnswer({ status: n === 0 ? 'passed' : 'executed' })),
    );
    const bridge = fakeBridge();
    const execute = toolNamed(toolsFor(), 'execute_dao_proposal');
    const args = { proposalModule: PROPOSALS, proposalId: 3 };
    await expect(
      execute.handler(args, memberContext(bridge.surface)),
    ).resolves.toMatchObject({ status: 'confirm' });
    await expect(
      execute.handler(
        { ...args, riskConfirmation: accept('execute') },
        memberContext(bridge.surface, 'testnet', undefined, 'req-2'),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/was already carried out/),
    });
    expect(urls).toHaveLength(2);
    expect(bridge.calls).toEqual([]);
  });

  it('checks the confirmation and the way to the wallet before reading anything', async () => {
    const urls = stubChain(() => json(proposalAnswer({ status: 'passed' })));
    const execute = toolNamed(toolsFor(), 'execute_dao_proposal');
    const args = { proposalModule: PROPOSALS, proposalId: 3 };
    await expect(
      execute.handler(
        { ...args, riskConfirmation: { confirmed: true, acceptedRisks: [] } },
        memberContext(fakeBridge().surface),
      ),
    ).resolves.toMatchObject({ status: 'validation_error' });
    await expect(
      execute.handler(
        { ...args, riskConfirmation: accept('execute') },
        memberContext(fakeBridge({ connected: false }).surface),
      ),
    ).resolves.toMatchObject({ status: 'unavailable' });
    expect(urls).toEqual([]);
  });

  it('proposes without reading anything: there is no proposal yet', async () => {
    const urls = stubChain(() => json({}, 500));
    await expect(
      toolNamed(toolsFor(), 'create_dao_proposal').handler(
        { intake: INTAKE, title: 'Fix the pump', description: 'Pay the fixer' },
        memberContext(fakeBridge().surface),
      ),
    ).resolves.toMatchObject({ status: 'confirm' });
    expect(urls).toEqual([]);
  });
});

describe('the DAO DAO step tools: the wallet’s reason reaches the user', () => {
  /** Send a confirmed close of a rejected proposal; the wallet answers `answer`. */
  async function closeAnswered(answer: { result?: unknown; error?: string }) {
    stubChain(() => json(proposalAnswer({ status: 'rejected' })));
    const bridge = fakeBridge();
    const close = toolNamed(toolsFor(), 'close_dao_proposal');
    const args = {
      proposalModule: PROPOSALS,
      proposalId: 3,
      riskConfirmation: accept('close'),
    };
    await showFirst(close, args);
    const pending = close.handler(args, memberContext(bridge.surface));
    await dispatched(bridge);
    bridge.answer(answer);
    return pending;
  }

  it('passes the simulation’s contract error on as `error` with a plain hint, never as the user’s refusal', async () => {
    // The wallet's simulation of a close the proposal no longer allows: the
    // chain's words carry "rejected", and are still not the user's refusal.
    const simulated =
      "Query failed with (6): rpc error: code = Unknown desc = failed to execute message; message index: 0: only rejected proposals may be closed: execute wasm contract failed [CosmWasm/wasmd@v0.53.0/x/wasm/keeper/keeper.go:433] with gas used: '154303': unknown request";
    await expect(
      closeAnswered({ result: { success: false, error: simulated } }),
    ).resolves.toEqual({
      status: 'error',
      step: 'close',
      network: 'testnet',
      error: simulated,
      hint: expect.stringMatching(
        /^Only a proposal that did not pass can be closed/,
      ),
      message: expect.stringContaining(
        'Tell the user that reason in plain words',
      ),
    });
  });

  it('still reads the user declining in the Portal as rejected', async () => {
    await expect(
      closeAnswered({
        result: {
          success: false,
          error:
            'The user rejected the transaction in the Portal; nothing was signed',
        },
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      message: expect.stringContaining('The user declined it'),
    });
  });

  it('bounds a long wallet error to one line', async () => {
    const long = `failed to execute message; message index: 0: proposal is not in 'passed' state\n${'x'.repeat(5_000)}`;
    const result = await closeAnswered({ error: long });
    expect(result).toMatchObject({ status: 'error' });
    if (
      typeof result !== 'object' ||
      result === null ||
      !('error' in result) ||
      typeof result.error !== 'string'
    )
      throw new Error('expected an error');
    expect(result.error).toHaveLength(WALLET_ERROR_MAX_CHARS);
    expect(result.error).not.toContain('\n');
    expect(result.error.startsWith('failed to execute message')).toBe(true);
  });
});

describe('daoStepHint', () => {
  // The texts of DAO DAO 2.0.3 (dao-contracts tag v2.0.3:
  // contracts/proposal/dao-proposal-single/src/error.rs,
  // packages/dao-pre-propose-base/src/error.rs), wrapped as the chain passes
  // them on.
  const wrapped = (text: string) =>
    `failed to execute message; message index: 0: ${text}: execute wasm contract failed`;

  it.each([
    [
      'vote',
      'not registered to vote (no voting power) at time of proposal creation',
      /Only members of the group vote/,
    ],
    [
      'propose',
      'You must be a member of this DAO (have voting power) to create a proposal',
      /Only members of the group can create proposals/,
    ],
    [
      'vote',
      'already voted. this proposal does not support revoting',
      /does not let a vote be changed/,
    ],
    [
      'vote',
      'already cast a vote with that option. change your vote to revote',
      /already cast this same vote/,
    ],
    ['vote', 'Proposal (3) is expired', /voting time is over/],
    [
      'execute',
      "proposal is not in 'passed' state",
      /Only a proposal that passed can be carried out/,
    ],
    [
      'close',
      'only rejected proposals may be closed',
      /Only a proposal that did not pass can be closed/,
    ],
    ['execute', 'unauthorized', /Only members of the group can carry out/],
    ['execute', 'no such proposal (3)', /no proposal with that number/],
    [
      'close',
      'dao_proposal_single::proposal::SingleChoiceProposal not found',
      /no proposal with that number/,
    ],
    [
      'propose',
      'the DAO is currently inactive, you cannot create proposals',
      /The group is paused/,
    ],
  ] as const)('%s: %s', (step, text, expected) => {
    expect(daoStepHint(step, wrapped(text))).toMatch(expected);
  });

  it('gives no hint for anything else', () => {
    expect(daoStepHint('vote', 'out of gas')).toBeUndefined();
    expect(daoStepHint('vote', 'Proposal is not open (3)')).toBeUndefined();
    // The SDK's own `unauthorized` is a signing problem, not the group's.
    expect(
      daoStepHint(
        'execute',
        'signature verification failed; please verify account number (12) and chain-id (devnet-1): unauthorized',
      ),
    ).toBeUndefined();
  });
});

/* ── create_dao_group ──────────────────────────────────────────────────── */

const CREATE_GROUP_RISKS = (() => {
  const spec = findMessageByRoute('daodao', 'create-group');
  if (!spec) throw new Error('no daodao create-group route');
  return spec.risks;
})();
const acceptGroup = {
  confirmed: true,
  acceptedRisks: CREATE_GROUP_RISKS,
};

/** Ten more checksummed accounts: with MEMBER and RECIPIENT, a full group. */
const MORE_MEMBERS = [
  'ixo1xycnzvf3xycnzvf3xycnzvf3xycnzvf3nlu02w',
  'ixo1xgeryv3jxgeryv3jxgeryv3jxgeryv3jzm62pc',
  'ixo1xvenxvenxvenxvenxvenxvenxvenxvenrtmtte',
  'ixo1xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5rmuwv9',
  'ixo1x56n2df4x56n2df4x56n2df4x56n2df4zta0xy',
  'ixo1xcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kn0m2dj',
  'ixo1xumnwdehxumnwdehxumnwdehxumnwdehjl6t8n',
  'ixo18qurswpc8qurswpc8qurswpc8qurswpca8glr2',
  'ixo18yunjwfe8yunjwfe8yunjwfe8yunjwfeuhf7ft',
  'ixo18gar5w368gar5w368gar5w368gar5w36dn0mza',
];

/** A group as the user asked for it in the chat. */
const BOREHOLE_GROUP = {
  name: 'Borehole fund',
  members: [MEMBER, RECIPIENT],
  threshold: 1,
  votingPeriodSeconds: 3_600,
  allowRevoting: false,
};

/**
 * A group creation transaction read back from devnet REST
 * (`/cosmos/tx/v1beta1/txs/BB3290…`, height 16270387, Nov 9 2026): one
 * `dao_core` instantiate with three members, threshold 1, 7 days and vote
 * changes allowed, and the `instantiate` events of the core and its four
 * modules. Trimmed to the body's messages and the response.
 */
const DEVNET_GROUP = {
  txHash: devnetGroupTx.tx_response.txhash,
  creator: 'ixo1pe3q5htqe02p7x7etqastvl0kn37k6xepn0f4r',
  group: {
    name: 'Neighbourhood Book Club Board',
    members: [
      'ixo1pe3q5htqe02p7x7etqastvl0kn37k6xepn0f4r',
      'ixo1l7mn02nsvn02crx3ltsgpy50fv2lujrd229x8a',
      'ixo1ez640txp6rjr2wr7ymxaxykjrkns6lqxwdasce',
    ],
    threshold: 1,
  },
  core: 'ixo1add3jw5qcm3pvcywy2mhhxcw50s40pm0hyenarvpmy5p3t65ey0q906c48',
  proposalModule:
    'ixo1xkc0ae977n8eavdmgv2pc0anvy9u4q0ulcuv4kajjemr7rpgzhpsa7p539',
  intake: 'ixo1z44y9ppqh2ev8wpwje80h97etfadws8hcxle2mj64d48rulp42xqfvys0s',
};

/** Sign `args` with create_dao_group as `did` on devnet, answering the wallet with `answer`. */
async function signGroup(
  args: Record<string, unknown>,
  answer: { result?: unknown; error?: string },
  did = `did:ixo:${DEVNET_GROUP.creator}`,
) {
  const bridge = fakeBridge();
  const create = toolNamed(toolsFor(), 'create_dao_group');
  await showFirst(create, args, 'devnet', did);
  const pending = create.handler(
    { ...args, riskConfirmation: acceptGroup },
    memberContext(bridge.surface, 'devnet', did),
  );
  await dispatched(bridge);
  bridge.answer(answer);
  return { bridge, result: await pending };
}

describe('create_dao_group: confirm first, nothing sent', () => {
  it('answers the exact group, its summary in plain words and the catalog risks, and sends and reads nothing', async () => {
    const urls = stubChain(() => json({}));
    const bridge = fakeBridge();
    const create = toolNamed(toolsFor(), 'create_dao_group');

    const result = await create.handler(
      { ...BOREHOLE_GROUP, description: 'Pays for the village borehole' },
      memberContext(bridge.surface),
    );

    expect(result).toEqual({
      status: 'confirm',
      network: 'testnet',
      ...BOREHOLE_GROUP,
      description: 'Pays for the village borehole',
      summary: `Create the DAO DAO group "Borehole fund" on testnet from your account ${MEMBER}: a DAO DAO multisig of 2 members, one vote each: ${MEMBER}, ${RECIPIENT}. A proposal needs 1 yes vote; voting lasts 1 hour. It passes as soon as it has them, and votes cannot be changed. You are a member.`,
      risks: CREATE_GROUP_RISKS,
      message: expect.stringMatching(
        /^Nothing was sent\. Show the user this group exactly .*call create_dao_group again with the same fields and riskConfirmation/,
      ),
    });
    expect(bridge.calls).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('defaults to the Portal’s voting rules (7 days, vote changes allowed) and says so', async () => {
    const result = await toolNamed(toolsFor(), 'create_dao_group').handler(
      { name: 'Borehole fund', members: [MEMBER], threshold: 1 },
      memberContext(fakeBridge().surface),
    );
    expect(result).toMatchObject({
      status: 'confirm',
      votingPeriodSeconds: DAODAO_VOTING_PERIOD_SECONDS.default,
      allowRevoting: true,
      description: '',
      summary: expect.stringContaining(
        'A proposal needs 1 yes vote; voting lasts 7 days. Votes can be changed until it ends, so a proposal passes only then.',
      ),
    });
  });

  it('fits the wallet’s summary at the bounds: 12 members, a 64-character name, a voting time in seconds', async () => {
    const members = [MEMBER, RECIPIENT, ...MORE_MEMBERS];
    expect(members).toHaveLength(12);
    const preview = await toolNamed(toolsFor(), 'create_dao_group').handler(
      {
        name: 'N'.repeat(DAODAO_MAX_NAME_LENGTH),
        members,
        threshold: 12,
        votingPeriodSeconds: DAODAO_VOTING_PERIOD_SECONDS.max - 1,
      },
      memberContext(fakeBridge().surface),
    );
    // A summary past the wallet's bound is refused by the catalog, so the
    // preview itself shows it fits; every member is in it.
    const { summary } = z
      .object({ status: z.literal('confirm'), summary: z.string() })
      .parse(preview);
    expect(summary).toContain('12 yes votes; voting lasts 2591999 seconds');
    for (const member of members) expect(summary).toContain(member);
    expect(summary.length).toBeLessThanOrEqual(MAX_BATCH_SUMMARY_LENGTH);
  });

  it('refuses a group the user is not a member of, naming their account', async () => {
    const bridge = fakeBridge();
    const result = await toolNamed(toolsFor(), 'create_dao_group').handler(
      { ...BOREHOLE_GROUP, members: [RECIPIENT, MORE_MEMBERS[0]] },
      memberContext(bridge.surface),
    );
    expect(result).toEqual({
      status: 'validation_error',
      error: expect.stringMatching(
        new RegExp(
          `^Nothing was sent: your own account ${MEMBER} is not one of the members\\.`,
        ),
      ),
    });
    expect(bridge.calls).toEqual([]);
  });

  it('refuses a member listed twice, a threshold out of bounds, bad addresses, too many members and a bad name or voting time', async () => {
    const create = toolNamed(toolsFor(), 'create_dao_group');
    const ctx = memberContext(fakeBridge().surface);
    const refused = async (over: Record<string, unknown>, error: RegExp) =>
      expect(
        create.handler({ ...BOREHOLE_GROUP, ...over }, ctx),
      ).resolves.toEqual({
        status: 'validation_error',
        error: expect.stringMatching(error),
      });

    await refused(
      { members: [MEMBER, RECIPIENT, MEMBER] },
      new RegExp(`members\\.2: ${MEMBER} is listed twice`),
    );
    await refused(
      { threshold: 3 },
      /threshold: A proposal can need at most as many yes votes as the group has members \(2\)/,
    );
    await refused({ threshold: 0 }, /threshold: /);
    // A typo in the checksum, a contract (32-byte) address, another prefix.
    await refused(
      { members: [MEMBER, `${RECIPIENT.slice(0, -1)}q`] },
      /members\.1: .*valid checksum/,
    );
    await refused({ members: [MEMBER, GROUP] }, /members\.1: .*20-byte/);
    await refused(
      { members: [MEMBER, 'cosmos1qgpqyqszqgpqyqszqgpqyqszqgpqyqszrh8mx2'] },
      /members\.1: /,
    );
    await refused(
      {
        members: [
          MEMBER,
          RECIPIENT,
          ...MORE_MEMBERS,
          'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0',
        ],
      },
      /members: /,
    );
    await refused({ members: [] }, /members: /);
    await refused({ name: 'N'.repeat(DAODAO_MAX_NAME_LENGTH + 1) }, /name: /);
    await refused({ name: 'Borehole\nfund' }, /one line/);
    await refused(
      { votingPeriodSeconds: DAODAO_VOTING_PERIOD_SECONDS.min - 1 },
      /votingPeriodSeconds: /,
    );
    await refused(
      { votingPeriodSeconds: DAODAO_VOTING_PERIOD_SECONDS.max + 1 },
      /votingPeriodSeconds: /,
    );
  });

  it('refuses a user without an IXO account, and mainnet unless the oracle allows it', async () => {
    const bridge = fakeBridge();
    await expect(
      toolNamed(toolsFor(), 'create_dao_group').handler(
        BOREHOLE_GROUP,
        memberContext(bridge.surface, 'testnet', USER_DID),
      ),
    ).resolves.toEqual({
      status: 'unavailable',
      error: expect.stringMatching(/not an IXO account/),
    });
    await expect(
      toolNamed(toolsFor(), 'create_dao_group').handler(
        BOREHOLE_GROUP,
        memberContext(bridge.surface, 'mainnet'),
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(
        /IXO_TRANSACTION_ALLOW_MAINNET.*no group is created here/,
      ),
    });
    await expect(
      toolNamed(
        toolsFor({ IXO_TRANSACTION_ALLOW_MAINNET: 'true' }),
        'create_dao_group',
      ).handler(BOREHOLE_GROUP, memberContext(bridge.surface, 'mainnet')),
    ).resolves.toMatchObject({ status: 'confirm', network: 'mainnet' });
    expect(bridge.calls).toEqual([]);
  });

  it('refuses a confirmation that misses a risk or is not confirmed, and sends nothing', async () => {
    const bridge = fakeBridge();
    const create = toolNamed(toolsFor(), 'create_dao_group');
    for (const [riskConfirmation, error] of [
      [
        { confirmed: true, acceptedRisks: CREATE_GROUP_RISKS.slice(1) },
        /Risk confirmation required/,
      ],
      [
        { confirmed: false, acceptedRisks: CREATE_GROUP_RISKS },
        /riskConfirmation\.confirmed: /,
      ],
    ] as const)
      await expect(
        create.handler(
          { ...BOREHOLE_GROUP, riskConfirmation },
          memberContext(bridge.surface),
        ),
      ).resolves.toEqual({
        status: 'validation_error',
        error: expect.stringMatching(error),
      });
    expect(bridge.calls).toEqual([]);
  });
});

describe('create_dao_group: the wallet round trip and the group read back', () => {
  it('sends one dao_core instantiate built from the fields, with its summary, and accepts risks quoted with plain apostrophes', async () => {
    stubChain(() => json({}, 404));
    const bridge = fakeBridge();
    // Long enough for the checks below to run before the wallet answers.
    const create = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '5000' }),
      'create_dao_group',
    );
    await showFirst(create, BOREHOLE_GROUP);
    const pending = create.handler(
      {
        ...BOREHOLE_GROUP,
        riskConfirmation: {
          confirmed: true,
          // The catalog writes group’s; the model typed group's.
          acceptedRisks: CREATE_GROUP_RISKS.map((risk) =>
            risk.replace(/’/g, "'"),
          ),
        },
      },
      memberContext(bridge.surface),
    );
    await dispatched(bridge);

    const [call] = bridge.calls;
    expect(call?.toolName).toBe('sign_transaction');
    expect(call?.toolCallId).toMatch(/^dao_create_group_req-1_/);
    const sent = sentArgs(bridge);
    expect(sent).toMatchObject({
      network: 'testnet',
      chainId: 'pandora-8',
      intent: {
        source: 'batch',
        summary: expect.stringMatching(
          /^Create the DAO DAO group "Borehole fund" on testnet/,
        ),
        messages: [
          {
            module: 'daodao',
            action: 'create-group',
            typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
          },
        ],
      },
      risks: CREATE_GROUP_RISKS,
    });
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]).toMatchObject({
      typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
      value: {
        sender: MEMBER,
        admin: MEMBER,
        codeId: '3',
        funds: [],
        msg: {
          name: 'Borehole fund',
          description: '',
          voting_module_instantiate_info: {
            code_id: 20,
            msg: {
              initial_members: [
                { addr: MEMBER, weight: 1 },
                { addr: RECIPIENT, weight: 1 },
              ],
            },
          },
          proposal_modules_instantiate_info: [
            {
              code_id: 16,
              msg: {
                allow_revoting: false,
                max_voting_period: { time: 3_600 },
                threshold: { absolute_count: { threshold: '1' } },
              },
            },
          ],
        },
      },
    });
    bridge.answer({ error: 'Request rejected by user' });
    await expect(pending).resolves.toMatchObject({ status: 'rejected' });
  });

  it('reads the new group, its proposal list and its intake back from the transaction', async () => {
    const urls = stubChain(() => json(devnetGroupTx));
    const { result } = await signGroup(DEVNET_GROUP.group, {
      result: {
        success: true,
        transactionHash: DEVNET_GROUP.txHash,
        code: 0,
      },
    });

    expect(result).toEqual({
      status: 'created',
      network: 'devnet',
      name: DEVNET_GROUP.group.name,
      txHash: DEVNET_GROUP.txHash,
      coreAddress: DEVNET_GROUP.core,
      proposalModule: DEVNET_GROUP.proposalModule,
      intake: DEVNET_GROUP.intake,
      message: expect.stringMatching(
        /pass `intake` to create_dao_proposal and `proposalModule` to vote_on_dao_proposal/,
      ),
    });
    expect(urls).toEqual([
      `https://devnet.ixo.earth/rest/cosmos/tx/v1beta1/txs/${DEVNET_GROUP.txHash}`,
    ]);
  });

  it('leaves out an address the transaction does not name exactly once, and says where to read it', async () => {
    // The intake's (code 13) instantiate event is missing.
    const events = devnetGroupTx.tx_response.events.filter(
      (event) =>
        !(
          event.type === 'instantiate' &&
          event.attributes.some(
            (attr) => attr.key === 'code_id' && attr.value === '13',
          )
        ),
    );
    expect(events.length).toBe(devnetGroupTx.tx_response.events.length - 1);
    stubChain(() =>
      json({
        ...devnetGroupTx,
        tx_response: { ...devnetGroupTx.tx_response, events },
      }),
    );
    const { result } = await signGroup(DEVNET_GROUP.group, {
      result: { success: true, transactionHash: DEVNET_GROUP.txHash },
    });
    expect(result).toEqual({
      status: 'created',
      network: 'devnet',
      name: DEVNET_GROUP.group.name,
      txHash: DEVNET_GROUP.txHash,
      coreAddress: DEVNET_GROUP.core,
      proposalModule: DEVNET_GROUP.proposalModule,
      message: expect.stringMatching(
        /read them with chain_lookup daos before creating a proposal/,
      ),
    });
  });

  it('answers created without an address, never resending, when the transaction is not readable or not the group', async () => {
    const signed = {
      result: { success: true, transactionHash: DEVNET_GROUP.txHash },
    };
    // The node answers another transaction: not readable, not retried.
    stubChain(() =>
      json({
        ...devnetGroupTx,
        tx_response: { ...devnetGroupTx.tx_response, txhash: 'C'.repeat(64) },
      }),
    );
    const unreadable = await signGroup(DEVNET_GROUP.group, signed);
    expect(unreadable.result).toEqual({
      status: 'created',
      network: 'devnet',
      name: DEVNET_GROUP.group.name,
      txHash: DEVNET_GROUP.txHash,
      message: expect.stringMatching(
        /address cannot be read yet\. .*Do not create the group again: chain_lookup daos lists it/,
      ),
    });
    expect(unreadable.bridge.calls).toHaveLength(1);

    // The transaction is a group of another name than the one sent.
    stubChain(() => json(devnetGroupTx));
    const other = await signGroup(
      { ...DEVNET_GROUP.group, name: 'Another board' },
      signed,
    );
    expect(other.result).toEqual({
      status: 'created',
      network: 'devnet',
      name: 'Another board',
      txHash: DEVNET_GROUP.txHash,
      message: expect.stringMatching(
        /its transaction does not show it \(That transaction is not the group this conversation sent/,
      ),
    });

    // No hash at all: nothing to read. (Another conversation: this one
    // already created that group, and creates it once.)
    conversation = createMemoryUserKv();
    const urls = stubChain(() => json(devnetGroupTx));
    const noHash = await signGroup(DEVNET_GROUP.group, {
      result: { success: true },
    });
    expect(noHash.result).toEqual({
      status: 'created',
      network: 'devnet',
      name: DEVNET_GROUP.group.name,
      message: expect.stringMatching(/returned no transaction hash/),
    });
    expect(urls).toEqual([]);
  });

  it('reports a failed transaction with its code, and a timeout as an unknown outcome that keeps the write claim', async () => {
    const urls = stubChain(() => json(devnetGroupTx));
    const { result: failed } = await signGroup(DEVNET_GROUP.group, {
      result: {
        success: true,
        delivered: {
          code: 11,
          transactionHash: DEVNET_GROUP.txHash,
          height: 9,
        },
        error: 'out of gas',
      },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      network: 'devnet',
      code: 11,
      transactionHash: DEVNET_GROUP.txHash,
      error: 'out of gas',
    });
    expect(failed).not.toHaveProperty('hint');

    // The failed transaction made no group: the same group can be sent again.
    const bridge = fakeBridge();
    const create = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '30' }),
      'create_dao_group',
    );
    await showFirst(
      create,
      DEVNET_GROUP.group,
      'devnet',
      `did:ixo:${DEVNET_GROUP.creator}`,
    );
    const timedOut = await create.handler(
      { ...DEVNET_GROUP.group, riskConfirmation: acceptGroup },
      memberContext(
        bridge.surface,
        'devnet',
        `did:ixo:${DEVNET_GROUP.creator}`,
      ),
    );
    expect(timedOut).toMatchObject({ status: 'timeout', outcome: 'unknown' });
    expect(uncertainResultReason(asToolMessage(timedOut))).toBe(
      'outcome unknown',
    );
    // Neither outcome reads the chain: there is no group to read.
    expect(urls).toEqual([]);
  });
});

/* ── what a proposal does, disclosed ──────────────────────────────────── */

const RETIRE_RISKS = findMessageByRoute('token', 'retire')?.risks ?? [];

/** A cw `CosmosMsg` stargate action as `dao-proposal-single` answers it: the protobuf, base64. */
function stargateSend(toAddress: string, amount: string) {
  return {
    stargate: {
      type_url: '/cosmos.bank.v1beta1.MsgSend',
      value: bytesToBase64(
        MsgSend.encode(
          MsgSend.fromPartial({
            fromAddress: GROUP,
            toAddress,
            amount: [{ denom: 'uixo', amount }],
          }),
          // An explicit array writer: workerd's Buffer polyfill breaks
          // protobufjs's default Buffer writer on strings.
          new protobuf.Writer(),
        ).finish(),
      ),
    },
  };
}

describe('the DAO DAO step tools: what a proposal does is disclosed', () => {
  it('refuses to sign a proposal until the risks of its actions are accepted too', async () => {
    const propose = toolNamed(toolsFor(), 'create_dao_proposal');
    const retire = {
      typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
      value: {
        owner: GROUP,
        tokens: [{ id: 'CARBON-1', amount: '10' }],
        jurisdiction: 'ZA',
        reason: 'Offset the pump diesel',
      },
    };
    const args = {
      intake: INTAKE,
      title: 'Offset the pump',
      description: 'The group retires 10 credits',
      actions: [retire],
    };
    await expect(
      propose.handler(
        args,
        memberContext(
          fakeBridge().surface,
          'testnet',
          undefined,
          SHOWN_REQUEST,
        ),
      ),
    ).resolves.toMatchObject({
      status: 'confirm',
      summary: expect.stringContaining(
        'If it passes, the group’s own account does MsgRetireToken (tokens 10 of token CARBON-1, jurisdiction ZA, reason Offset the pump diesel).',
      ),
      risks: [...riskOf('propose'), ...RETIRE_RISKS],
    });
    const bridge = fakeBridge();
    await expect(
      propose.handler(
        { ...args, riskConfirmation: accept('propose') },
        memberContext(bridge.surface),
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringContaining(
        `the user must accept, word for word, ${JSON.stringify(RETIRE_RISKS[0])}`,
      ),
    });
    expect(bridge.calls).toEqual([]);

    const pending = propose.handler(
      {
        ...args,
        riskConfirmation: {
          confirmed: true,
          acceptedRisks: [...riskOf('propose'), ...RETIRE_RISKS],
        },
      },
      memberContext(bridge.surface),
    );
    await dispatched(bridge);
    expect(sentArgs(bridge)).toMatchObject({
      riskLevel: 'critical',
      risks: [...riskOf('propose'), ...RETIRE_RISKS],
    });
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
    await expect(pending).resolves.toMatchObject({ status: 'signed' });
  });

  it('shows what carrying a proposal out does, action by action, and says plainly what it cannot read', async () => {
    const msgs = [
      stargateSend(RECIPIENT, '5000000'),
      { bank: { send: { to_address: RECIPIENT, amount: [] } } },
      {
        stargate: {
          type_url: '/cosmos.staking.v1beta1.MsgDelegate',
          value: 'AA==',
        },
      },
    ];
    stubChain(() => json(proposalAnswer({ status: 'passed', msgs })));
    const execute = toolNamed(toolsFor(), 'execute_dao_proposal');
    const send = `MsgSend (to address ${RECIPIENT}, amount 5000000 uixo)`;
    const cannotRead = (what: string) =>
      `an action this oracle cannot read (${what}): its effect is not shown here, so check it in the Portal’s Decisions tab before carrying the proposal out`;
    const summary = `Carry out the passed proposal 3 ("Fix the borehole") of the group proposal list ${PROPOSALS} on testnet, from your account ${MEMBER}: the group’s own account does its 3 actions: 1) ${send}; 2) ${cannotRead('a bank message')}; 3) ${cannotRead('a /cosmos.staking.v1beta1.MsgDelegate message')}.`;

    await expect(preview('execute_dao_proposal')).resolves.toEqual({
      status: 'confirm',
      network: 'testnet',
      summary,
      risks: [...riskOf('execute'), ...SEND_RISKS],
      proposal: expect.stringContaining('is passed (not carried out yet)'),
      actions: [
        send,
        cannotRead('a bank message'),
        cannotRead('a /cosmos.staking.v1beta1.MsgDelegate message'),
      ],
      message: expect.stringContaining('and every action it carries out'),
    });

    // The carry-out's own risk alone does not cover the send it makes.
    const bridge = fakeBridge();
    const args = { proposalModule: PROPOSALS, proposalId: 3 };
    await expect(
      execute.handler(
        { ...args, riskConfirmation: accept('execute') },
        memberContext(bridge.surface, 'testnet', undefined, 'req-2'),
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringContaining(JSON.stringify(SEND_RISKS[0])),
    });
    expect(bridge.calls).toEqual([]);

    await showFirst(execute, args);
    const pending = execute.handler(
      {
        ...args,
        riskConfirmation: {
          confirmed: true,
          acceptedRisks: [...riskOf('execute'), ...SEND_RISKS],
        },
      },
      memberContext(bridge.surface),
    );
    await dispatched(bridge);
    expect(sentArgs(bridge).intent).toMatchObject({ summary });
    bridge.answer({ result: { success: true, transactionHash: TX_HASH } });
    await expect(pending).resolves.toMatchObject({ status: 'signed' });
  });

  it('says a proposal without actions only gets marked carried out', async () => {
    stubChain(() => json(proposalAnswer({ status: 'passed' })));
    await expect(preview('execute_dao_proposal')).resolves.toMatchObject({
      status: 'confirm',
      summary: expect.stringMatching(
        /: it holds no actions, so carrying it out only marks it carried out\.$/,
      ),
      risks: riskOf('execute'),
      actions: [],
    });
  });

  it('names as many actions as the wallet’s summary holds and counts the rest', async () => {
    const msgs = Array.from({ length: 12 }, (_, index) =>
      stargateSend(RECIPIENT, String(1_000_000 + index)),
    );
    stubChain(() => json(proposalAnswer({ status: 'passed', msgs })));
    const result = z
      .object({ summary: z.string(), actions: z.array(z.string()) })
      .parse(await preview('execute_dao_proposal'));
    expect(result.actions).toHaveLength(12);
    expect(result.summary.length).toBeLessThanOrEqual(MAX_BATCH_SUMMARY_LENGTH);
    expect(result.summary).toMatch(
      /does its 12 actions: 1\) MsgSend .*; and \d+ more \(see the proposal in the Portal’s Decisions tab\)\.$/,
    );
  });
});

/* ── confirmed in a later message ─────────────────────────────────────── */

describe('the DAO DAO tools: signed only after a preview in an earlier request', () => {
  it('refuses to sign in the request that showed the step, or other fields than shown, and spends a preview on one signing', async () => {
    stubChain(() => json(proposalAnswer()));
    const vote = toolNamed(toolsFor(), 'vote_on_dao_proposal');
    const bridge = fakeBridge();
    const args = {
      proposalModule: PROPOSALS,
      proposalId: 3,
      vote: 'yes',
      riskConfirmation: accept('vote'),
    };
    await expect(
      vote.handler(
        args,
        memberContext(bridge.surface, 'testnet', undefined, 'req-1'),
      ),
    ).resolves.toEqual({
      status: 'refused',
      step: 'vote',
      retryable: false,
      message: expect.stringMatching(
        /^Nothing was sent: this exact vote_on_dao_proposal call \(the same fields\) was not shown to the user first/,
      ),
    });

    const { riskConfirmation: _accepted, ...shown } = args;
    await vote.handler(
      shown,
      memberContext(bridge.surface, 'testnet', undefined, 'req-1'),
    );
    await expect(
      vote.handler(
        args,
        memberContext(bridge.surface, 'testnet', undefined, 'req-1'),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(
        /^Nothing was sent: the summary was shown in this same turn\. .*wait for their reply in a new message/,
      ),
    });
    await expect(
      vote.handler(
        { ...args, vote: 'no' },
        memberContext(bridge.surface, 'testnet', undefined, 'req-2'),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('was not shown to the user first'),
    });
    expect(bridge.calls).toEqual([]);

    const pending = vote.handler(
      args,
      memberContext(bridge.surface, 'testnet', undefined, 'req-2'),
    );
    await dispatched(bridge);
    bridge.answer({ error: 'Request rejected by user' });
    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      message: expect.stringContaining(
        'call vote_on_dao_proposal again without riskConfirmation',
      ),
    });
    await expect(
      vote.handler(
        args,
        memberContext(bridge.surface, 'testnet', undefined, 'req-3'),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('its preview was already used'),
    });
    expect(bridge.calls).toHaveLength(1);
  });

  it('applies the same rule to a new group', async () => {
    const create = toolNamed(toolsFor(), 'create_dao_group');
    const bridge = fakeBridge();
    await create.handler(
      BOREHOLE_GROUP,
      memberContext(bridge.surface, 'testnet', undefined, 'req-1'),
    );
    await expect(
      create.handler(
        { ...BOREHOLE_GROUP, riskConfirmation: acceptGroup },
        memberContext(bridge.surface, 'testnet', undefined, 'req-1'),
      ),
    ).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: expect.stringContaining(
        'the summary was shown in this same turn',
      ),
    });
    await expect(
      create.handler(
        { ...BOREHOLE_GROUP, threshold: 2, riskConfirmation: acceptGroup },
        memberContext(bridge.surface, 'testnet', undefined, 'req-2'),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('was not shown to the user first'),
    });
    expect(bridge.calls).toEqual([]);
  });

  it('signs nothing on a host without a per-user store', async () => {
    const bridge = fakeBridge();
    const { kv: _kv, ...withoutStore } = memberContext(bridge.surface);
    for (const [name, args] of [
      ['create_dao_group', BOREHOLE_GROUP],
      ['close_dao_proposal', { proposalModule: PROPOSALS, proposalId: 3 }],
    ] as const)
      await expect(
        toolNamed(toolsFor(), name).handler(args, withoutStore),
      ).resolves.toEqual({
        status: 'unavailable',
        error: expect.stringContaining('ctx.kv'),
      });
    expect(bridge.calls).toEqual([]);
  });
});

/* ── a group is created once ──────────────────────────────────────────── */

describe('create_dao_group: the same group is sent once per conversation', () => {
  const creator = `did:ixo:${DEVNET_GROUP.creator}`;
  const devnetContext = (
    bridge: ReturnType<typeof fakeBridge>,
    requestId = 'req-1',
  ) => memberContext(bridge.surface, 'devnet', creator, requestId);

  it('refuses the group again once it was created, in the preview and in the signing', async () => {
    stubChain(() => json(devnetGroupTx));
    const { result } = await signGroup(DEVNET_GROUP.group, {
      result: { success: true, transactionHash: DEVNET_GROUP.txHash },
    });
    expect(result).toMatchObject({
      status: 'created',
      coreAddress: DEVNET_GROUP.core,
    });

    const create = toolNamed(toolsFor(), 'create_dao_group');
    const bridge = fakeBridge();
    const again = {
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: this exact group was already created in this conversation (${DEVNET_GROUP.core}), in transaction ${DEVNET_GROUP.txHash}; a group is created once. Tell the user; chain_lookup daos lists it among their groups (seconds behind). A different group needs different choices from the user.`,
    };
    await expect(
      create.handler(DEVNET_GROUP.group, devnetContext(bridge, 'req-2')),
    ).resolves.toEqual(again);
    await expect(
      create.handler(
        { ...DEVNET_GROUP.group, riskConfirmation: acceptGroup },
        devnetContext(bridge, 'req-3'),
      ),
    ).resolves.toEqual(again);
    expect(bridge.calls).toEqual([]);
  });

  it('holds a group whose answer was lost until its transaction is read back', async () => {
    const urls = stubChain(() => json(devnetGroupTx));
    const create = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '30' }),
      'create_dao_group',
    );
    await showFirst(create, DEVNET_GROUP.group, 'devnet', creator);
    await expect(
      create.handler(
        { ...DEVNET_GROUP.group, riskConfirmation: acceptGroup },
        devnetContext(fakeBridge()),
      ),
    ).resolves.toMatchObject({ status: 'timeout', outcome: 'unknown' });

    const bridge = fakeBridge();
    for (const args of [
      DEVNET_GROUP.group,
      { ...DEVNET_GROUP.group, riskConfirmation: acceptGroup },
    ])
      await expect(
        create.handler(args, devnetContext(bridge, 'req-2')),
      ).resolves.toEqual({
        status: 'refused',
        retryable: false,
        message: expect.stringMatching(
          /^Nothing was sent: this exact group was sent to the user’s wallet earlier in this conversation and its answer never arrived, so it may exist\. Do not send it again\. Check with chain_lookup daos .* call create_dao_group again with the same fields and txHash to read it back\. Only if neither shows it may this exact group be shown and sent again, after \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/,
        ),
      });
    expect(bridge.calls).toEqual([]);
    expect(urls).toEqual([]);

    // Read back by the hash from the user's wallet: nothing is sent.
    await expect(
      create.handler(
        { ...DEVNET_GROUP.group, txHash: DEVNET_GROUP.txHash },
        devnetContext(bridge, 'req-3'),
      ),
    ).resolves.toEqual({
      status: 'created',
      network: 'devnet',
      name: DEVNET_GROUP.group.name,
      txHash: DEVNET_GROUP.txHash,
      coreAddress: DEVNET_GROUP.core,
      proposalModule: DEVNET_GROUP.proposalModule,
      intake: DEVNET_GROUP.intake,
      message: expect.stringContaining('The group exists at coreAddress'),
    });
    expect(bridge.calls).toEqual([]);
    expect(urls).toHaveLength(1);
    await expect(
      create.handler(DEVNET_GROUP.group, devnetContext(bridge, 'req-4')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('was already created'),
    });
  });

  it('keeps the outcome unknown when the hash given is not the group, and reads a hash only for a lost answer', async () => {
    const create = toolNamed(
      toolsFor({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '30' }),
      'create_dao_group',
    );
    await expect(
      create.handler(
        { ...DEVNET_GROUP.group, txHash: DEVNET_GROUP.txHash },
        devnetContext(fakeBridge()),
      ),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(/^txHash only reads back this exact group/),
    });

    await showFirst(create, DEVNET_GROUP.group, 'devnet', creator);
    await create.handler(
      { ...DEVNET_GROUP.group, riskConfirmation: acceptGroup },
      devnetContext(fakeBridge()),
    );
    stubChain(() => json(devnetGroupTx));
    await expect(
      create.handler(
        {
          ...DEVNET_GROUP.group,
          name: DEVNET_GROUP.group.name,
          members: [...DEVNET_GROUP.group.members],
          txHash: DEVNET_GROUP.txHash,
          threshold: 1,
          votingPeriodSeconds: DAODAO_VOTING_PERIOD_SECONDS.default,
        },
        devnetContext(fakeBridge(), 'req-2'),
      ),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('lets a group the wallet declined or the chain failed be shown and sent again', async () => {
    const { result: declined } = await signGroup(DEVNET_GROUP.group, {
      error: 'Request rejected by user',
    });
    expect(declined).toMatchObject({
      status: 'rejected',
      message: expect.stringContaining(
        'call create_dao_group again without riskConfirmation',
      ),
    });
    const { result: failed } = await signGroup(DEVNET_GROUP.group, {
      result: {
        success: true,
        delivered: { code: 11, transactionHash: DEVNET_GROUP.txHash },
        error: 'out of gas',
      },
    });
    expect(failed).toMatchObject({ status: 'failed', code: 11 });
    stubChain(() => json(devnetGroupTx));
    const { result: created } = await signGroup(DEVNET_GROUP.group, {
      result: { success: true, transactionHash: DEVNET_GROUP.txHash },
    });
    expect(created).toMatchObject({ status: 'created' });
  });
});
