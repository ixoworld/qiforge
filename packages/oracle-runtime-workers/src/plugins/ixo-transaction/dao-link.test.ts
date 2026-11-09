/**
 * `link_dao_group` over the real confirmation store, a chain REST stub that
 * answers as devnet did on Nov 9 2026 (the "Neighbourhood Book Club" POD and
 * its "Neighbourhood Book Club Board" group, linked in transaction
 * 6B8EB959…) and a fake Portal wallet: the entity and the group are read
 * before the link is shown and again before it is signed, only the missing
 * messages are sent, and the link counts as made once its transaction reads
 * back with code 0.
 */
import {
  SignTransactionActionArgsSchema,
  findMessageByRoute,
} from '@ixo/ixo-transaction';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { uncertainResultReason } from '../../core/middlewares/tool-execution';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  FrontendCallParams,
  FrontendCallSurface,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { base64ToBytes } from '../base64';
import { resetUpstreamHealth } from '../ixo-chain/http';
import { resetNamesClient } from '../ixo-chain/names/client';
import { linkHint } from './dao-link';
import { MEMBERS_LIMIT } from './dao-link-check';
import linkTx from './fixtures/devnet-dao-link-tx.json';
import linkedPod from './fixtures/devnet-linked-pod.json';
import { IxoTransactionPlugin } from './ixo-transaction.plugin';
import { ToolMessage } from '@langchain/core/messages';

/** The POD's owner, the group's creator and one of its three members. */
const OWNER = 'ixo1pe3q5htqe02p7x7etqastvl0kn37k6xepn0f4r';
const OWNER_DID = `did:ixo:${OWNER}`;
const MEMBERS = [
  'ixo1ez640txp6rjr2wr7ymxaxykjrkns6lqxwdasce',
  'ixo1l7mn02nsvn02crx3ltsgpy50fv2lujrd229x8a',
  OWNER,
];
/** A checksummed account the POD's identity does not list. */
const STRANGER = 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
const POD = 'did:ixo:entity:25b5f5c01545f004d5ecb5f32c14495e';
const CORE = 'ixo1add3jw5qcm3pvcywy2mhhxcw50s40pm0hyenarvpmy5p3t65ey0q906c48';
const VOTING = 'ixo19ucr8u7fau8ewxcx5wxyj75m2smluuel70r8cjyd4dvpjddqxekqkur2kj';
const CW4 = 'ixo1t9hcqyjx2xqcl3svvtemdgzlksw00k9dsqfyl6fgz3wpn8j54gkqv9wv5g';
const PROPOSALS =
  'ixo1xkc0ae977n8eavdmgv2pc0anvy9u4q0ulcuv4kajjemr7rpgzhpsa7p539';
/** Another checksummed 32-byte contract: a second group. */
const OTHER_GROUP =
  'ixo1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zsrtecm8';
const TX_HASH = linkTx.tx_response.txhash;
const SESSION = 'session-1';
const SHOWN = 'req-shown';
const CONFIRMED = 'req-confirmed';

const risksOf = (action: string): string[] =>
  findMessageByRoute('iid', action)?.risks ?? [];
const LINK_RISKS = risksOf('add-linked-entity');
const CONTROLLER_RISKS = risksOf('add-controller');
const ALL_RISKS = [...LINK_RISKS, ...CONTROLLER_RISKS];
const acceptAll = { confirmed: true, acceptedRisks: ALL_RISKS };
const ARGS = { entityDid: POD, coreAddress: CORE };

