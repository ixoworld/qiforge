/**
 * `create_pod_group` and `link_pod_group` over the real create-session
 * store, a fake chain gateway and a fake Portal bridge: the group is shown
 * before it is signed, confirmed in a later turn, created once per POD,
 * read back for its address and linked in a second signature.
 */
import {
  DAODAO_MAX_NAME_LENGTH,
  DAODAO_VOTING_PERIOD_SECONDS,
  MAX_BATCH_SUMMARY_LENGTH,
  SignTransactionActionArgsSchema,
  findMessageByRoute,
  type SignTransactionActionArgs,
} from '@ixo/ixo-transaction';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  FrontendCallParams,
  FrontendCallSurface,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import {
  notConfiguredChainGateway,
  type ChainGateway,
  type PodGroupLookup,
} from './chain-gateway';
import { KvCreateSessionStore } from './create-session-store';
import { votingPeriodText } from '../ixo-transaction/dao-group';
import { MAX_POD_GROUP_MEMBERS, createGroupTools } from './group-tools';
import {
  PREPARE_ARGS,
  THREAD,
  byName,
  podBatchMessages,
} from './test-fixtures';

/** Checksummed 20-byte accounts and a 32-byte contract (bech32 of filled bytes). */
const OWNER = 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
const MEMBER = 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze';
const CORE = 'ixo1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zsrtecm8';
const OWNER_DID = `did:ixo:${OWNER}`;
const POD_DID = 'did:ixo:entity:382f95b0e05228e6b3ffb0a96858bf44';
const TX_HASH = 'A1'.repeat(32);
const GROUP_TX = 'B2'.repeat(32);
const SHOWN = 'req-shown';
const CONFIRMED = 'req-confirmed';

const risksOf = (module: string, action: string): string[] =>
  findMessageByRoute(module, action)?.risks ?? [];
const CREATE_RISKS = risksOf('daodao', 'create-group');
const LINK_RISKS = [
  ...risksOf('iid', 'add-linked-entity'),
  ...risksOf('iid', 'add-controller'),
];
const ALL_RISKS = [...CREATE_RISKS, ...LINK_RISKS];
const accepted = { confirmed: true, acceptedRisks: ALL_RISKS };

const GROUP_ARGS = { members: [OWNER, MEMBER], threshold: 2 };

/** `MAX_POD_GROUP_MEMBERS` distinct checksummed accounts. */
const MANY_MEMBERS = [
  'ixo1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg37gfsku',
  'ixo1zgfpyysjzgfpyysjzgfpyysjzgfpyysj0v04a2',
  'ixo1zvf3xycnzvf3xycnzvf3xycnzvf3xycnwuw5ht',
  'ixo1zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5wvf3sh',
  'ixo1z52329g4z52329g4z52329g4z52329g40ugs6k',
  'ixo1zctpv9skzctpv9skzctpv9skzctpv9sk7cw43q',
  'ixo1zut3w9chzut3w9chzut3w9chzut3w9chlg05mp',
  'ixo1rqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcssaqlc',
  'ixo1ryv3jxgeryv3jxgeryv3jxgeryv3jxge3qup4e',
  'ixo1rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6qy6y70',
  'ixo1rvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmp5m95w',
  'ixo1rswpc8qurswpc8qurswpc8qurswpc8qupyuqnj',
];

const callAgAction = vi.fn<(params: FrontendCallParams) => Promise<unknown>>();

function frontend(): FrontendCallSurface {
  return {
    callBrowserTool: async () => {
      throw new Error('no browser tools in these tests');
    },
    callAgAction,
    hasClient: () => true,
    canDispatch: () => true,
    parkedFor: () => null,
  };
}

/** The owner's Portal turn `requestId` on a testnet oracle. */
function ownerCtx(
  requestId: string,
  over: { network?: string; allowMainnet?: boolean; did?: string } = {},
): RuntimeContext {
  const base = makeRuntimeContext(
    {},
    {
      ambient: {
        config: {
          NETWORK: over.network ?? 'testnet',
          ...(over.allowMainnet ? { POD_CREATOR_ALLOW_MAINNET: 'true' } : {}),
        },
      },
      runConfig: {
        context: {
          user: {
            did: over.did ?? OWNER_DID,
            matrixUserId: '@owner:ixo.world',
            ucanDelegation: { raw: 'test-ucan-delegation' },
          },
          session: { id: THREAD, client: 'portal', requestId },
        },
      },
    },
  );
  return { ...base, frontend: frontend() };
}

