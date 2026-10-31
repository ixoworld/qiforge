import { describe, expect, it, vi } from 'vitest';
import { ToolMessage } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import {
  CHAIN_TX_GROUP_ACTION_TYPES,
  CHAIN_TX_GROUP_MESSAGE_TYPES,
  CHAIN_TX_MESSAGE_TYPES,
  chainTxIssue,
  parseOutcome,
  type ActionOutcomeV1,
  type ChainTxGroupActionType,
  type ChainTxReceiptStep,
  type ChainTxMessageType,
} from '@ixo/action-protocol';
import { createMemoryUserKv } from '../../core/user-kv';
import { createNoopAmbient } from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { isToolNotRun } from '../../core/tool-not-run';
import { wrapPluginTool } from '../../core/wrap-plugin-tool';
import { chainTxOperation } from '../../hub-actions/request';
import {
  chainTxAmountsInBaseUnits,
  toBaseUnits,
} from '../../hub-actions/transfer';
import type {
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import { GROUP_ACTION_TYPES } from './chain-tx-catalog';
import {
  CHAIN_TX_CATALOG,
  GROUP_ACTIONS_FAILED_MEANING,
  GROUP_ACTIONS_UNKNOWN_MEANING,
  HubActionsPlugin,
  PROPOSAL_NUMBER_UNKNOWN_MEANING,
  chainTransactionTool,
} from './hub-actions.plugin';

/**
 * The four group steps (`daodao.proposal.*`, protocol 0.9.0): the runtime's
 * schemas against the protocol's own parser, the provider-facing schema and
 * the discovery of a new proposal's action types.
 */

const id = 'G'.repeat(32);
const reference = {
  version: 'ixo.auth-action/1' as const,
  id,
  accountId: 'account-group',
  bindingId: 'chb_group',
  bindingRevision: 2,
  revision: 1,
  digest: 'd'.repeat(64),
  url: `https://hub.test/a/${id}`,
  expiresAt: 1999999999999,
  title: 'Review group step',
};

const ADMIN = 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
const RECIPIENT = 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze';
const VALIDATOR = 'ixovaloper1qeex565vg4uu7zwudh9ff2dauxptqf72nf2l44';
const VALIDATOR_TWO = 'ixovaloper1qgpqyqszqgpqyqszqgpqyqszqgpqyqszrh8mx2';
const ENTITY = 'did:ixo:entity:eb98bb2c92a62557b6c88c6f80e8d258';
/** The group's own contract and one of its proposal lists (32-byte addresses). */
const DAO = `ixo1${'q'.repeat(58)}`;
const LIST = `ixo1${'p'.repeat(58)}`;
const OWNER_DID = `did:ixo:${ADMIN}`;

/** One action of each type a group may do, as the model writes it. */
const ACTIONS: Record<
  ChainTxGroupActionType,
  { type: ChainTxGroupActionType } & Record<string, unknown>
> = {
  'cosmos.bank.send': {
    type: 'cosmos.bank.send',
    toAddress: RECIPIENT,
    amount: '500',
  },
  'ixo.token.transfer': {
    type: 'ixo.token.transfer',
    recipient: RECIPIENT,
    tokens: [{ id: 'CARBON:bafytoken', amount: '3' }],
  },
  'ixo.token.retire': {
    type: 'ixo.token.retire',
    tokens: [{ id: 'CARBON:bafytoken', amount: '1' }],
    jurisdiction: 'Global',
    reason: 'offset',
  },
  'cosmos.staking.delegate': {
    type: 'cosmos.staking.delegate',
    validatorAddress: VALIDATOR,
    amount: '100',
  },
  'cosmos.staking.undelegate': {
    type: 'cosmos.staking.undelegate',
    validatorAddress: VALIDATOR,
    amount: '0.5',
  },
  'cosmos.staking.redelegate': {
    type: 'cosmos.staking.redelegate',
    fromValidatorAddress: VALIDATOR,
    toValidatorAddress: VALIDATOR_TWO,
    amount: '20',
  },
  'cosmos.distribution.withdraw-rewards': {
    type: 'cosmos.distribution.withdraw-rewards',
    validatorAddress: VALIDATOR,
  },
  'cosmos.gov.vote': {
    type: 'cosmos.gov.vote',
    proposalId: '506',
    option: 'yes',
  },
  'ixo.claims.update-collection-state': {
    type: 'ixo.claims.update-collection-state',
    collectionId: '42',
    adminAddress: ADMIN,
    state: 'paused',
  },
  'ixo.claims.update-collection-dates': {
    type: 'ixo.claims.update-collection-dates',
    collectionId: '42',
    adminAddress: ADMIN,
    startDate: '2026-11-01T00:00:00Z',
    endDate: null,
  },
  'ixo.claims.update-collection-quota': {
    type: 'ixo.claims.update-collection-quota',
    collectionId: '42',
    adminAddress: ADMIN,
    maxClaims: '500',
  },
  'ixo.claims.create-collection': {
    type: 'ixo.claims.create-collection',
    entityId: ENTITY,
    protocolId: 'did:ixo:entity:2f22535f8b179a51d77a0e302e68d35d',
    startDate: '2026-11-01T00:00:00Z',
    endDate: null,
    maxClaims: '0',
    state: 'open',
    reservations: 'allow',
    payments: {
      approval: { amount: [{ denom: 'uixo', amountBaseUnits: '50000000' }] },
    },
  },
  'ixo.entity.create-account': {
    type: 'ixo.entity.create-account',
    entityId: ENTITY,
    name: 'Payouts',
  },
  'ixo.entity.revoke-account-authz': {
    type: 'ixo.entity.revoke-account-authz',
    entityId: ENTITY,
    granteeAddress: RECIPIENT,
    permission: 'file-claims',
  },
};

const vote = {
  type: 'daodao.proposal.vote',
  dao: DAO,
  proposalModule: LIST,
  proposalId: '3',
  vote: 'yes',
  rationale: 'Fixing the borehole helps everyone',
};
const execute = {
  type: 'daodao.proposal.execute',
  dao: DAO,
  proposalModule: LIST,
  proposalId: '3',
};
const close = { ...execute, type: 'daodao.proposal.close' };
const create = (actions: unknown[]) => ({
  type: 'daodao.proposal.create',
  dao: DAO,
  proposalModule: LIST,
  title: 'Pay Thandi for the borehole repair',
  description: 'Thandi fixed the borehole on 20 October; this pays her.',
  actions,
});

/** One valid message of each group step, and a new proposal holding each action type. */
const VALID: Record<string, unknown>[] = [
  vote,
  { ...vote, vote: 'abstain', rationale: undefined },
  execute,
  close,
  create([]),
  ...CHAIN_TX_GROUP_ACTION_TYPES.map((type) => create([ACTIONS[type]])),
  create([
    ACTIONS['cosmos.bank.send'],
    ACTIONS['cosmos.staking.delegate'],
    ACTIONS['ixo.claims.update-collection-dates'],
    ACTIONS['ixo.entity.create-account'],
  ]),
].map((message) => JSON.parse(JSON.stringify(message)));

const STAKE_TYPES: readonly string[] = [
  'cosmos.staking.delegate',
  'cosmos.staking.undelegate',
  'cosmos.staking.redelegate',
];
const DISPLAY = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A message as the protocol sees it once the owner object converted its
 * amounts: a new proposal's IXO send or stake in base units. Anything the
 * owner object would not convert is left as written.
 */
function onTheWire(message: Record<string, unknown>): Record<string, unknown> {
  if (
    message.type !== 'daodao.proposal.create' ||
    !Array.isArray(message.actions)
  )
    return message;
  return {
    ...message,
    actions: message.actions.map((action: unknown) => {
      if (
        !isObject(action) ||
        !(
          action.type === 'cosmos.bank.send' ||
          STAKE_TYPES.includes(String(action.type))
        ) ||
        typeof action.amount !== 'string' ||
        !DISPLAY.test(action.amount)
      )
        return action;
      const { amount, ...rest } = action;
      return { ...rest, amountBaseUnits: toBaseUnits(amount, 6).toString() };
    }),
  };
}

/** The protocol's reason for one message, as the Hub would get it; null: accepted. */
function protocolIssue(messages: Record<string, unknown>[]): string | null {
  return chainTxIssue({
    kind: 'ixo.chain.tx.v1',
    chainId: 'ixo-5',
    network: 'ixo mainnet',
    signer: ADMIN,
    memo: '',
    messages: messages.map(onTheWire),
  });
}

type HostChainTransaction = NonNullable<
  RuntimeContext['hubActions']
>['chainTransaction'];
/** The host's chain transaction, answering a reference to every call. */
const hostMock = () => vi.fn<HostChainTransaction>(async () => reference);

function channelContext(
  chainTransaction: HostChainTransaction,
  kv?: UserKvSurface,
  runId = 'run-group',
) {
  const unused = async () => {
    throw new Error('unused');
  };
  return makeRuntimeContext(
    {
      config: { HUB_ACTIONS_ENABLED: 'true' },
      user: {
        did: OWNER_DID,
        matrixUserId: '@owner:test',
        ucanDelegation: { raw: 'delegation' },
      },
      session: {
        id: 'session-group',
        client: 'channel',
        requestId: `request-${runId}`,
        runId,
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_group',
          bindingRevision: 2,
        },
      },
      toolCallId: `call-${runId}`,
      ...(kv ? { kv } : {}),
      hubActions: {
        capabilities: async () => ({
          version: 'ixo.auth-capabilities/2',
          accountId: 'account-group',
          oracleDid: 'did:ixo:oracle',
          network: 'ixo testnet',
          resourceOrigin: null,
          operations: ['ixo.chain.tx.v1'],
          forms: [],
          transfer: null,
          chainTx: {
            messageTypes: [...CHAIN_TX_MESSAGE_TYPES],
            maxMessages: 8,
          },
        }),
        options: unused,
        request: unused,
        chainTransaction,
        status: unused,
      },
    },
    { state: { messages: [] } },
  );
}