/** The POD's identity as devnet answers it now (linked), and as it was before the link. */
type EntityAnswer = typeof linkedPod;
const LINKED: EntityAnswer = linkedPod;
const UNLINKED: EntityAnswer = {
  ...linkedPod,
  iidDocument: {
    ...linkedPod.iidDocument,
    controller: linkedPod.iidDocument.controller.filter(
      (did) => did !== `did:ixo:wasm:${CORE}`,
    ),
    linkedEntity: [],
  },
};
const withIid = (over: Record<string, unknown>, type = 'pod') => ({
  entity: { ...UNLINKED.entity, type },
  iidDocument: { ...UNLINKED.iidDocument, ...over },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A chain REST refusal as devnet's gateway words it. */
const wasmError = (message: string) =>
  json({ code: 2, message, details: [] }, 500);

/** What devnet answered for each read, on Nov 9 2026; a test overrides one. */
interface Chain {
  entity: () => Response;
  contract: () => Response;
  dumpState: () => Response;
  groupContract: () => Response;
  members: () => Response;
  proposalConfig: () => Response;
  tx: () => Response;
  names: () => Response;
}

const DEVNET: Chain = {
  entity: () => json(UNLINKED),
  contract: () =>
    json({
      address: CORE,
      contract_info: {
        code_id: '3',
        creator: OWNER,
        admin: OWNER,
        label: `did:ixo:${OWNER}contract3`,
      },
    }),
  dumpState: () =>
    json({
      data: {
        admin: CORE,
        config: {
          name: 'Neighbourhood Book Club Board',
          description: '',
          image_url: null,
          automatically_add_cw20s: true,
          automatically_add_cw721s: true,
          dao_uri: null,
        },
        pause_info: { unpaused: {} },
        version: { contract: 'crates.io:dao-core', version: '2.0.3' },
        proposal_modules: [
          { address: PROPOSALS, prefix: 'A', status: 'enabled' },
        ],
        voting_module: VOTING,
        active_proposal_module_count: 1,
        total_proposal_module_count: 1,
      },
    }),
  groupContract: () => json({ data: CW4 }),
  members: () =>
    json({
      data: { members: MEMBERS.map((addr) => ({ addr, weight: 1 })) },
    }),
  proposalConfig: () =>
    json({
      data: {
        threshold: { absolute_count: { threshold: '1' } },
        max_voting_period: { time: 604_800 },
        min_voting_period: null,
        only_members_execute: true,
        allow_revoting: true,
        dao: CORE,
        close_proposal_on_execution_failure: true,
      },
    }),
  tx: () => json(linkTx),
  names: () =>
    json({
      network: 'devnet',
      results: {
        [POD]: {
          id: POD,
          kind: 'entity',
          normalized: POD,
          display: 'Neighbourhood Book Club',
          status: 'resolved',
          complete: true,
          name: 'Neighbourhood Book Club',
          source: 'entity',
          selfChosen: true,
          cache: { hit: 'stale', freshUntil: 1_794_209_929 },
        },
      },
    }),
};

/** The smart query a chain REST URL carries, decoded. */
function smartQueryOf(url: string): { contract: string; key: string } | null {
  const match =
    /\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/([^/?]+)$/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  const query = z
    .record(z.string(), z.unknown())
    .parse(
      JSON.parse(
        new TextDecoder().decode(base64ToBytes(decodeURIComponent(match[2]))),
      ),
    );
  return { contract: match[1], key: Object.keys(query).join() };
}

/**
 * Chain REST and the Names worker answering as `chain` says; the URLs
 * asked are recorded, each as `<what>` for the assertions.
 */
function stubChain(over: Partial<Chain> = {}) {
  const chain = { ...DEVNET, ...over };
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const smart = smartQueryOf(url);
      const read = (what: string, answer: () => Response) => {
        asked.push(what);
        return answer();
      };
      if (url.endsWith('/v1/resolve')) return read('names', chain.names);
      if (url.endsWith(`/ixo/entity/${POD}`))
        return read('entity', chain.entity);
      if (url.includes('/cosmos/tx/v1beta1/txs/')) return read('tx', chain.tx);
      if (smart?.contract === CORE && smart.key === 'dump_state')
        return read('dump_state', chain.dumpState);
      if (smart?.contract === VOTING && smart.key === 'group_contract')
        return read('group_contract', chain.groupContract);
      if (smart?.contract === CW4 && smart.key === 'list_members')
        return read('list_members', chain.members);
      if (smart?.contract === PROPOSALS && smart.key === 'config')
        return read('config', chain.proposalConfig);
      if (/\/cosmwasm\/wasm\/v1\/contract\/[^/]+$/.test(url))
        return read('contract', chain.contract);
      throw new Error(`unexpected request ${url}`);
    }),
  );
  return asked;
}