function gatewayWith(
  findPodGroup: ChainGateway['findPodGroup'] = async () => ({
    status: 'found',
    coreAddress: CORE,
  }),
): ChainGateway {
  const unused = async (): Promise<never> => {
    throw new Error('not in these tests');
  };
  return {
    preparePodBatch: unused,
    publishDocuments: unused,
    confirmPodCreation: unused,
    prepareDomainCard: unused,
    requestIndexing: unused,
    findPodGroup,
  };
}

/** The tools over a thread whose POD this conversation sent and confirmed. */
async function setup(
  over: {
    gateway?: ChainGateway;
    confirmed?: boolean;
    profile?: { name: string };
  } = {},
): Promise<{
  create: PluginTool;
  link: PluginTool;
  sessions: KvCreateSessionStore;
}> {
  const sessions = new KvCreateSessionStore(createMemoryUserKv());
  if (over.confirmed ?? true) {
    await sessions.prepared(OWNER_DID, THREAD, 'blob_a', 'req-prepare');
    await sessions.approve(OWNER_DID, THREAD, 'blob_a', 'req-approve');
    await sessions.consume(OWNER_DID, THREAD, 'blob_a', {
      messages: podBatchMessages(),
      profile: over.profile ?? PREPARE_ARGS,
    });
    await sessions.confirmed(OWNER_DID, THREAD, {
      podDid: POD_DID,
      txHash: TX_HASH,
    });
  }
  const tools = createGroupTools(over.gateway ?? gatewayWith(), () => sessions);
  return {
    create: byName(tools, 'create_pod_group'),
    link: byName(tools, 'link_pod_group'),
    sessions,
  };
}

/** The group shown in one turn and confirmed in the next. */
async function showThenConfirm(create: PluginTool, args = GROUP_ARGS) {
  await create.handler(args, ownerCtx(SHOWN));
  return create.handler(
    { ...args, riskConfirmation: accepted },
    ownerCtx(CONFIRMED),
  );
}

/** The `sign_transaction` args of wallet call `call`, as the Portal handler receives them. */
const signArgs = (call = 0): SignTransactionActionArgs => {
  const params = callAgAction.mock.calls[call]?.[0];
  if (!params) throw new Error(`no wallet call ${call}`);
  return SignTransactionActionArgsSchema.parse(params.args);
};

beforeEach(() => {
  callAgAction.mockReset();
});

