/**
 * The ixo-transaction plugin through the real runtime core, inside workerd:
 * boot-time config, the manifest, tool binding, the capability gate and the
 * write-claim ledger around a real turn (`createMainAgent` with a scripted
 * model). The wallet side is a fake AG-UI bridge over the real
 * `FrontendCallRegistry`.
 */
import {
  HumanMessage,
  type BaseMessage,
  type ToolMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { createRuntimeCore, type RuntimeCore } from '../../core';
import { createMainAgent } from '../../core/main-agent';
import {
  validateExamplesAgainstTools,
  validateManifest,
} from '../../core/manifest';
import { createToolExecutionMiddleware } from '../../core/middlewares/tool-execution';
import {
  createNoopAmbient,
  type AmbientServices,
} from '../../core/runtime-context';
import {
  makeBuildCtx,
  makeClaimStore,
  makeEnv,
} from '../../core/test-fixtures';
import { ToolScheduler } from '../../core/tool-scheduler';
import { TurnBudget } from '../../core/turn-budget';
import type {
  FrontendCallParams,
  FrontendCallSurface,
} from '../../plugin-api/types';
import { FrontendCallRegistry } from '../../realtime/frontend-call-registry';
import {
  DEFAULT_SIGN_TIMEOUT_MS,
  IxoTransactionPlugin,
  MAX_SIGN_TIMEOUT_MS,
} from './ixo-transaction.plugin';

const OWNER = 'ixo1qwertyuiopasdfghjklzxcvbnmqwerty12345';
const TOOL_NAMES = [
  'list_ixo_transaction_routes',
  'classify_ixo_transaction_intent',
  'validate_ixo_transaction_draft',
  'sign_ixo_transaction',
];

const USER_DID = 'did:ixo:user1';

const requestCtx = {
  user: {
    did: USER_DID,
    matrixUserId: '@did-ixo-user1:ixo.world',
    ucanDelegation: { raw: 'ucan' },
  },
  session: { id: 'sess-1', client: 'portal' as const, requestId: 'req-1' },
};

const retireDraft = {
  command: '/ixo token retire',
  value: {
    owner: OWNER,
    tokens: [{ id: 'CARBON-1', amount: '10' }],
    jurisdiction: 'ZA',
    reason: 'offset',
  },
  riskConfirmation: {
    confirmed: true,
    acceptedRisks: [
      'Permanently retires (burns) impact credits. Irreversible.',
    ],
  },
};

type Script = Array<
  Array<{ name: string; args: Record<string, unknown>; id: string }>
>;

function bootCore(env: Record<string, unknown> = {}): RuntimeCore {
  return createRuntimeCore({
    config: { name: 'TestOracle' },
    plugins: [new IxoTransactionPlugin()],
    env: makeEnv(env),
  });
}

/** A browser that never answers: every action call waits for its timeout. */
function silentBridge() {
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
      registry.dispatched(params.toolCallId, {
        sid: 'sid-portal-tab',
        sessionId: params.sessionId,
        userDid: USER_DID,
      });
      calls.push(params);
      return pending;
    },
    hasClient: () => true,
  };
  return { surface, calls };
}

function ambientFor(
  core: RuntimeCore,
  script: Script,
  frontend?: FrontendCallSurface,
): AmbientServices {
  return {
    ...createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm: { get: () => new FakeToolCallingModel({ toolCalls: script }) },
    }),
    ...(frontend ? { frontend } : {}),
  };
}

function toolMessages(messages: BaseMessage[]): Map<string, ToolMessage> {
  return new Map(
    messages
      .filter((m): m is ToolMessage => m.type === 'tool')
      .map((m) => [m.tool_call_id, m]),
  );
}

async function runTurn(
  core: RuntimeCore,
  script: Script,
  opts: {
    frontend?: FrontendCallSurface;
    claims?: ReturnType<typeof makeClaimStore>;
    runId?: string;
    threadId?: string;
  } = {},
) {
  const built = await createMainAgent({
    registries: core.registries,
    identity: core.identity,
    config: core.validatedEnv,
    availablePlugins: core.availablePlugins,
    ambient: ambientFor(core, script, opts.frontend),
    requestCtx,
    state: {},
    checkpointer: new MemorySaver(),
    ...(opts.claims
      ? {
          hooks: {
            toolExecution: createToolExecutionMiddleware({
              budget: new TurnBudget({
                tokens: 1_000_000,
                tools: 20,
                durationMs: 60_000,
              }),
              scheduler: new ToolScheduler(),
              laneOf: (name) =>
                built.subAgentToolNames.has(name)
                  ? 'subagent'
                  : (built.toolEffects.get(name) ?? 'write'),
              runId: opts.runId ?? 'run-1',
              sessionId: 'sess-1',
              claims: opts.claims.store,
            }),
          },
        }
      : {}),
  });
  const result = await built.agent.invoke(
    { messages: [new HumanMessage('Retire 10 of my carbon credits.')] },
    { configurable: { thread_id: opts.threadId ?? 'thread-1' } },
  );
  return { built, tools: toolMessages(result.messages) };
}