/** Every read the check makes (sorted: some run side by side). */
const CHECK_READS = [
  'config',
  'contract',
  'dump_state',
  'entity',
  'group_contract',
  'list_members',
  'names',
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

/** The user's store for the conversation of one test. */
let conversation = createMemoryUserKv();
beforeEach(() => {
  conversation = createMemoryUserKv();
  callAgAction.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetUpstreamHealth();
  resetNamesClient();
});

/** A Portal turn `requestId` of `did` on an oracle on `network`. */
function turn(
  requestId: string,
  over: {
    network?: string;
    did?: string;
    config?: Record<string, unknown>;
  } = {},
): RuntimeContext {
  const base = makeRuntimeContext(
    {},
    {
      ambient: {
        config: { NETWORK: over.network ?? 'devnet', ...over.config },
      },
      runConfig: {
        context: {
          user: {
            did: over.did ?? OWNER_DID,
            matrixUserId: '@owner:ixo.world',
            ucanDelegation: { raw: 'test-ucan-delegation' },
          },
          session: { id: SESSION, client: 'portal', requestId },
        },
      },
    },
  );
  return { ...base, kv: conversation, frontend: frontend() };
}

function linkTool(config: Record<string, unknown> = {}): PluginTool {
  const tools = new IxoTransactionPlugin().getRequestTools(
    makeRuntimeContext({}, { ambient: { config } }),
  );
  const found = tools.find((t) => t.name === 'link_dao_group');
  if (!found) throw new Error('link_dao_group not contributed');
  return found;
}

/** The `sign_transaction` args of wallet request `call`. */
function sentArgs(call = 0) {
  return SignTransactionActionArgsSchema.parse(
    callAgAction.mock.calls[call]?.[0].args,
  );
}

/** Preview `args` in an earlier request, then sign them with `answer` from the wallet. */
async function previewThenSign(
  answer: () => Promise<unknown>,
  over: { args?: Record<string, unknown>; accepted?: string[] } = {},
) {
  const tool = linkTool();
  const args = over.args ?? ARGS;
  await expect(tool.handler(args, turn(SHOWN))).resolves.toMatchObject({
    status: 'confirm',
  });
  callAgAction.mockImplementationOnce(answer);
  return tool.handler(
    {
      ...args,
      riskConfirmation: {
        confirmed: true,
        acceptedRisks: over.accepted ?? ALL_RISKS,
      },
    },
    turn(CONFIRMED),
  );
}

const SIGNED = async () => ({
  success: true,
  transactionHash: TX_HASH,
  code: 0,
});

describe('link_dao_group: the preview reads the chain and sends nothing', () => {
  it('shows the entity, the group, every member, the pass rule and both risks', async () => {
    const asked = stubChain();
    const result = await linkTool().handler(ARGS, turn(SHOWN));

    expect(result).toEqual({
      status: 'confirm',
      network: 'devnet',
      entityDid: POD,
      entityType: 'pod',
      entityName: 'Neighbourhood Book Club',
      coreAddress: CORE,
      groupName: 'Neighbourhood Book Club Board',
      members: MEMBERS,
      rules: [
        'Proposals (list A): it needs 1 yes vote to pass; voting lasts 7 days; votes can be changed until voting closes, so a proposal is decided only then; only members carry out a passed proposal.',
      ],
      youAreMember: true,
      sends: ['governing-group link', 'controller'],
      notes: [],
      summary: `Link the DAO DAO group "Neighbourhood Book Club Board" (${CORE}) to the pod "Neighbourhood Book Club" (${POD}) on devnet as the group that governs it, and add the group as a controller of its identity (did:ixo:wasm:${CORE}): the group gets full control of the entity’s identity, so proposals it passes can change anything about the entity. The group has 3 members. Proposals (list A): it needs 1 yes vote to pass; voting lasts 7 days; votes can be changed until voting closes, so a proposal is decided only then; only members carry out a passed proposal. Signed from your account ${OWNER}, which stays a controller too.`,
      risks: ALL_RISKS,
      message: expect.stringMatching(
        /^Nothing was sent\. Show the user exactly what will govern their entity: .*call link_dao_group again with the same entityDid and coreAddress and riskConfirmation/,
      ),
    });
    expect(callAgAction).not.toHaveBeenCalled();
    expect([...asked].sort()).toEqual(CHECK_READS);
  });

  it('notes an entity type the Portal shows no Decisions tab for, a user who is not a member, and more members than one page', async () => {
    const many = Array.from({ length: MEMBERS_LIMIT }, (_, index) =>
      index === 0 ? MEMBERS[0] : MEMBERS[1],
    );
    stubChain({
      entity: () => json(withIid({}, 'protocol')),
      members: () =>
        json({
          data: { members: many.map((addr) => ({ addr, weight: 2 })) },
        }),
    });
    const result = await linkTool().handler(ARGS, turn(SHOWN));

    expect(result).toMatchObject({
      status: 'confirm',
      entityType: 'protocol',
      youAreMember: false,
      moreMembers: true,
      members: expect.arrayContaining([`${MEMBERS[0]} (weight 2)`]),
      notes: [
        expect.stringMatching(
          /^The entity is of type "protocol": the Portal shows a Decisions tab only for DAOs and PODs \(dao, dao\/pod, pod, protocol\/dao, protocol\/pod\)/,
        ),
        `Your account ${OWNER} is not a member of this group: once it governs the entity, you cannot propose or vote on what the group decides for it; only its members can.`,
        `It has ${MEMBERS_LIMIT} members or more; only the first ${MEMBERS_LIMIT} are listed here.`,
      ],
      summary: expect.stringContaining(
        `The group has ${MEMBERS_LIMIT} or more members.`,
      ),
    });
  });

  it('says so when the group’s votes do not come from a member list, and links it all the same', async () => {
    stubChain({
      groupContract: () =>
        wasmError(
          'codespace wasm code 9: query wasm contract failed: Error parsing into type dao_voting_token_staked::msg::QueryMsg: unknown variant `group_contract`',
        ),
    });
    const result = await linkTool().handler(ARGS, turn(SHOWN));
    expect(result).toMatchObject({
      status: 'confirm',
      notes: [
        expect.stringMatching(/^Its votes do not come from a member list/),
      ],
    });
    expect(result).not.toHaveProperty('members');
    expect(result).not.toHaveProperty('youAreMember');
  });

  it('answers without the entity’s name when the Names worker is off', async () => {
    const asked = stubChain();
    const result = await linkTool().handler(
      ARGS,
      turn(SHOWN, { config: { IXO_NAMES: 'off' } }),
    );
    expect(result).toMatchObject({
      status: 'confirm',
      summary: expect.stringContaining(`to the pod ${POD} on devnet`),
    });
    expect(result).not.toHaveProperty('entityName');
    expect(asked).not.toContain('names');
  });
});

describe('link_dao_group: refused before anything is sent', () => {
  it('refuses a user whose account the entity’s identity does not list under authentication', async () => {
    stubChain();
    await expect(
      linkTool().handler(ARGS, turn(SHOWN, { did: `did:ixo:${STRANGER}` })),
    ).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: your account ${STRANGER} cannot change ${POD}: the entity’s identity document does not list your account under authentication, and the chain adds a linked entity or a controller only for such an account. Only someone who controls the entity can link a group to it: ask them to do it, or to add your account to it first.`,
    });
    // Listed only under assertionMethod: the ante handler would pass it, the
    // IID message server would not.
    const methods = UNLINKED.iidDocument.verificationMethod;
    stubChain({
      entity: () =>
        json(
          withIid({
            authentication: [],
            assertionMethod: methods.map((method) => method.id),
          }),
        ),
    });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('cannot change'),
    });
    expect(callAgAction).not.toHaveBeenCalled();
  });

  it('refuses an address without a contract, and a contract that is not a DAO DAO core', async () => {
    stubChain({
      contract: () =>
        wasmError(`codespace wasm code 22: no such contract: address ${CORE}`),
    });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: there is no contract at ${CORE} on devnet, so it is not a DAO DAO group. Copy the group’s address exactly: \`dao\` in chain_lookup daos, or the coreAddress create_dao_group returned.`,
    });
    // The group's proposal list (code 16) given instead of its core.
    stubChain({
      contract: () => json({ address: CORE, contract_info: { code_id: '16' } }),
    });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: ${CORE} is a contract of code 16, not a DAO DAO group: a group’s address is its core contract (code 3 on devnet). Give the group’s own address (\`dao\` in chain_lookup daos), not one of its modules (its proposal list, intake or voting module).`,
    });
  });

  it('refuses a bad address or DID without reading the chain', async () => {
    const asked = stubChain();
    for (const [args, error] of [
      [
        { ...ARGS, coreAddress: `${CORE.slice(0, -1)}q` },
        /coreAddress: .*valid checksum/,
      ],
      [{ ...ARGS, coreAddress: OWNER }, /coreAddress: .*32-byte/],
      [{ ...ARGS, entityDid: OWNER_DID }, /entityDid: expected an entity DID/],
      [
        { ...ARGS, entityDid: `${POD}/../x` },
        /entityDid: expected an entity DID/,
      ],
    ] as const)
      await expect(linkTool().handler(args, turn(SHOWN))).resolves.toEqual({
        status: 'validation_error',
        error: expect.stringMatching(error),
      });
    expect(asked).toEqual([]);
  });

  it('refuses an entity the chain does not have', async () => {
    stubChain({
      entity: () => json({ code: 5, message: 'did document not found' }, 404),
    });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: the chain has no entity ${POD} on devnet. Check the DID (chain_lookup entity).`,
    });
  });

  it('refuses a group that already governs the entity', async () => {
    stubChain({ entity: () => json(LINKED) });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: the DAO DAO group ${CORE} already governs ${POD}: it is linked as its governing group and is a controller of its identity, so there is nothing to link.`,
    });
  });

  it('refuses an entity another group governs: replacing it is a separate change', async () => {
    stubChain({
      entity: () =>
        json(
          withIid({
            linkedEntity: [
              {
                type: 'Group',
                id: `{id}#${OTHER_GROUP}`,
                relationship: 'Governs',
                service: '',
              },
            ],
          }),
        ),
    });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: ${POD} is already governed by the DAO DAO group ${OTHER_GROUP}. Replacing the group that governs an entity is a separate, deliberate change (the old group’s link and its control of the entity are removed, then the new one is added), which this tool does not make; the entity’s owner can change its governance in the Portal, in the entity’s settings.`,
    });
  });

  it('refuses a link whose id the entity already has with another relationship: the chain takes one link per id', async () => {
    stubChain({
      entity: () =>
        json(
          withIid({
            linkedEntity: [
              {
                type: 'group',
                id: `{id}#${CORE}`,
                relationship: 'advises',
                service: '',
              },
            ],
          }),
        ),
    });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: `Nothing was sent: ${POD} already links ${CORE} as a "group" with relationship "advises", not as the group that governs it, and the chain takes one link per id. That link has to be removed first, in the Portal.`,
    });
  });

  it('refuses mainnet unless the oracle allows it', async () => {
    stubChain();
    await expect(
      linkTool().handler(ARGS, turn(SHOWN, { network: 'mainnet' })),
    ).resolves.toEqual({
      status: 'validation_error',
      error: expect.stringMatching(
        /IXO_TRANSACTION_ALLOW_MAINNET.*no group is linked here/,
      ),
    });
    // Allowed: mainnet's dao_core is code 3 too.
    await expect(
      linkTool({ IXO_TRANSACTION_ALLOW_MAINNET: 'true' }).handler(
        ARGS,
        turn(SHOWN, { network: 'mainnet' }),
      ),
    ).resolves.toMatchObject({ status: 'confirm', network: 'mainnet' });
  });

  it('refuses a confirmation that misses or rewords a risk, and keeps the preview', async () => {
    stubChain();
    const tool = linkTool();
    await tool.handler(ARGS, turn(SHOWN));
    for (const acceptedRisks of [
      LINK_RISKS,
      [...LINK_RISKS, 'Adds a controller.'],
    ])
      await expect(
        tool.handler(
          { ...ARGS, riskConfirmation: { confirmed: true, acceptedRisks } },
          turn(CONFIRMED),
        ),
      ).resolves.toEqual({
        status: 'validation_error',
        error: expect.stringMatching(/Risk confirmation required/),
      });
    expect(callAgAction).not.toHaveBeenCalled();
    // The preview was not spent: the full confirmation still signs.
    callAgAction.mockImplementationOnce(SIGNED);
    await expect(
      tool.handler({ ...ARGS, riskConfirmation: acceptAll }, turn(CONFIRMED)),
    ).resolves.toMatchObject({ status: 'linked' });
  });

  it('refuses to sign in the request that showed it, or without a preview', async () => {
    stubChain();
    const tool = linkTool();
    await expect(
      tool.handler({ ...ARGS, riskConfirmation: acceptAll }, turn(CONFIRMED)),
    ).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: expect.stringMatching(
        /^Nothing was sent: this exact link_dao_group call .* was not shown to the user first/,
      ),
    });
    await tool.handler(ARGS, turn(SHOWN));
    await expect(
      tool.handler({ ...ARGS, riskConfirmation: acceptAll }, turn(SHOWN)),
    ).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: expect.stringMatching(
        /^Nothing was sent: the summary was shown in this same turn\./,
      ),
    });
    expect(callAgAction).not.toHaveBeenCalled();
  });
});