/** The request tool as an account offered every type is given it, every type's fields included. */
function chainTool(): PluginTool {
  const tool = chainTransactionTool(CHAIN_TX_MESSAGE_TYPES);
  if (!tool) throw new Error('chain transaction tool missing');
  return tool;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  additionalProperties?: unknown;
};
/** The tool's parameters as a provider is sent them (LangChain → OpenAI tool format). */
function providerParameters(tool: PluginTool): JsonSchema {
  return convertToOpenAITool(
    wrapPluginTool(tool, {
      ambient: createNoopAmbient(),
      state: { messages: [] },
    }),
  ).function.parameters as JsonSchema;
}
/** The provider-facing branches of a union by the type each takes (`const`, or each name of an open `enum`). */
function branchesOf(union: JsonSchema | undefined): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>();
  for (const branch of union?.oneOf ?? []) {
    const named = branch.properties?.type;
    for (const type of named?.enum ?? [named?.const])
      out.set(String(type), branch);
  }
  return out;
}
/** The provider-facing `actions` item of a new proposal. */
function actionsItem(tool: PluginTool): JsonSchema | undefined {
  return branchesOf(providerParameters(tool).properties?.messages?.items).get(
    'daodao.proposal.create',
  )?.properties?.actions?.items;
}

describe('group steps', () => {
  it('accepts each group step and a new proposal with each action a group may do, and the protocol accepts what the owner object makes of it', async () => {
    const chainTransaction = hostMock();
    const ctx = channelContext(chainTransaction);
    for (const message of VALID) {
      expect([
        message,
        chainTool().schema.safeParse({ messages: [message] }).success,
        await chainTool().handler({ messages: [message] }, ctx),
        protocolIssue([message]),
      ]).toMatchObject([message, true, { status: 'prepared' }, null]);
      const handed = chainTransaction.mock.lastCall?.[0].messages ?? [];
      expect(handed).toEqual([message]);
      // The owner object: amounts in base units, then the protocol's parse.
      expect(
        chainTxOperation({
          ownerDid: OWNER_DID,
          chainId: 'ixo-5',
          network: 'ixo mainnet',
          memo: '',
          messages: chainTxAmountsInBaseUnits(handed, null),
        }),
      ).toMatchObject({ messages: [onTheWire(message)] });
    }
    // Every type a group may do is in the catalogue's list, in order.
    expect(GROUP_ACTION_TYPES).toEqual([...CHAIN_TX_GROUP_ACTION_TYPES]);
  });

  it('puts a group step alone on its card, as the protocol does', async () => {
    const chainTransaction = hostMock();
    for (const messages of [
      [vote, ACTIONS['cosmos.bank.send']],
      [ACTIONS['cosmos.gov.vote'], execute],
      [close, close],
    ]) {
      expect(protocolIssue(messages)).toBe('invalid_operation: messages');
      expect(
        await chainTool().handler(
          { messages },
          channelContext(chainTransaction),
        ),
      ).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining(
          'messages: a group step (a group vote, carrying out or closing a group proposal, a new group proposal) goes alone on its card',
        ),
      });
    }
    expect(chainTransaction).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['the group as its own proposal list', { ...vote, proposalModule: DAO }],
    ['an account address as the group', { ...vote, dao: ADMIN }],
    ['proposal 0', { ...execute, proposalId: '0' }],
    ['a proposal number with a leading zero', { ...close, proposalId: '03' }],
    [
      'a proposal number past 2^53 − 1',
      { ...execute, proposalId: '9007199254740992' },
    ],
    ['a proposal number as a number', { ...execute, proposalId: 3 }],
    ['a network-proposal vote option', { ...vote, vote: 'no_with_veto' }],
    [
      'a reason with a link',
      { ...vote, rationale: 'see https://vote.example' },
    ],
    ['a null reason', { ...vote, rationale: null }],
    ['an empty reason', { ...vote, rationale: '' }],
    ['a reason over 300 characters', { ...vote, rationale: 'a'.repeat(301) }],
    ['a title over 100 characters', { ...create([]), title: 'a'.repeat(101) }],
    ['a description on two lines', { ...create([]), description: 'one\ntwo' }],
    [
      'a description with two spaces',
      { ...create([]), description: 'one  two' },
    ],
    ['a title with a bidi override', { ...create([]), title: 'Pay‮Thandi' }],
    ['no actions key', (({ actions: _a, ...rest }) => rest)(create([]))],
    ['five actions', create(Array(5).fill(ACTIONS['cosmos.gov.vote']))],
    [
      'a claim filed by the group',
      create([
        {
          type: 'ixo.claims.submit',
          collectionId: '42',
          claimId: 'bafy',
          adminAddress: ADMIN,
        },
      ]),
    ],
    ['a proposal inside a proposal', create([execute])],
    [
      'a group dates change with one date',
      create([
        (({ endDate: _e, ...rest }) => rest)(
          ACTIONS['ixo.claims.update-collection-dates'],
        ),
      ]),
    ],
    [
      'a stake naming its delegator',
      create([
        { ...ACTIONS['cosmos.staking.delegate'], delegatorAddress: ADMIN },
      ]),
    ],
    [
      'a send to a contract',
      create([{ ...ACTIONS['cosmos.bank.send'], toAddress: DAO }]),
    ],
    ['an action that is not an object', create([null])],
  ])(
    'refuses %s, as the protocol does, before any Hub call',
    async (_name, message) => {
      const chainTransaction = hostMock();
      const issue = protocolIssue([message]);
      expect(issue).toMatch(/^invalid_message: messages\[0\]/);
      const field = (issue ?? '').replace(/^invalid_message: /, '');
      expect(
        await chainTool().handler(
          { messages: [message] },
          channelContext(chainTransaction),
        ),
      ).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining(`${field}:`),
      });
      expect(chainTransaction).not.toHaveBeenCalled();
    },
  );

  it('refuses what the protocol refuses and accepts what it accepts, over 2 000 random changes to valid group steps', async () => {
    // A seeded generator: the same changes on every run.
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)]!;
    const POOL: unknown[] = [
      '',
      ' ',
      'x',
      'yes',
      'no',
      'abstain',
      'no_with_veto',
      '0',
      '1',
      '01',
      '3',
      '9007199254740991',
      '9007199254740992',
      '18446744073709551616',
      DAO,
      LIST,
      ADMIN,
      RECIPIENT,
      VALIDATOR,
      ENTITY,
      `${DAO}q`,
      DAO.toUpperCase(),
      `ixo1${'b'.repeat(58)}`,
      'a'.repeat(100),
      'a'.repeat(101),
      'a'.repeat(300),
      'a'.repeat(301),
      'see https://x.example now',
      'pay.example/now',
      'me@x.org',
      'www.example.com',
      'two  spaces',
      ' lead',
      'trail ',
      'tab\there',
      'bidi‮',
      'soft­',
      'line\nbreak',
      'Annual Report.pdf',
      'offset',
      '2026-11-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      'Global',
      'ke',
      'paused',
      'file-claims',
      'cosmos.bank.send',
      'ixo.claims.submit',
      'daodao.proposal.vote',
      null,
      0,
      1,
      -1,
      1.5,
      true,
      false,
      [],
      {},
    ];
    /** Every value path of a message but the display amounts (the owner object's to convert). */
    const paths = (
      value: unknown,
      at: (string | number)[] = [],
    ): (string | number)[][] => {
      const here = at.length ? [at] : [];
      if (Array.isArray(value))
        return [
          ...here,
          ...value.flatMap((item, i) => paths(item, [...at, i])),
        ];
      if (isObject(value))
        return [
          ...here,
          ...Object.entries(value).flatMap(([key, item]) =>
            key === 'amount' && at.includes('actions') && at.length === 2
              ? []
              : paths(item, [...at, key]),
          ),
        ];
      return here;
    };
    const parentOf = (
      root: Record<string, unknown>,
      path: (string | number)[],
    ) => {
      let node: unknown = root;
      for (const key of path.slice(0, -1))
        node = Array.isArray(node)
          ? node[Number(key)]
          : isObject(node)
            ? node[key]
            : undefined;
      return node;
    };
    /** One random change; `retyped`: a message's `type` changed, which breaks every field at once. */
    const mutate = (base: Record<string, unknown>) => {
      const message: Record<string, unknown> = JSON.parse(JSON.stringify(base));
      const path = pick(paths(message));
      const parent = parentOf(message, path);
      const key = path[path.length - 1]!;
      const change = random();
      if (Array.isArray(parent)) {
        const index = Number(key);
        if (change < 0.6) parent[index] = pick(POOL);
        else if (change < 0.8) parent.splice(index, 1);
        else parent.push(...Array(5).fill(parent[index]));
      } else if (isObject(parent)) {
        if (change < 0.7) parent[key] = pick(POOL);
        else if (change < 0.85) delete parent[key];
        else parent[`extra${Math.floor(random() * 3)}`] = pick(POOL);
      }
      return { message, retyped: key === 'type' };
    };
    const chainTransaction = hostMock();
    const ctx = channelContext(chainTransaction);
    let accepted = 0;
    let refused = 0;
    let singlyNamed = 0;
    /** Every change on which the two sides disagree (none expected). */
    const disagreements: unknown[] = [];
    for (let n = 0; n < 2_000; n++) {
      const { message, retyped } = mutate(pick(VALID));
      const issue = protocolIssue([message]);
      const calls = chainTransaction.mock.calls.length;
      const result = await chainTool().handler({ messages: [message] }, ctx);
      const runtime = isObject(result) ? result : {};
      if (issue === null) {
        accepted++;
        // Prepared, handed to the host as written, and what the owner
        // object makes of it parses too.
        const handed =
          chainTransaction.mock.calls.length > calls
            ? (chainTransaction.mock.lastCall?.[0].messages ?? [])
            : [];
        let owner: string | null = null;
        try {
          chainTxOperation({
            ownerDid: OWNER_DID,
            chainId: 'ixo-5',
            network: 'ixo mainnet',
            memo: '',
            messages: chainTxAmountsInBaseUnits(handed, null),
          });
        } catch (error) {
          owner = error instanceof Error ? error.message : String(error);
        }
        if (
          runtime.status !== 'prepared' ||
          JSON.stringify(handed) !== JSON.stringify([message]) ||
          owner !== null
        )
          disagreements.push({ message, runtime, handed, owner });
        continue;
      }
      refused++;
      // The fields the runtime names. Where it names one, it is the
      // protocol's; a changed type breaks several fields at once and may be
      // named through another of them (both sides refuse it).
      const named = [
        ...String(runtime.reason).matchAll(
          /(?:\(check |; )(messages(?:\[\d+\][^:]*)?):/g,
        ),
      ].map((match) => match[1]);
      const field = issue.replace(/^invalid_(?:message|operation): /, '');
      if (named.length === 1 && !retyped) singlyNamed++;
      if (
        runtime.status !== 'unavailable' ||
        (named.length === 1 && !retyped && named[0] !== field)
      )
        disagreements.push({ message, issue, runtime });
    }
    expect(disagreements).toEqual([]);
    // Both sides were exercised.
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(1_000);
    expect(singlyNamed).toBeGreaterThan(refused / 2);
  });

  it('gives a provider every field of a new proposal’s actions once every type is described, each action type its own branch', () => {
    const item = actionsItem(
      chainTransactionTool(CHAIN_TX_MESSAGE_TYPES, CHAIN_TX_MESSAGE_TYPES)!,
    );
    const branches = branchesOf(item);
    expect([...branches.keys()]).toEqual([...CHAIN_TX_GROUP_ACTION_TYPES]);
    for (const type of CHAIN_TX_GROUP_ACTION_TYPES) {
      const shape = CHAIN_TX_CATALOG[type].schema.shape as Record<
        string,
        unknown
      >;
      // The dates change of a group proposal takes both dates.
      expect([type, Object.keys(branches.get(type)?.properties ?? {})]).toEqual(
        [type, Object.keys(shape)],
      );
      // Open, so the handler names a stray field.
      expect(branches.get(type)?.additionalProperties).not.toBe(false);
    }
    // Amounts in display units, never base units, as at top level.
    expect(branches.get('cosmos.bank.send')?.properties).toHaveProperty(
      'amount',
    );
    expect(
      branches.get('cosmos.staking.delegate')?.properties,
    ).not.toHaveProperty('amountBaseUnits');
    expect(
      branches.get('ixo.claims.update-collection-dates')?.required,
    ).toEqual(expect.arrayContaining(['startDate', 'endDate']));
    // The four steps name no signer and no owner identity.
    const text = JSON.stringify(
      providerParameters(
        chainTransactionTool(CHAIN_TX_MESSAGE_TYPES, CHAIN_TX_MESSAGE_TYPES)!,
      ),
    );
    for (const field of [
      '"signer"',
      '"delegatorAddress"',
      '"voter"',
      '"sender"',
      '"proposer"',
    ])
      expect(text).not.toContain(field);
  });

  it('names a new proposal’s action types only, without a session store (every top-level type has its fields)', () => {
    const fallback = chainTool();
    expect(actionsItem(fallback)?.oneOf).toEqual([
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...CHAIN_TX_GROUP_ACTION_TYPES] },
        },
        required: ['type'],
        additionalProperties: {},
      },
    ]);
    expect(
      Object.keys(
        branchesOf(
          providerParameters(fallback).properties?.messages?.items,
        ).get('cosmos.bank.send')?.properties ?? {},
      ),
    ).toEqual(['type', 'toAddress', 'amount', 'denom']);
  });

  it('gives a new proposal’s action types only their names until each is described', () => {
    const only = chainTransactionTool(CHAIN_TX_MESSAGE_TYPES, [
      'daodao.proposal.create',
    ]);
    expect(actionsItem(only!)?.oneOf).toEqual([
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...CHAIN_TX_GROUP_ACTION_TYPES] },
        },
        required: ['type'],
        additionalProperties: {},
      },
    ]);
    const withSend = branchesOf(
      actionsItem(
        chainTransactionTool(CHAIN_TX_MESSAGE_TYPES, [
          'daodao.proposal.create',
          'cosmos.bank.send',
        ])!,
      ),
    );
    expect(
      Object.keys(withSend.get('cosmos.bank.send')?.properties ?? {}),
    ).toEqual(['type', 'toAddress', 'amount', 'denom']);
    expect(
      Object.keys(withSend.get('ixo.token.retire')?.properties ?? {}),
    ).toEqual(['type']);
  });

  it('asks for the rules of a new proposal’s action types before the card, and lists them compactly in describe_chain_messages', async () => {
    const chainTransaction = hostMock();
    const kv = createMemoryUserKv();
    const describe = new HubActionsPlugin()
      .getTools()
      .find((tool) => tool.name === 'describe_chain_messages');
    if (!describe) throw new Error('describe tool missing');
    const described = (await describe.handler(
      { types: ['daodao.proposal.create'] },
      channelContext(chainTransaction, kv, 'run-1'),
    )) as {
      messages: { fields: { properties: Record<string, JsonSchema> } }[];
    };
    const actions = described.messages[0]?.fields.properties.actions;
    // The action types by name only: each is described on its own.
    expect(actions?.items).toEqual({
      type: 'object',
      description: expect.stringContaining('describe_chain_messages that type'),
      properties: {
        type: { type: 'string', enum: [...CHAIN_TX_GROUP_ACTION_TYPES] },
      },
      required: ['type'],
    });
    // The general rules, the proposal's rules and fields, and the 37 type
    // names (8 403 characters when measured).
    expect(JSON.stringify(described).length).toBeLessThan(9_000);
    // The next turn: the proposal is described, the send it holds is not.
    const ctx = channelContext(chainTransaction, kv, 'run-2');
    const [tool] = await new HubActionsPlugin().getRequestTools(ctx);
    const message = create([
      ACTIONS['cosmos.bank.send'],
      ACTIONS['ixo.token.retire'],
    ]);
    const refused = await tool!.handler({ messages: [message] }, ctx);
    expect(refused).toBeInstanceOf(ToolMessage);
    expect(isToolNotRun(refused as ToolMessage)).toBe(true);
    expect((refused as ToolMessage).content).toContain(
      'call describe_chain_messages with types ["cosmos.bank.send","ixo.token.retire"]',
    );
    expect(chainTransaction).not.toHaveBeenCalled();
    await describe.handler(
      { types: ['cosmos.bank.send', 'ixo.token.retire'] },
      channelContext(chainTransaction, kv, 'run-2'),
    );
    expect(
      await tool!.handler(
        { messages: [message] },
        channelContext(chainTransaction, kv, 'run-3'),
      ),
    ).toMatchObject({ status: 'prepared' });
  });

  it('tells the model when a carried-out proposal’s actions failed, or a new proposal’s number is unknown, through hub_action_status', async () => {
    /** A succeeded chain receipt with `step`, parsed by the protocol. */
    const succeeded = (step: ChainTxReceiptStep): ActionOutcomeV1 =>
      parseOutcome({
        version: 'ixo.auth-outcome/2',
        eventId: 'event-group',
        reference,
        ownerDid: OWNER_DID,
        authorizedRevision: 1,
        authorizedDigest: reference.digest,
        sequence: 3,
        status: 'succeeded',
        receipt: {
          kind: 'ixo.chain.tx.v1',
          actionId: id,
          revision: 1,
          digest: reference.digest,
          chainId: 'ixo-5',
          txHash: 'f'.repeat(64),
          height: 100,
          code: 0,
          steps: [step],
        },
        occurredAt: 1770000000003,
      });
    const unused = async () => {
      throw new Error('unused');
    };
    const status = new HubActionsPlugin()
      .getTools()
      .find((tool) => tool.name === 'hub_action_status');
    if (!status) throw new Error('status tool missing');
    const read = (outcome: ActionOutcomeV1) =>
      status.handler(
        { actionId: id },
        makeRuntimeContext({
          config: { HUB_ACTIONS_ENABLED: 'true' },
          hubActions: {
            capabilities: unused,
            options: unused,
            request: unused,
            chainTransaction: unused,
            status: async () => ({
              held: true,
              reviewStatus: 'authorized',
              operationStatus: 'succeeded',
              outcome,
              summary: null,
            }),
          },
        }),
      );
    // Code 0, yet nothing in the proposal happened: never "done".
    expect(
      await read(
        succeeded({ type: 'daodao.proposal.execute', groupActions: 'failed' }),
      ),
    ).toMatchObject({
      status: 'known',
      outcome: {
        receipt: {
          steps: [{ type: 'daodao.proposal.execute', groupActions: 'failed' }],
        },
      },
      meaning: GROUP_ACTIONS_FAILED_MEANING,
    });
    for (const words of [
      'nothing in the proposal happened',
      'can’t be carried out again',
      'unless a fee grant covered it',
      'Never say it is done',
    ])
      expect(GROUP_ACTIONS_FAILED_MEANING).toContain(words);
    expect(
      await read(
        succeeded({ type: 'daodao.proposal.execute', groupActions: 'done' }),
      ),
    ).not.toHaveProperty('meaning');
    // No proof either way: never read as done.
    expect(
      await read(
        succeeded({ type: 'daodao.proposal.execute', groupActions: 'unknown' }),
      ),
    ).toMatchObject({ meaning: GROUP_ACTIONS_UNKNOWN_MEANING });
    expect(GROUP_ACTIONS_UNKNOWN_MEANING).toContain('never say it is done');
    // A new proposal whose number Auth Hub could not read.
    expect(
      await read(
        succeeded({ type: 'daodao.proposal.create', proposalId: null }),
      ),
    ).toMatchObject({ meaning: PROPOSAL_NUMBER_UNKNOWN_MEANING });
    expect(PROPOSAL_NUMBER_UNKNOWN_MEANING).toContain(
      'chain_lookup dao_proposals',
    );
    expect(
      await read(
        succeeded({ type: 'daodao.proposal.create', proposalId: '4' }),
      ),
    ).not.toHaveProperty('meaning');
    // The rules say the same before the card.
    expect(CHAIN_TX_CATALOG['daodao.proposal.execute'].rules).toContain(
      'read the receipt’s `groupActions`: `"failed"` means the proposal’s actions did not happen and it can’t be tried again; never say it is done.',
    );
    expect(CHAIN_TX_CATALOG['daodao.proposal.create'].rules).toContain(
      'when it is null, find the new proposal with chain_lookup dao_proposals',
    );
  });

  it('describes each group step in plain words: where the ids come from, what to say first and what can be lost', () => {
    const rules = (type: ChainTxMessageType) => CHAIN_TX_CATALOG[type].rules;
    for (const type of CHAIN_TX_GROUP_MESSAGE_TYPES) {
      expect(rules(type)).toContain('chain_lookup dao_proposals');
      expect(rules(type)).toContain('One group step per card');
    }
    expect(rules('daodao.proposal.vote')).toContain(
      'never vote without the owner saying how',
    );
    expect(rules('daodao.proposal.create')).toContain(
      'Never propose without the owner asking for it',
    );
    expect(rules('daodao.proposal.create')).toContain(
      'it may be lost if the proposal doesn’t pass or is never carried out',
    );
    expect(rules('daodao.proposal.vote')).toContain(
      'is still recorded until voting closes, but can’t change the result',
    );
    expect(rules('daodao.proposal.execute')).toContain(
      'refuses the card when the actions would fail',
    );
    expect(rules('daodao.proposal.close')).toContain(
      'Closing does not give its deposit back',
    );
    for (const type of CHAIN_TX_GROUP_ACTION_TYPES)
      expect(rules('daodao.proposal.create')).toContain(type);
  });
});