describe('create_pod_group: shown first, confirmed in a later turn', () => {
  it('shows the exact group, both signatures and every risk, and sends nothing', async () => {
    const { create } = await setup();
    const result = await create.handler(GROUP_ARGS, ownerCtx(SHOWN));
    expect(result).toEqual({
      status: 'confirm',
      podDid: POD_DID,
      // The POD's name by default.
      name: PREPARE_ARGS.name,
      members: [OWNER, MEMBER],
      threshold: 2,
      // The Portal's voting rules unless the user chose others.
      votingPeriodSeconds: 604_800,
      allowRevoting: true,
      summary: `Create the governance group "${PREPARE_ARGS.name}" of your POD ${POD_DID} on testnet: a DAO DAO multisig of 2 members, one vote each: ${OWNER}, ${MEMBER}. A proposal needs 2 yes votes; voting lasts 7 days. Votes can be changed until it ends, so a proposal passes only then. You (${OWNER}) are a member. A second signature then links it to the POD.`,
      linkSummary: `Link the governance group "${PREPARE_ARGS.name}" to your POD ${POD_DID} on testnet as the group that governs it, and add the group as a controller of the POD: proposals the group passes can then update the POD, and its members can join the POD's rooms.`,
      risks: ALL_RISKS,
      message: expect.stringContaining(
        'Only when they confirm in a later message',
      ),
    });
    expect(ALL_RISKS.length).toBeGreaterThanOrEqual(4);
    expect(callAgAction).not.toHaveBeenCalled();
  });

  it('refuses a group confirmed in the turn that showed it, or one that was not shown', async () => {
    const { create } = await setup();
    await create.handler(GROUP_ARGS, ownerCtx(SHOWN));
    await expect(
      create.handler(
        { ...GROUP_ARGS, riskConfirmation: accepted },
        ownerCtx(SHOWN),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/shown in this same turn/),
    });
    // Other members than were shown: the user never saw these.
    await expect(
      create.handler(
        { members: [MEMBER], threshold: 1, riskConfirmation: accepted },
        ownerCtx(CONFIRMED),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/was not shown to the user first/),
    });
    expect(callAgAction).not.toHaveBeenCalled();
  });

  it('creates the group with the voting rules the user chose, stated in the preview and the wallet’s summary', async () => {
    const findPodGroup = vi.fn(
      async (): Promise<PodGroupLookup> => ({
        status: 'found',
        coreAddress: CORE,
      }),
    );
    const { create } = await setup({ gateway: gatewayWith(findPodGroup) });
    const chosen = {
      ...GROUP_ARGS,
      votingPeriodSeconds: 86_400,
      allowRevoting: false,
    };
    const rules =
      'A proposal needs 2 yes votes; voting lasts 1 day. It passes as soon as it has them, and votes cannot be changed.';

    await expect(
      create.handler(chosen, ownerCtx(SHOWN)),
    ).resolves.toMatchObject({
      status: 'confirm',
      votingPeriodSeconds: 86_400,
      allowRevoting: false,
      summary: expect.stringContaining(rules),
      message: expect.stringContaining(
        'how long voting lasts and whether votes can be changed',
      ),
    });
    // Other rules than were shown: the user never saw these.
    await expect(
      create.handler(
        { ...chosen, allowRevoting: true, riskConfirmation: accepted },
        ownerCtx(CONFIRMED),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/was not shown to the user first/),
    });
    expect(callAgAction).not.toHaveBeenCalled();

    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: GROUP_TX,
      code: 0,
    });
    await expect(
      create.handler(
        { ...chosen, riskConfirmation: accepted },
        ownerCtx(CONFIRMED),
      ),
    ).resolves.toMatchObject({ status: 'created', coreAddress: CORE });
    const sent = signArgs(0);
    expect(sent.intent).toMatchObject({
      summary: expect.stringContaining(rules),
    });
    expect(sent.messages[0]?.value).toMatchObject({
      msg: {
        proposal_modules_instantiate_info: [
          {
            msg: {
              allow_revoting: false,
              max_voting_period: { time: 86_400 },
            },
          },
        ],
      },
    });
    expect(findPodGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        group: expect.objectContaining({
          votingPeriodSeconds: 86_400,
          allowRevoting: false,
        }),
      }),
      expect.anything(),
    );
  });

  it('refuses a voting time outside 1 hour to 30 days before anything is built', async () => {
    const { create } = await setup();
    for (const votingPeriodSeconds of [
      DAODAO_VOTING_PERIOD_SECONDS.min - 1,
      DAODAO_VOTING_PERIOD_SECONDS.max + 1,
      3_600.5,
    ])
      await expect(
        Promise.resolve().then(() =>
          create.handler(
            { ...GROUP_ARGS, votingPeriodSeconds },
            ownerCtx(SHOWN),
          ),
        ),
      ).rejects.toThrow();
    expect(callAgAction).not.toHaveBeenCalled();
  });

  it('says a voting time in plain words', () => {
    expect(votingPeriodText(604_800)).toBe('7 days');
    expect(votingPeriodText(86_400)).toBe('1 day');
    expect(votingPeriodText(129_600)).toBe('36 hours');
    expect(votingPeriodText(5_400)).toBe('90 minutes');
    expect(votingPeriodText(DAODAO_VOTING_PERIOD_SECONDS.max - 1)).toBe(
      '2591999 seconds',
    );
  });

  it('refuses a confirmation that leaves out a risk of either signature', async () => {
    const { create } = await setup();
    await create.handler(GROUP_ARGS, ownerCtx(SHOWN));
    await expect(
      create.handler(
        {
          ...GROUP_ARGS,
          riskConfirmation: { confirmed: true, acceptedRisks: CREATE_RISKS },
        },
        ownerCtx(CONFIRMED),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining(JSON.stringify(LINK_RISKS[0])),
    });
    expect(callAgAction).not.toHaveBeenCalled();
  });

  it('refuses without a POD confirmed in this conversation, on mainnet without the opt-in, and without a chain gateway', async () => {
    const none = await setup({ confirmed: false });
    await expect(
      none.create.handler(GROUP_ARGS, ownerCtx(SHOWN)),
    ).resolves.toMatchObject({
      status: 'refused',
      // A POD made earlier or elsewhere is pointed at link_dao_group.
      message: expect.stringMatching(
        /No POD was confirmed in this conversation.*for a POD made earlier or elsewhere, link an existing DAO DAO group with link_dao_group/,
      ),
    });
    await expect(none.link.handler({}, ownerCtx(SHOWN))).resolves.toMatchObject(
      {
        status: 'refused',
        message: expect.stringMatching(/No POD was confirmed/),
      },
    );

    const { create } = await setup();
    await expect(
      create.handler(GROUP_ARGS, ownerCtx(SHOWN, { network: 'mainnet' })),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/POD_CREATOR_ALLOW_MAINNET/),
    });
    await expect(
      create.handler(
        GROUP_ARGS,
        ownerCtx(SHOWN, { network: 'mainnet', allowMainnet: true }),
      ),
    ).resolves.toMatchObject({ status: 'confirm' });

    const off = await setup({ gateway: notConfiguredChainGateway });
    await expect(
      off.create.handler(GROUP_ARGS, ownerCtx(SHOWN)),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/turned off/),
    });
    expect(callAgAction).not.toHaveBeenCalled();
  });

  it('refuses a group the catalog refuses, and asks for a name when the POD’s does not fit', async () => {
    const { create } = await setup();
    await expect(
      create.handler(
        { members: [OWNER, MEMBER], threshold: 3 },
        ownerCtx(SHOWN),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(
        /threshold is at most the number of members/,
      ),
    });
    await expect(
      create.handler(
        { members: [OWNER, OWNER], threshold: 1 },
        ownerCtx(SHOWN),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/Each member is listed once/),
    });
    // The POD's name is longer than a group name may be.
    const longName = await setup({
      profile: { name: 'A'.repeat(DAODAO_MAX_NAME_LENGTH + 1) },
    });
    await expect(
      longName.create.handler(GROUP_ARGS, ownerCtx(SHOWN)),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/ask the user for a group name/),
    });
    await expect(
      longName.create.handler(
        { ...GROUP_ARGS, name: 'Solar board' },
        ownerCtx(SHOWN),
      ),
    ).resolves.toMatchObject({ status: 'confirm', name: 'Solar board' });
    expect(callAgAction).not.toHaveBeenCalled();
  });

  it('fits the largest group, with the longest name, in the summary the wallet shows', async () => {
    const { create } = await setup();
    expect(MANY_MEMBERS).toHaveLength(MAX_POD_GROUP_MEMBERS);
    const result = await create.handler(
      {
        members: MANY_MEMBERS,
        threshold: MAX_POD_GROUP_MEMBERS,
        name: 'N'.repeat(DAODAO_MAX_NAME_LENGTH),
        // The longest voting time in words, with the longer rule.
        votingPeriodSeconds: DAODAO_VOTING_PERIOD_SECONDS.max - 1,
        allowRevoting: true,
      },
      ownerCtx(SHOWN),
    );
    expect(result).toMatchObject({ status: 'confirm' });
    if (
      typeof result !== 'object' ||
      result === null ||
      !('summary' in result) ||
      typeof result.summary !== 'string'
    )
      throw new Error('expected a summary');
    expect(result.summary.length).toBeLessThanOrEqual(MAX_BATCH_SUMMARY_LENGTH);
    for (const member of MANY_MEMBERS) expect(result.summary).toContain(member);
    // One more member is refused before anything is built.
    await expect(
      Promise.resolve().then(() =>
        create.handler(
          { members: [...MANY_MEMBERS, OWNER], threshold: 1 },
          ownerCtx(SHOWN),
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('create_pod_group then link_pod_group: two wallet signatures', () => {
  it('creates the group, reads its address, links it, and does each once', async () => {
    const findPodGroup = vi.fn(
      async (): Promise<PodGroupLookup> => ({
        status: 'found',
        coreAddress: CORE,
      }),
    );
    const { create, link } = await setup({
      gateway: gatewayWith(findPodGroup),
    });
    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: GROUP_TX,
      code: 0,
    });

    await expect(showThenConfirm(create)).resolves.toEqual({
      status: 'created',
      podDid: POD_DID,
      name: PREPARE_ARGS.name,
      txHash: GROUP_TX,
      coreAddress: CORE,
      message: expect.stringContaining('call link_pod_group now'),
    });
    const created = signArgs(0);
    expect(created).toMatchObject({
      network: 'testnet',
      chainId: 'pandora-8',
      intent: {
        source: 'batch',
        summary: expect.stringContaining(`one vote each: ${OWNER}, ${MEMBER}`),
        messages: [{ module: 'daodao', action: 'create-group' }],
      },
      risks: CREATE_RISKS,
    });
    expect(created.messages).toHaveLength(1);
    expect(created.messages[0]).toMatchObject({
      typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
      value: {
        sender: OWNER,
        admin: OWNER,
        msg: {
          name: PREPARE_ARGS.name,
          description: '',
          voting_module_instantiate_info: {
            msg: {
              initial_members: [
                { addr: OWNER, weight: 1 },
                { addr: MEMBER, weight: 1 },
              ],
            },
          },
        },
      },
    });
    expect(findPodGroup).toHaveBeenCalledWith(
      {
        txHash: GROUP_TX,
        network: 'testnet',
        group: {
          name: PREPARE_ARGS.name,
          members: [OWNER, MEMBER],
          threshold: 2,
          votingPeriodSeconds: 604_800,
          allowRevoting: true,
        },
      },
      expect.anything(),
    );

    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: TX_HASH,
    });
    await expect(link.handler({}, ownerCtx(CONFIRMED))).resolves.toEqual({
      status: 'linked',
      podDid: POD_DID,
      coreAddress: CORE,
      txHash: TX_HASH,
      decisionsUrl: `https://test.portal.qi.space/domain/${POD_DID}/overview?tab=decisions`,
      message: expect.stringContaining('Decisions link'),
    });
    const linked = signArgs(1);
    expect(linked.intent).toMatchObject({
      source: 'batch',
      summary: expect.stringContaining(`(did:ixo:wasm:${CORE})`),
      messages: [
        { module: 'iid', action: 'add-linked-entity' },
        { module: 'iid', action: 'add-controller' },
      ],
    });
    expect(linked.messages).toEqual([
      {
        typeUrl: '/ixo.iid.v1beta1.MsgAddLinkedEntity',
        value: {
          id: POD_DID,
          linkedEntity: {
            id: `{id}#${CORE}`,
            type: 'group',
            relationship: 'governs',
            service: '',
          },
          signer: OWNER,
        },
      },
      {
        typeUrl: '/ixo.iid.v1beta1.MsgAddController',
        value: {
          id: POD_DID,
          controllerDid: `did:ixo:wasm:${CORE}`,
          signer: OWNER,
        },
      },
    ]);

    // Once per POD, each.
    await expect(
      create.handler(GROUP_ARGS, ownerCtx('req-again')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/already created \(.*\).*It is linked/),
    });
    await expect(
      link.handler({}, ownerCtx('req-again')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/already linked/),
    });
    expect(callAgAction).toHaveBeenCalledTimes(2);
  });

  it('links once the group’s transaction becomes readable, reading it again from the recorded hash', async () => {
    const findPodGroup = vi
      .fn<ChainGateway['findPodGroup']>()
      .mockResolvedValueOnce({
        status: 'pending',
        retryable: true,
        message: 'not in a block yet',
      })
      .mockResolvedValueOnce({
        status: 'pending',
        retryable: true,
        message: 'not in a block yet',
      })
      .mockResolvedValueOnce({ status: 'found', coreAddress: CORE });
    const { create, link } = await setup({
      gateway: gatewayWith(findPodGroup),
    });
    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: GROUP_TX,
    });

    const created = await showThenConfirm(create);
    expect(created).toMatchObject({ status: 'created', txHash: GROUP_TX });
    expect(created).not.toHaveProperty('coreAddress');

    await expect(link.handler({}, ownerCtx('req-1'))).resolves.toEqual({
      status: 'pending',
      retryable: true,
      message: 'not in a block yet',
    });
    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: TX_HASH,
    });
    await expect(link.handler({}, ownerCtx('req-2'))).resolves.toMatchObject({
      status: 'linked',
      coreAddress: CORE,
    });
    expect(findPodGroup.mock.calls.map(([input]) => input.txHash)).toEqual([
      GROUP_TX,
      GROUP_TX,
      GROUP_TX,
    ]);
  });

  it('after a timeout, never sends the group again, and links once the user gives its transaction', async () => {
    const findPodGroup = vi.fn<ChainGateway['findPodGroup']>(async () => ({
      status: 'found',
      coreAddress: CORE,
    }));
    const { create, link } = await setup({
      gateway: gatewayWith(findPodGroup),
    });
    // The bridge's answer when the wallet's never came.
    callAgAction.mockResolvedValueOnce({ outcome: 'unknown' });

    const timedOut = await showThenConfirm(create);
    expect(timedOut).toMatchObject({
      status: 'timeout',
      outcome: 'unknown',
      message: expect.stringContaining(
        'link_pod_group with the transaction hash',
      ),
    });
    await expect(
      create.handler(GROUP_ARGS, ownerCtx('req-again')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/outcome is not known/),
    });
    await expect(
      link.handler({}, ownerCtx('req-again')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/outcome is not known.*transaction hash/),
    });
    expect(findPodGroup).not.toHaveBeenCalled();

    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: TX_HASH,
    });
    await expect(
      link.handler({ txHash: GROUP_TX }, ownerCtx('req-hash')),
    ).resolves.toMatchObject({ status: 'linked', coreAddress: CORE });
    expect(findPodGroup).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: GROUP_TX }),
      expect.anything(),
    );
    expect(callAgAction).toHaveBeenCalledTimes(2);
  });

  it('refuses to link a transaction that is not this group', async () => {
    const { create, link } = await setup({
      gateway: gatewayWith(async () => ({
        status: 'failed',
        retryable: false,
        message:
          'That transaction is not the governance group this conversation sent for signing.',
      })),
    });
    callAgAction.mockResolvedValueOnce({ outcome: 'unknown' });
    await showThenConfirm(create);
    await expect(
      link.handler({ txHash: GROUP_TX }, ownerCtx('req-hash')),
    ).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message:
        'That transaction is not the governance group this conversation sent for signing.',
    });
    expect(callAgAction).toHaveBeenCalledTimes(1);
  });

  it('a declined group needs showing and confirming again; a declined link can be sent again alone', async () => {
    const { create, link } = await setup();
    callAgAction.mockRejectedValueOnce(new Error('User rejected the request'));
    await expect(showThenConfirm(create)).resolves.toMatchObject({
      status: 'rejected',
      message: expect.stringContaining(
        'call create_pod_group again without riskConfirmation',
      ),
    });
    await expect(
      create.handler(
        { ...GROUP_ARGS, riskConfirmation: accepted },
        ownerCtx('req-later'),
      ),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/was not shown to the user first/),
    });

    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: GROUP_TX,
    });
    await expect(showThenConfirm(create)).resolves.toMatchObject({
      status: 'created',
      coreAddress: CORE,
    });
    callAgAction.mockRejectedValueOnce(new Error('User rejected the request'));
    await expect(link.handler({}, ownerCtx('req-link'))).resolves.toMatchObject(
      {
        status: 'rejected',
        message: expect.stringContaining('call link_pod_group again'),
      },
    );
    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: TX_HASH,
    });
    await expect(
      link.handler({}, ownerCtx('req-link-2')),
    ).resolves.toMatchObject({
      status: 'linked',
    });
  });

  it('keeps the confirmation when no Portal tab can reach the wallet: nothing is claimed', async () => {
    const { create } = await setup();
    await create.handler(GROUP_ARGS, ownerCtx(SHOWN));
    const offline: RuntimeContext = {
      ...ownerCtx(CONFIRMED),
      frontend: { ...frontend(), canDispatch: () => false },
    };
    await expect(
      create.handler({ ...GROUP_ARGS, riskConfirmation: accepted }, offline),
    ).resolves.toMatchObject({ status: 'unavailable' });
    callAgAction.mockResolvedValueOnce({
      success: true,
      transactionHash: GROUP_TX,
    });
    await expect(
      create.handler(
        { ...GROUP_ARGS, riskConfirmation: accepted },
        ownerCtx(CONFIRMED),
      ),
    ).resolves.toMatchObject({ status: 'created' });
  });
});