describe('link_dao_group: signed in the wallet and read back', () => {
  it('sends both messages as one batch, reads the transaction back and answers linked with the Decisions link', async () => {
    const asked = stubChain();
    const result = await previewThenSign(SIGNED);

    expect(result).toEqual({
      status: 'linked',
      network: 'devnet',
      entityDid: POD,
      coreAddress: CORE,
      txHash: TX_HASH,
      decisionsUrl: `https://dev.portal.qi.space/domain/${POD}/overview?tab=decisions`,
      message: expect.stringMatching(/^The group governs the entity now/),
    });
    const sent = sentArgs();
    expect(callAgAction.mock.calls[0]?.[0].toolCallId).toMatch(
      /^dao_link_group_req-confirmed_/,
    );
    expect(sent).toMatchObject({
      network: 'devnet',
      chainId: 'devnet-1',
      intent: {
        source: 'batch',
        summary: expect.stringMatching(/^Link the DAO DAO group /),
      },
      risks: ALL_RISKS,
    });
    // The messages the Portal sends for a POD's group, as devnet carried them.
    expect(sent.messages).toEqual([
      {
        typeUrl: '/ixo.iid.v1beta1.MsgAddLinkedEntity',
        value: {
          id: POD,
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
          id: POD,
          controllerDid: `did:ixo:wasm:${CORE}`,
          signer: OWNER,
        },
      },
    ]);
    // The check ran before the preview and again before the wallet.
    expect(asked.filter((what) => what === 'entity')).toHaveLength(2);
    expect(asked.at(-1)).toBe('tx');

    // Linked once: the chain now shows it, and a new preview says so.
    stubChain({ entity: () => json(LINKED) });
    await expect(
      linkTool().handler(ARGS, turn('req-later')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('already governs'),
    });
  });

  it('after a partial link, sends only the missing controller (and only its risk)', async () => {
    stubChain({
      entity: () =>
        json(
          withIid({
            linkedEntity: linkedPod.iidDocument.linkedEntity,
          }),
        ),
      // The transaction carries the one controller message.
      tx: () =>
        json({
          ...linkTx,
          tx: {
            body: {
              messages: linkTx.tx.body.messages.filter(
                (message) =>
                  message['@type'] === '/ixo.iid.v1beta1.MsgAddController',
              ),
            },
          },
        }),
    });
    const preview = await linkTool().handler(ARGS, turn(SHOWN));
    expect(preview).toMatchObject({
      status: 'confirm',
      sends: ['controller'],
      risks: CONTROLLER_RISKS,
      notes: [
        'The group is already linked as the entity’s governing group; only its controller entry is missing, so only that is sent.',
      ],
      summary: expect.stringMatching(
        /^Add the DAO DAO group "Neighbourhood Book Club Board" \(ixo1add3.*\), already linked as the group that governs the pod "Neighbourhood Book Club"/,
      ),
    });
    callAgAction.mockImplementationOnce(SIGNED);
    const result = await linkTool().handler(
      {
        ...ARGS,
        riskConfirmation: { confirmed: true, acceptedRisks: CONTROLLER_RISKS },
      },
      turn(CONFIRMED),
    );
    expect(result).toMatchObject({ status: 'linked', txHash: TX_HASH });
    expect(sentArgs().messages).toEqual([
      {
        typeUrl: '/ixo.iid.v1beta1.MsgAddController',
        value: {
          id: POD,
          controllerDid: `did:ixo:wasm:${CORE}`,
          signer: OWNER,
        },
      },
    ]);
  });

  it('sends only the link when the group is already a controller', async () => {
    stubChain({
      entity: () =>
        json(withIid({ controller: linkedPod.iidDocument.controller })),
    });
    await expect(linkTool().handler(ARGS, turn(SHOWN))).resolves.toMatchObject({
      status: 'confirm',
      sends: ['governing-group link'],
      risks: LINK_RISKS,
      summary: expect.stringContaining(
        'The group is already a controller of its identity',
      ),
    });
  });

  it('answers failed with the chain’s reason when the transaction failed in its block, and lets it be sent again', async () => {
    stubChain({
      tx: () =>
        json({
          ...linkTx,
          tx_response: {
            ...linkTx.tx_response,
            code: 4,
            codespace: 'iid',
            raw_log: `failed to execute message; message index: 0: signer account ${OWNER} not authorized to update the target did document at ${POD}: unauthorized`,
          },
        }),
    });
    const result = await previewThenSign(SIGNED);
    expect(result).toMatchObject({
      status: 'failed',
      network: 'devnet',
      chainId: 'devnet-1',
      code: 4,
      transactionHash: TX_HASH,
      height: linkTx.tx_response.height,
      error: expect.stringMatching(
        /^The transaction failed on chain \(code 4 in iid\)/,
      ),
      hint: expect.stringMatching(
        /^The chain changes an entity’s identity only for an account/,
      ),
    });
    // Released: the same link can be shown again.
    await expect(
      linkTool().handler(ARGS, turn('req-later')),
    ).resolves.toMatchObject({
      status: 'confirm',
    });
  });

  it('answers signed, never resending, when the transaction is not readable or does not carry the link', async () => {
    // Another transaction under that hash: not the link sent.
    stubChain({
      tx: () =>
        json({
          ...linkTx,
          tx: { body: { messages: [] } },
        }),
    });
    const other = await previewThenSign(SIGNED);
    expect(other).toEqual({
      status: 'signed',
      network: 'devnet',
      entityDid: POD,
      coreAddress: CORE,
      txHash: TX_HASH,
      decisionsUrl: `https://dev.portal.qi.space/domain/${POD}/overview?tab=decisions`,
      message: expect.stringMatching(
        /^The wallet reports the link signed, but its transaction does not carry the link this conversation sent\. Do not send it again/,
      ),
    });
    // The chain still shows no link: the same link is not shown again.
    await expect(linkTool().handler(ARGS, turn('req-later'))).resolves.toEqual({
      status: 'refused',
      retryable: false,
      message: expect.stringMatching(
        /^Nothing was sent: this link was sent to the user’s wallet earlier in this conversation and its outcome is not known/,
      ),
    });
  });

  it('answers a timeout as an unknown outcome that keeps the write claim, and never sends it again', async () => {
    const asked = stubChain();
    const result = await previewThenSign(async () => ({ outcome: 'unknown' }));
    expect(result).toMatchObject({ status: 'timeout', outcome: 'unknown' });
    expect(
      uncertainResultReason(
        new ToolMessage({
          tool_call_id: 'call-1',
          name: 'link_dao_group',
          content: JSON.stringify(result),
        }),
      ),
    ).toBe('outcome unknown');
    expect(asked).not.toContain('tx');
    await expect(
      linkTool().handler(ARGS, turn('req-later')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('its outcome is not known'),
    });
    // Once the chain shows it linked, that is the answer.
    stubChain({ entity: () => json(LINKED) });
    await expect(
      linkTool().handler(ARGS, turn('req-later')),
    ).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining('already governs'),
    });
  });

  it('passes the wallet’s reason on with a plain hint, and a declined link can be shown again', async () => {
    stubChain();
    const error = await previewThenSign(async () => {
      throw new Error(
        `Broadcasting transaction failed with code 4 (codespace: sdk). Log: failed to execute message; message index: 0: signer account ${OWNER} not authorized to act on behalf of the did ${POD}: unauthorized`,
      );
    });
    expect(error).toMatchObject({
      status: 'error',
      hint: expect.stringMatching(/^The chain changes an entity’s identity/),
    });
    const declined = await previewThenSign(async () => {
      throw new Error('Request rejected by user');
    });
    expect(declined).toMatchObject({ status: 'rejected' });
    expect(declined).not.toHaveProperty('hint');
  });
});

describe('linkHint', () => {
  it('explains the chain’s link refusals and nothing else', () => {
    expect(
      linkHint(
        'failed to execute message; message index: 0: duplicated linked entity id {id}#ixo1…: invalid input',
      ),
    ).toMatch(/already has this link/);
    expect(linkHint('did document at did:ixo:entity:00 not found')).toMatch(
      /no identity document/,
    );
    expect(linkHint('out of gas')).toBeUndefined();
  });
});