describe('IxoTransactionPlugin: identity, manifest and configuration', () => {
  it('has an on-demand manifest with no errors or soft-limit warnings', () => {
    const plugin = new IxoTransactionPlugin();
    expect(plugin.name).toBe('ixo-transaction');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(validateManifest(plugin.manifest, plugin.name)).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
  });

  it('contributes the four tools, and every manifest example names one with arguments its schema accepts', () => {
    const plugin = new IxoTransactionPlugin();
    const tools = plugin.getTools(makeBuildCtx());
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(
      validateExamplesAgainstTools(
        plugin.manifest,
        tools.map((t) => t.name),
        plugin.name,
      ).errors,
    ).toEqual([]);
    for (const example of plugin.manifest.examples ?? []) {
      const target = tools.find((t) => t.name === example.tool);
      expect(target?.schema.safeParse(example.args ?? {}).success).toBe(true);
    }
  });

  it('marks the discovery tools as reads and leaves the signing tool a write', () => {
    const effects = new IxoTransactionPlugin()
      .getTools(makeBuildCtx())
      .map((t) => [t.name, t.effect ?? 'write']);
    expect(effects).toEqual([
      ['list_ixo_transaction_routes', 'read'],
      ['classify_ixo_transaction_intent', 'read'],
      ['validate_ixo_transaction_draft', 'read'],
      ['sign_ixo_transaction', 'write'],
    ]);
  });

  it('boots with mainnet off, the verified chain ids and a 120 s signing timeout', () => {
    const core = bootCore();
    expect(core.validatedEnv.IXO_TRANSACTION_ALLOW_MAINNET).toBe('false');
    expect(core.validatedEnv.IXO_TRANSACTION_CHAIN_ID_DEVNET).toBe('devnet-1');
    expect(core.validatedEnv.IXO_TRANSACTION_CHAIN_ID_TESTNET).toBe(
      'pandora-8',
    );
    expect(core.validatedEnv.IXO_TRANSACTION_CHAIN_ID_MAINNET).toBe('ixo-5');
    expect(core.validatedEnv.IXO_TRANSACTION_SIGN_TIMEOUT_MS).toBe(
      DEFAULT_SIGN_TIMEOUT_MS,
    );
    expect(DEFAULT_SIGN_TIMEOUT_MS).toBe(120_000);
  });

  it('fails the boot on a non-boolean mainnet flag or a timeout above the cap', () => {
    expect(() => bootCore({ IXO_TRANSACTION_ALLOW_MAINNET: 'yes' })).toThrow(
      /Plugin 'ixo-transaction'.*'IXO_TRANSACTION_ALLOW_MAINNET'/,
    );
    expect(() =>
      bootCore({
        IXO_TRANSACTION_SIGN_TIMEOUT_MS: String(MAX_SIGN_TIMEOUT_MS + 1),
      }),
    ).toThrow(/Plugin 'ixo-transaction'.*'IXO_TRANSACTION_SIGN_TIMEOUT_MS'/);
  });

  it('declares no key material: its configuration is a flag, chain ids and a timeout', () => {
    const keys = Object.keys(new IxoTransactionPlugin().configSchema.shape);
    expect(keys).toEqual([
      'IXO_TRANSACTION_ALLOW_MAINNET',
      'IXO_TRANSACTION_CHAIN_ID_DEVNET',
      'IXO_TRANSACTION_CHAIN_ID_TESTNET',
      'IXO_TRANSACTION_CHAIN_ID_MAINNET',
      'IXO_TRANSACTION_SIGN_TIMEOUT_MS',
    ]);
    for (const key of keys) {
      expect(key).not.toMatch(
        /KEY|MNEMONIC|SECRET|PRIVATE|SEED|PASSWORD|TOKEN/,
      );
    }
  });
});

describe('IxoTransactionPlugin in a turn', () => {
  it('binds every tool but hides them until the capability is loaded', async () => {
    const core = bootCore();
    await core.warm();
    const bridge = silentBridge();

    const { built, tools } = await runTurn(
      core,
      [
        [
          {
            name: 'sign_ixo_transaction',
            args: retireDraft,
            id: 'c1',
          },
        ],
        [
          {
            name: 'load_capability',
            args: { names: ['ixo-transaction'] },
            id: 'c2',
          },
        ],
        [
          {
            name: 'validate_ixo_transaction_draft',
            args: retireDraft,
            id: 'c3',
          },
        ],
        [],
      ],
      { frontend: bridge.surface },
    );

    expect(built.boundToolNames).toEqual(expect.arrayContaining(TOOL_NAMES));
    expect(tools.get('c1')?.status).toBe('error');
    expect(String(tools.get('c1')?.content)).toContain(
      'belongs to the "ixo-transaction" capability, which is not loaded',
    );
    // Refused by the gate: nothing reached the wallet.
    expect(bridge.calls).toEqual([]);
    expect(JSON.parse(String(tools.get('c3')?.content))).toMatchObject({
      status: 'valid',
      message: { typeUrl: '/ixo.token.v1beta1.MsgRetireToken' },
      requiresConfirmation: true,
    });
  });

  it('does not dispatch an identical signing request in a later turn while a timeout left its outcome unknown', async () => {
    const core = bootCore({ IXO_TRANSACTION_SIGN_TIMEOUT_MS: '40' });
    await core.warm();
    const bridge = silentBridge();
    const claims = makeClaimStore();
    const loadThenSign = (id: string): Script => [
      [
        {
          name: 'load_capability',
          args: { names: ['ixo-transaction'] },
          id: `${id}-load`,
        },
      ],
      [{ name: 'sign_ixo_transaction', args: retireDraft, id }],
      [],
    ];

    const first = await runTurn(core, loadThenSign('c1'), {
      frontend: bridge.surface,
      claims,
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(JSON.parse(String(first.tools.get('c1')?.content))).toMatchObject({
      status: 'timeout',
      outcome: 'unknown',
    });
    // The timeout kept the write's claim in the ledger.
    expect(claims.log).toEqual(['claim:sign_ixo_transaction']);

    const second = await runTurn(core, loadThenSign('c2'), {
      frontend: bridge.surface,
      claims,
      runId: 'run-2',
      threadId: 'thread-2',
    });
    expect(second.tools.get('c2')?.status).toBe('error');
    expect(String(second.tools.get('c2')?.content)).toContain(
      'its outcome is unknown',
    );
    expect(bridge.calls).toHaveLength(1);
  });
});
