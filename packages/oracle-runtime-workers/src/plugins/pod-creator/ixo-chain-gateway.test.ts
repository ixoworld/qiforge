import { validateTransactionBatch, type Network } from '@ixo/ixo-transaction';
import { TxMsgData } from '@ixo/impactxclient-sdk/module/codegen/cosmos/base/abci/v1beta1/abci.js';
import { MsgCreateEntityResponse } from '@ixo/impactxclient-sdk/module/codegen/ixo/entity/v1beta1/tx.js';
import { Verification } from '@ixo/impactxclient-sdk/module/codegen/ixo/iid/v1beta1/tx.js';
import protobuf from 'protobufjs/minimal.js';
import { bytesToHex } from '@noble/hashes/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type { RuntimeContext } from '../../plugin-api/types';
import { resetUpstreamHealth, sleep, throwIfAborted } from '../ixo-chain/http';
import type { ServicePodBlueprint } from './blueprint-types';
import { podBatchProblem, type SentPodBatch } from './chain-gateway';
import { POD_RELAYER_NODE_DIDS } from './config';
import { podDomainCardDocument } from './domain-card';
import {
  createIxoChainGateway,
  podProfileDocument,
  type IxoChainGatewayDeps,
} from './ixo-chain-gateway';
import { documentProof } from './matrix-media';

/*
 * The owner: a devnet account and its secp256k1 key as the chain holds them
 * (`/cosmos/auth/v1beta1/accounts`), and the verification methods its
 * Portal-made IID document carries (`/ixo/did/dids/{did}`), copied from
 * devnet. `OTHER_KEY` is a valid compressed key of another account.
 */
const ADDRESS = 'ixo1rkzv9eyj3kx3w2gwlu0aj6qpwvladnuudff3uf';
const DID = `did:ixo:${ADDRESS}`;
const KEY_BASE64 = 'A+176MGmSu6RQkRqOYHgPq85vf8JrSWgxBYNzV/IDoAA';
const KEY_HEX =
  '03ed7be8c1a64aee9142446a3981e03eaf39bdff09ad25a0c4160dcd5fc80e8000';
const KEY_BASE58 = '2AfzKgoz4yFqvsNqccr8jeJCkvSE3QW57SBw1ZJYNVyyZ';
const OTHER_KEY_HEX =
  '03b5c433c4c77ff4ec1c55037b0fb6ebd0cb9841b1a4e21dcfc403074415a3b288';

const ENTITY = 'did:ixo:entity:382f95b0e05228e6b3ffb0a96858bf44';
const TX_HASH =
  '205377CE1870BD1474BFC3C283BA60FE7165EE34F463D3B15DDEEDB04B110333';
const NOW = new Date('2026-11-08T10:00:00.000Z');
const HOMESERVER = 'https://matrix.example';
const MXC = 'mxc://matrix.example/AbCdEf123';
const DOWNLOAD = `${HOMESERVER}/_matrix/media/v3/download/matrix.example/AbCdEf123`;
const PROFILE = { name: 'Solar POD', description: 'Monitors community solar.' };
const PROFILE_TEXT = JSON.stringify(podProfileDocument(PROFILE));

const BLUEPRINT: ServicePodBlueprint = {
  threadId: 'session-1',
  stages: {
    qualify: [],
    architect: [],
    build: [],
    evaluate: [],
    package: [],
    gate: [],
  },
  assembledAt: NOW.toISOString(),
};

const REST: Record<Network, string> = {
  mainnet: 'https://impacthub.ixo.world/rest',
  testnet: 'https://testnet.ixo.earth/rest',
  devnet: 'https://devnet.ixo.earth/rest',
};

/**
 * The owner's verification methods, as the Portal-made IID document lists
 * them on devnet: what the Portal's `createIidVerificationMethods` makes.
 */
const OWNER_VERIFICATIONS = [
  {
    relationships: ['authentication'],
    method: {
      id: DID,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: DID,
      publicKeyBase58: KEY_BASE58,
    },
  },
  {
    relationships: ['authentication'],
    method: {
      id: `${DID}#${KEY_HEX}`,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: DID,
      publicKeyMultibase: `F${KEY_HEX}`,
    },
  },
  {
    relationships: ['authentication'],
    method: {
      id: `${DID}#${KEY_BASE58}`,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: DID,
      publicKeyBase58: KEY_BASE58,
    },
  },
  {
    relationships: ['authentication'],
    method: {
      id: `${DID}#${ADDRESS}`,
      type: 'CosmosAccountAddress',
      controller: DID,
      blockchainAccountID: ADDRESS,
    },
  },
];

const OWNER_METHODS = OWNER_VERIFICATIONS.map((entry) => entry.method);
/** The owner's account by address alone (no key material). */
const ACCOUNT_METHOD = {
  id: `${DID}#${ADDRESS}`,
  type: 'CosmosAccountAddress',
  controller: DID,
  blockchainAccountID: ADDRESS,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const NOT_FOUND = () =>
  json({ code: 5, message: 'not found', details: [] }, 404);

const baseAccount = (pubKey: unknown) => ({
  account: {
    '@type': '/cosmos.auth.v1beta1.BaseAccount',
    address: ADDRESS,
    pub_key: pubKey,
    account_number: '9622',
    sequence: '13',
  },
});

const SECP_PUB_KEY = {
  '@type': '/cosmos.crypto.secp256k1.PubKey',
  key: KEY_BASE64,
};

/** An IID document of the owner; every method under `authentication` unless told otherwise. */
const iidDocument = <Method extends { id: string }>(
  verificationMethod: Method[],
  relationships: { authentication?: string[]; assertionMethod?: string[] } = {
    authentication: verificationMethod.map((method) => method.id),
  },
) => ({
  iidDocument: {
    id: DID,
    verificationMethod,
    authentication: relationships.authentication ?? [],
    assertionMethod: relationships.assertionMethod ?? [],
    keyAgreement: [],
  },
});

/** The owner's document as devnet holds it. */
const OWNER_IID = () => json(iidDocument(OWNER_METHODS));

/** A request the fake upstream saw. */
interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type Handler = (
  n: number,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

/**
 * A fake chain REST + homeserver + domain indexer: each route answers from
 * its handler (a function of how often it was asked), and every request is
 * recorded.
 */
function upstream(routes: {
  account?: Handler;
  iid?: Handler;
  create?: Handler;
  put?: Handler;
  tx?: Handler;
  index?: Handler;
}) {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body;
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body:
        body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : typeof body === 'string'
            ? body
            : null,
    });
    const route = url.includes('/cosmos/auth/v1beta1/accounts/')
      ? 'account'
      : url.includes('/ixo/did/dids/')
        ? 'iid'
        : url.endsWith('/_matrix/media/v1/create')
          ? 'create'
          : url.includes('/_matrix/media/v3/upload/')
            ? 'put'
            : url.includes('/cosmos/tx/v1beta1/txs/')
              ? 'tx'
              : url.endsWith('/index')
                ? 'index'
                : null;
    const handler = route ? routes[route] : undefined;
    if (!route || !handler) throw new Error(`unexpected request ${url}`);
    const n = (counts.get(route) ?? 0) + 1;
    counts.set(route, n);
    return handler(n, init);
  };
  return { fetchImpl, seen };
}

/** A request context of the owner, whose plugin device is on `HOMESERVER`. */
function ownerCtx(over: Partial<RuntimeContext> = {}): RuntimeContext {
  const base = makeRuntimeContext();
  return {
    ...base,
    user: { ...base.user, did: DID },
    config: { NETWORK: 'testnet' },
    kv: createMemoryUserKv(),
    matrix: {
      ...base.matrix,
      botCredentials: async () => ({
        baseUrl: `${HOMESERVER}/`,
        userId: '@oracle:matrix.example',
        accessToken: 'plugin-device-token',
        deviceId: 'PLUGINS',
      }),
    },
    ...over,
  };
}

/**
 * The clock: `Date` is faked and every wait (the poll's, a read's retry)
 * moves it on at once, so the time budgets run on that clock without a
 * real wait.
 */
const advance = vi.fn(async (ms: number, signal: AbortSignal) => {
  throwIfAborted(signal);
  vi.setSystemTime(Date.now() + ms);
});

function gateway(
  fetchImpl: typeof fetch,
  over: Partial<IxoChainGatewayDeps> = {},
) {
  return createIxoChainGateway({
    fetch: fetchImpl,
    now: () => NOW,
    sleep: advance,
    ...over,
  });
}

const RESERVED = () =>
  json({ content_uri: MXC, unused_expires_at: Date.now() + 86_400_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetUpstreamHealth();
  advance.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const prepare = (
  fetchImpl: typeof fetch,
  ctx: RuntimeContext = ownerCtx(),
  network: Network = 'testnet',
) =>
  gateway(fetchImpl).preparePodBatch(
    { blueprint: BLUEPRINT, network, profile: PROFILE },
    ctx,
  );

describe('preparePodBatch', () => {
  it('reserves the profile without publishing it and returns one MsgCreateEntity the catalog and the POD check accept', async () => {
    const { fetchImpl, seen } = upstream({ iid: OWNER_IID, create: RESERVED });
    const prepared = await prepare(fetchImpl);

    // The IID document has the owner's key: the account is not read, and
    // the profile is reserved, not uploaded.
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${REST.testnet}/ixo/did/dids/${DID}`,
      `POST ${HOMESERVER}/_matrix/media/v1/create`,
    ]);
    expect(seen[1]?.headers.get('authorization')).toBe(
      'Bearer plugin-device-token',
    );
    expect(prepared).toEqual({
      ok: true,
      summary: `Create the POD on testnet, owned by you (${ADDRESS}). Its public profile: name "Solar POD"; description "Monitors community solar.".`,
      documents: [
        {
          mxc: MXC,
          contentType: 'application/ld+json',
          filename: 'profile.json',
          text: PROFILE_TEXT,
        },
      ],
      messages: [
        {
          typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
          value: {
            entityType: 'pod',
            entityStatus: 0,
            controller: [DID],
            context: [],
            verification: OWNER_VERIFICATIONS,
            service: [],
            accordedRight: [],
            linkedResource: [
              {
                id: '{id}#pro',
                type: 'Settings',
                description: 'Profile',
                mediaType: 'application/json',
                serviceEndpoint: DOWNLOAD,
                proof: documentProof(PROFILE_TEXT),
                encrypted: 'false',
                right: '',
              },
            ],
            linkedEntity: [],
            linkedClaim: [],
            startDate: '2026-11-08T10:00:00.000Z',
            endDate: '2126-10-15T10:00:00.000Z',
            relayerNode: POD_RELAYER_NODE_DIDS.testnet,
            ownerDid: DID,
            ownerAddress: ADDRESS,
          },
        },
      ],
    });
    if (!prepared.ok) throw new Error('not prepared');

    // The Portal decodes the proto-JSON with the SDK's `fromJSON` before
    // signing: every verification field survives it (`context` defaults).
    const verification = prepared.messages[0]?.value.verification;
    expect(Array.isArray(verification)).toBe(true);
    expect(
      (Array.isArray(verification) ? verification : []).map((entry) =>
        Verification.toJSON(Verification.fromJSON(entry)),
      ),
    ).toEqual(OWNER_VERIFICATIONS.map((entry) => ({ ...entry, context: [] })));

    const batch = validateTransactionBatch({
      messages: prepared.messages,
      summary: prepared.summary,
      network: 'testnet',
    });
    expect(podBatchProblem(batch.routes)).toBeNull();
    // Validation keeps every field as the gateway wrote it.
    expect(batch.messages).toEqual(prepared.messages);
  });

  it('builds the profile document in the Portal shape', () => {
    expect(podProfileDocument({ name: 'Solar POD' })).toEqual({
      '@context': {
        ixo: 'https://w3id.org/ixo/ns/protocol/',
        '@id': '@type',
        type: '@type',
        '@protected': false,
      },
      id: 'ixo:entity#profile',
      type: 'profile',
      orgName: 'Solar POD',
      name: 'Solar POD',
      image: '',
      logo: '',
      brand: 'Solar POD',
      location: '',
      description: '',
    });
  });

  it('keeps the longest name and description within the summary the catalog accepts', async () => {
    const { fetchImpl } = upstream({ iid: OWNER_IID, create: RESERVED });
    const prepared = await gateway(fetchImpl).preparePodBatch(
      {
        blueprint: BLUEPRINT,
        network: 'testnet',
        profile: { name: 'n'.repeat(100), description: 'd'.repeat(600) },
      },
      ownerCtx(),
    );
    if (!prepared.ok) throw new Error('not prepared');
    expect(prepared.summary).toContain(`"${'d'.repeat(600)}"`);
    expect(() =>
      validateTransactionBatch({
        messages: prepared.messages,
        summary: prepared.summary,
        network: 'testnet',
      }),
    ).not.toThrow();
  });

  it.each(['devnet', 'testnet', 'mainnet'] as const)(
    'reads %s chain REST and names that network’s Portal relayer node',
    async (network) => {
      const { fetchImpl, seen } = upstream({
        iid: OWNER_IID,
        create: RESERVED,
      });
      // The network passed in wins over the config's.
      const prepared = await prepare(fetchImpl, ownerCtx(), network);
      expect(seen[0]?.url).toBe(`${REST[network]}/ixo/did/dids/${DID}`);
      if (!prepared.ok) throw new Error('not prepared');
      expect(prepared.messages[0]?.value.relayerNode).toBe(
        POD_RELAYER_NODE_DIDS[network],
      );
      expect(prepared.summary).toContain(`on ${network},`);
    },
  );

  it('names the operator’s relayer node when configured', async () => {
    const relayer = 'did:ixo:entity:0123456789abcdef0123456789abcdef';
    const { fetchImpl } = upstream({ iid: OWNER_IID, create: RESERVED });
    const prepared = await prepare(
      fetchImpl,
      ownerCtx({
        config: { NETWORK: 'testnet', POD_CREATOR_RELAYER_NODE_DID: relayer },
      }),
    );
    if (!prepared.ok) throw new Error('not prepared');
    expect(prepared.messages[0]?.value.relayerNode).toBe(relayer);
  });

  it('accepts an account the IID document lists only under assertionMethod, as the chain does', async () => {
    const { fetchImpl } = upstream({
      iid: () =>
        json(
          iidDocument(OWNER_METHODS, {
            authentication: [],
            assertionMethod: [`${DID}#${KEY_HEX}`],
          }),
        ),
      create: RESERVED,
    });
    await expect(prepare(fetchImpl)).resolves.toMatchObject({ ok: true });
  });

  it('refuses, reserving nothing, when the owner has no IID document', async () => {
    const { fetchImpl, seen } = upstream({ iid: NOT_FOUND });
    await expect(prepare(fetchImpl)).resolves.toEqual({
      ok: false,
      retryable: false,
      message: expect.stringMatching(
        new RegExp(`^Your identity ${DID} is not on chain yet`),
      ),
    });
    expect(seen).toHaveLength(1);
  });

  it.each([
    [
      'lists the account under no signer relationship',
      iidDocument(OWNER_METHODS, {
        authentication: [],
        assertionMethod: [],
      }),
    ],
    [
      'names only methods of another account',
      iidDocument([
        {
          id: `${DID}#other`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: DID,
          publicKeyHex: OTHER_KEY_HEX,
        },
        {
          id: `${DID}#ixo1other`,
          type: 'CosmosAccountAddress',
          controller: DID,
          blockchainAccountID: 'ixo1someoneelse',
        },
      ]),
    ],
    [
      'lists a method of the account only under keyAgreement',
      {
        iidDocument: {
          ...iidDocument(OWNER_METHODS, {}).iidDocument,
          keyAgreement: OWNER_METHODS.map((method) => method.id),
        },
      },
    ],
  ])(
    'refuses when the IID document %s, as the chain would',
    async (_case, document) => {
      const { fetchImpl, seen } = upstream({ iid: () => json(document) });
      await expect(prepare(fetchImpl)).resolves.toEqual({
        ok: false,
        retryable: false,
        message: expect.stringMatching(
          new RegExp(
            `^Your identity document does not list your account ${ADDRESS} under authentication or assertionMethod`,
          ),
        ),
      });
      expect(seen).toHaveLength(1);
    },
  );

  it('takes the account’s key when the IID document lists the account by address only', async () => {
    for (const account of [
      () => json(baseAccount(SECP_PUB_KEY)),
      () =>
        json({
          account: {
            '@type': '/cosmos.vesting.v1beta1.ContinuousVestingAccount',
            base_vesting_account: {
              base_account: baseAccount(SECP_PUB_KEY).account,
              original_vesting: [],
              end_time: '0',
            },
            start_time: '0',
          },
        }),
    ]) {
      const { fetchImpl, seen } = upstream({
        iid: () => json(iidDocument([ACCOUNT_METHOD])),
        account,
        create: RESERVED,
      });
      const prepared = await prepare(fetchImpl);
      expect(seen[1]?.url).toBe(
        `${REST.testnet}/cosmos/auth/v1beta1/accounts/${ADDRESS}`,
      );
      if (!prepared.ok) throw new Error('not prepared');
      expect(prepared.messages[0]?.value.verification).toEqual(
        OWNER_VERIFICATIONS,
      );
    }
  });

  it('prefers the IID document’s key of the account over other keys it lists', async () => {
    const { fetchImpl } = upstream({
      iid: () =>
        json(
          iidDocument([
            {
              id: `${DID}#other`,
              type: 'EcdsaSecp256k1VerificationKey2019',
              controller: DID,
              publicKeyMultibase: `F${OTHER_KEY_HEX}`,
            },
            {
              id: `${DID}#ed`,
              type: 'Ed25519VerificationKey2018',
              controller: DID,
              publicKeyBase58: '218rZWSC5FBTBTLqELCremcKe43Mdb5KRgHMai6N8quc',
            },
            ACCOUNT_METHOD,
            {
              id: `${DID}#${KEY_HEX}`,
              type: 'EcdsaSecp256k1VerificationKey2019',
              controller: DID,
              publicKeyMultibase: `F${KEY_HEX}`,
            },
          ]),
        ),
      create: RESERVED,
    });
    const prepared = await prepare(fetchImpl);
    if (!prepared.ok) throw new Error('not prepared');
    expect(prepared.messages[0]?.value.verification).toEqual(
      OWNER_VERIFICATIONS,
    );
  });

  it('refuses clearly, reserving nothing, when neither the IID document nor the account has a key of this account', async () => {
    for (const account of [
      NOT_FOUND,
      () => json(baseAccount(null)),
      () =>
        json(
          baseAccount({
            '@type': '/cosmos.crypto.secp256k1.PubKey',
            // A real key, but not this account's.
            key: btoa(
              String.fromCharCode(
                ...(OTHER_KEY_HEX.match(/../g) ?? []).map((byte) =>
                  parseInt(byte, 16),
                ),
              ),
            ),
          }),
        ),
    ]) {
      const { fetchImpl, seen } = upstream({
        iid: () => json(iidDocument([ACCOUNT_METHOD])),
        account,
      });
      await expect(prepare(fetchImpl)).resolves.toEqual({
        ok: false,
        retryable: false,
        message: expect.stringMatching(
          new RegExp(
            `^There is no public key on chain yet for your account ${ADDRESS}`,
          ),
        ),
      });
      expect(seen.some((request) => request.url.includes('/_matrix/'))).toBe(
        false,
      );
    }
  });

  it('refuses a user whose DID is not an IXO account before any request', async () => {
    const { fetchImpl, seen } = upstream({});
    const base = ownerCtx();
    await expect(
      prepare(fetchImpl, {
        ...base,
        user: { ...base.user, did: 'did:key:z6Mkabc' },
      }),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      message: expect.stringMatching(/^Your identity is not an IXO account/),
    });
    expect(seen).toEqual([]);
  });

  it('refuses, to be tried again, while the chain node is unavailable', async () => {
    const { fetchImpl, seen } = upstream({ iid: () => json({}, 503) });
    await expect(prepare(fetchImpl)).resolves.toEqual({
      ok: false,
      retryable: true,
      message: expect.stringMatching(
        /^Could not read your identity from the chain: /,
      ),
    });
    // The read's one retry, waited on the injected clock.
    expect(seen).toHaveLength(2);
    expect(advance).toHaveBeenCalledOnce();
  });

  it('refuses an IID answer in an unexpected shape, not to be tried again', async () => {
    const { fetchImpl } = upstream({ iid: () => json({ nothing: true }) });
    await expect(prepare(fetchImpl)).resolves.toEqual({
      ok: false,
      retryable: false,
      message: expect.stringMatching(
        /Could not read your identity.*unexpected shape/,
      ),
    });
  });

  it('passes the homeserver’s refusal on (the reservation is covered in matrix-media.test.ts)', async () => {
    const { fetchImpl } = upstream({
      iid: OWNER_IID,
      create: () => json({ errcode: 'M_FORBIDDEN' }, 403),
    });
    await expect(prepare(fetchImpl)).resolves.toEqual({
      ok: false,
      retryable: false,
      message: expect.stringMatching(
        /refused reserving the document \(HTTP 403/,
      ),
    });
  });

  it('keeps every step within one prepare budget', async () => {
    // A slow identity read leaves less than an attempt's time: the
    // homeserver is not asked.
    const { fetchImpl, seen } = upstream({
      iid: () => {
        vi.setSystemTime(Date.now() + 4_600);
        return OWNER_IID();
      },
      create: RESERVED,
    });
    await expect(
      gateway(fetchImpl, { prepareBudgetMs: 5_000 }).preparePodBatch(
        { blueprint: BLUEPRINT, network: 'testnet', profile: PROFILE },
        ownerCtx(),
      ),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      message: 'The homeserver step ran out of time; try again in a moment.',
    });
    expect(seen).toHaveLength(1);
  });
});

describe('publishDocuments', () => {
  it('uploads each pending document to its reserved media id', async () => {
    const { fetchImpl, seen } = upstream({ put: () => json({}) });
    await expect(
      gateway(fetchImpl).publishDocuments(
        {
          documents: [
            {
              mxc: MXC,
              contentType: 'application/ld+json',
              filename: 'profile.json',
              text: PROFILE_TEXT,
            },
          ],
        },
        ownerCtx(),
      ),
    ).resolves.toEqual({ ok: true });
    expect(
      seen.map((request) => [request.method, request.url, request.body]),
    ).toEqual([
      [
        'PUT',
        `${HOMESERVER}/_matrix/media/v3/upload/matrix.example/AbCdEf123?filename=profile.json`,
        PROFILE_TEXT,
      ],
    ]);
  });
});

/* ── confirmPodCreation ───────────────────────────────────────────────── */

const attr = (key: string, value: string) => ({ key, value, index: true });

const ENTITY_EVENT = (over: { type?: string; signer?: string } = {}) => ({
  type: 'ixo.entity.v1beta1.EntityCreatedEvent',
  attributes: [
    attr(
      'entity',
      JSON.stringify({
        id: ENTITY,
        type: over.type ?? 'pod',
        status: 0,
        relayer_node: POD_RELAYER_NODE_DIDS.testnet,
        accounts: [{ name: 'admin', address: 'ixo1admin' }],
      }),
    ),
    attr('signer', JSON.stringify(over.signer ?? DID)),
    attr('msg_index', '0'),
  ],
});

const MINT_EVENT = (owner = ADDRESS) => ({
  type: 'wasm',
  attributes: [
    attr(
      '_contract_address',
      'ixo14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9sqa3vn7',
    ),
    attr('action', 'mint'),
    attr('minter', 'ixo1g7xtrvc8ejkenee8a3gryvx6d4n9uu6gpsx63z'),
    attr('owner', owner),
    attr('token_id', ENTITY),
    attr('msg_index', '0'),
  ],
});

/** `TxMsgData` with one `MsgCreateEntityResponse`, hex as chain REST gives it. */
function responseData(entityId = ENTITY, entityType = 'pod'): string {
  // An explicit array writer: protobufjs's default Buffer writer fails
  // under workerd's Buffer polyfill.
  const value = MsgCreateEntityResponse.encode(
    { entityId, entityType, entityStatus: 0 },
    new protobuf.Writer(),
  ).finish();
  return bytesToHex(
    TxMsgData.encode(
      {
        data: [],
        msgResponses: [
          { typeUrl: '/ixo.entity.v1beta1.MsgCreateEntityResponse', value },
        ],
      },
      new protobuf.Writer(),
    ).finish(),
  ).toUpperCase();
}

/** The `MsgCreateEntity` as chain REST shows it in the transaction body (a real devnet shape). */
const BODY_MESSAGE = (
  over: { proof?: string; ownerDid?: string } = {},
): Record<string, unknown> => ({
  '@type': '/ixo.entity.v1beta1.MsgCreateEntity',
  entity_type: 'pod',
  entity_status: 0,
  controller: [DID],
  context: [],
  service: [],
  accorded_right: [],
  linked_resource: [
    {
      type: 'Settings',
      id: '{id}#pro',
      description: 'Profile',
      mediaType: 'application/json',
      serviceEndpoint: DOWNLOAD,
      proof: over.proof ?? documentProof(PROFILE_TEXT),
      encrypted: 'false',
      right: '',
    },
  ],
  linked_entity: [],
  start_date: '2026-11-08T10:00:00.000Z',
  end_date: '2126-10-15T10:00:00.000Z',
  relayer_node: POD_RELAYER_NODE_DIDS.testnet,
  credentials: [],
  owner_did: over.ownerDid ?? DID,
  owner_address: ADDRESS,
  data: null,
  alsoKnownAs: '',
  linked_claim: [],
});

/** What the conversation sent for signing: the prepared message (its profile proof is what binds). */
const SENT: SentPodBatch = {
  messages: [
    {
      typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
      value: {
        entityType: 'pod',
        linkedResource: [
          {
            id: '{id}#pro',
            type: 'Settings',
            serviceEndpoint: DOWNLOAD,
            proof: documentProof(PROFILE_TEXT),
          },
        ],
        ownerDid: DID,
      },
    },
  ],
  profile: PROFILE,
};

function txAnswer(
  over: {
    code?: number;
    events?: unknown[];
    data?: string;
    txhash?: string;
    messages?: unknown[];
  } = {},
) {
  return json({
    tx: { body: { messages: over.messages ?? [BODY_MESSAGE()], memo: '' } },
    tx_response: {
      height: '15816221',
      txhash: over.txhash ?? TX_HASH,
      codespace: over.code ? 'entity' : '',
      code: over.code ?? 0,
      data: over.data ?? responseData(),
      raw_log: over.code ? 'owner does not match signer' : '',
      logs: [],
      info: '',
      gas_wanted: '500000',
      gas_used: '400000',
      timestamp: '2026-11-08T10:00:05Z',
      events: over.events ?? [MINT_EVENT(), ENTITY_EVENT()],
    },
  });
}

function confirm(
  tx: Handler,
  over: Partial<IxoChainGatewayDeps> = {},
  ctx: RuntimeContext = ownerCtx(),
) {
  const { fetchImpl, seen } = upstream({ tx });
  const result = gateway(fetchImpl, over).confirmPodCreation(
    { txHash: TX_HASH, network: 'testnet', sent: SENT },
    ctx,
  );
  return { result, seen };
}

const CREATED = {
  status: 'created',
  podDid: ENTITY,
  summary: `Your POD ${ENTITY} was created on testnet in block 15816221.`,
};

describe('confirmPodCreation', () => {
  it('looks the transaction up again while the node does not have it yet, then resolves the POD', async () => {
    const { result, seen } = confirm((n) => (n < 3 ? NOT_FOUND() : txAnswer()));
    await expect(result).resolves.toEqual(CREATED);
    expect(seen.map((request) => request.url)).toEqual(
      Array(3).fill(`${REST.testnet}/cosmos/tx/v1beta1/txs/${TX_HASH}`),
    );
    expect(advance.mock.calls.map(([ms]) => ms)).toEqual([2_000, 2_000]);
  });

  it('answers pending within its budget when the transaction never appears, saying how long it looked', async () => {
    const { result, seen } = confirm(NOT_FOUND);
    await expect(result).resolves.toEqual({
      status: 'pending',
      retryable: true,
      message: `The chain has no transaction ${TX_HASH} after 18 s: it may not be in a block yet. Call confirm_pod_creation again in a moment with the same hash.`,
    });
    // Asked every 2 s while a wait and one more read fit in the 20 s.
    expect(seen).toHaveLength(10);
  });

  it.each([
    ['rate limiting (429)', () => json({ code: 8 }, 429)],
    ['a gateway error (502)', () => json({}, 502)],
    ['an unavailable node (503)', () => json({}, 503)],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])(
    'keeps looking through %s and resolves the POD once the node answers',
    async (_case, failure) => {
      const { result, seen } = confirm((n) =>
        n <= 2 ? failure() : txAnswer(),
      );
      await expect(result).resolves.toEqual(CREATED);
      expect(seen).toHaveLength(3);
    },
  );

  it('answers unavailable, to be tried again, when the node fails for the whole budget, with the time it looked', async () => {
    const { result } = confirm(() => json({}, 503));
    await expect(result).resolves.toEqual({
      status: 'unavailable',
      retryable: true,
      message: expect.stringMatching(
        /^The chain could not be read for 1[0-9] s \(The chain node is unavailable right now \(HTTP 503\)\.\)\. Call confirm_pod_creation again in a moment with the same hash\.$/,
      ),
    });
  });

  it('stops at once on an answer it cannot read, not to be tried again', async () => {
    for (const answer of [
      () => json({ tx_response: { txhash: TX_HASH } }),
      // Over the read's size bound.
      () =>
        new Response(`{"pad":"${'x'.repeat(600 * 1024)}"}`, {
          headers: { 'content-type': 'application/json' },
        }),
    ]) {
      resetUpstreamHealth();
      const { result, seen } = confirm(answer);
      await expect(result).resolves.toEqual({
        status: 'unavailable',
        retryable: false,
        message: expect.stringMatching(
          /^Could not read the transaction from the chain: /,
        ),
      });
      expect(seen).toHaveLength(1);
    }
  });

  it('rejects with the turn’s abort while it waits', async () => {
    const controller = new AbortController();
    const { result } = confirm(
      () => {
        queueMicrotask(() => controller.abort(new Error('turn ended')));
        return NOT_FOUND();
      },
      // The real wait, which ends on the abort.
      { sleep, pollIntervalMs: 60_000, confirmBudgetMs: 600_000 },
      ownerCtx({ abortSignal: controller.signal }),
    );
    await expect(result).rejects.toThrow('turn ended');
  });

  it('answers failed for a transaction that failed on chain', async () => {
    const { result } = confirm(() =>
      txAnswer({ code: 5, events: [], data: '' }),
    );
    await expect(result).resolves.toEqual({
      status: 'failed',
      retryable: false,
      message:
        'That transaction failed on chain (code 5 in entity), so no POD was created: owner does not match signer',
    });
  });

  it('resolves the POD without a message response in the result data', async () => {
    const { result } = confirm(() => txAnswer({ data: '' }));
    await expect(result).resolves.toEqual(CREATED);
  });

  it.each([
    [
      'it carries another POD batch (another profile)',
      { messages: [BODY_MESSAGE({ proof: 'ff'.repeat(32) })] },
      /not the POD batch this conversation sent/,
    ],
    [
      'it carries no entity creation',
      { messages: [{ '@type': '/cosmos.bank.v1beta1.MsgSend' }] },
      /not the POD batch this conversation sent/,
    ],
    [
      'it carries two entity creations',
      { messages: [BODY_MESSAGE(), BODY_MESSAGE()] },
      /not the POD batch this conversation sent/,
    ],
    [
      'its message names another owner',
      { messages: [BODY_MESSAGE({ ownerDid: 'did:ixo:ixo1someoneelse' })] },
      /owned by did:ixo:ixo1someoneelse, not by you/,
    ],
    [
      'the entity event names another owner',
      {
        events: [
          MINT_EVENT(),
          ENTITY_EVENT({ signer: 'did:ixo:ixo1someoneelse' }),
        ],
      },
      /owned by did:ixo:ixo1someoneelse \(the entity event\), not by you/,
    ],
    [
      'the ownership token goes to another account',
      { events: [MINT_EVENT('ixo1someoneelse'), ENTITY_EVENT()] },
      /owned by ixo1someoneelse \(the ownership token\), not by you/,
    ],
    [
      'there is no ownership token',
      { events: [ENTITY_EVENT()] },
      /did not create exactly one entity/,
    ],
    [
      'there are two ownership tokens',
      { events: [MINT_EVENT(), MINT_EVENT(), ENTITY_EVENT()] },
      /did not create exactly one entity/,
    ],
    [
      'there are two entity events',
      { events: [MINT_EVENT(), ENTITY_EVENT(), ENTITY_EVENT()] },
      /did not create exactly one entity/,
    ],
    [
      'the entity is not a POD',
      { events: [MINT_EVENT(), ENTITY_EVENT({ type: 'dao' })], data: '' },
      /created a "dao" entity, not a POD/,
    ],
    [
      'the sources name different entities',
      {
        data: responseData('did:ixo:entity:00000000000000000000000000000000'),
      },
      /names more than one entity/,
    ],
    [
      'the entity event is unreadable',
      {
        events: [
          MINT_EVENT(),
          {
            type: 'ixo.entity.v1beta1.EntityCreatedEvent',
            attributes: [attr('entity', 'not json')],
          },
        ],
      },
      /entity event the gateway cannot read/,
    ],
    [
      'the result data is not hex',
      { data: 'zz-not-hex' },
      /result data is not what the chain writes/,
    ],
  ])('answers failed when %s', async (_case, over, message) => {
    const { result } = confirm(() => txAnswer(over));
    await expect(result).resolves.toEqual({
      status: 'failed',
      retryable: false,
      message: expect.stringMatching(message),
    });
  });

  it('answers unavailable when the node answers with another transaction', async () => {
    const { result } = confirm(() => txAnswer({ txhash: 'F'.repeat(64) }));
    await expect(result).resolves.toEqual({
      status: 'unavailable',
      retryable: false,
      message: expect.stringMatching(/different transaction/),
    });
  });
});

/* ── the domain card ──────────────────────────────────────────────────── */

describe('prepareDomainCard and requestIndexing', () => {
  it('reserves the Portal-shaped card and returns the one MsgAddLinkedResource the catalog accepts', async () => {
    const { fetchImpl, seen } = upstream({ create: RESERVED });
    const prepared = await gateway(fetchImpl).prepareDomainCard(
      { network: 'testnet', podDid: ENTITY, profile: PROFILE },
      ownerCtx(),
    );
    const cardText = JSON.stringify(
      podDomainCardDocument({
        podDid: ENTITY,
        ownerDid: DID,
        profile: PROFILE,
        validFrom: NOW.toISOString(),
      }),
    );
    expect(prepared).toEqual({
      ok: true,
      summary: `Add the public domain card of your POD ${ENTITY} on testnet, so the Portal lists it and search finds it: name "Solar POD"; description "Monitors community solar.".`,
      documents: [
        {
          mxc: MXC,
          contentType: 'application/ld+json',
          filename: 'domainCard.json',
          text: cardText,
        },
      ],
      messages: [
        {
          typeUrl: '/ixo.iid.v1beta1.MsgAddLinkedResource',
          value: {
            id: ENTITY,
            linkedResource: {
              id: '{id}#dmn',
              type: 'domainCard',
              description: 'Domain Card',
              mediaType: 'application/json',
              serviceEndpoint: DOWNLOAD,
              proof: documentProof(cardText),
              encrypted: 'false',
              right: '',
            },
            signer: ADDRESS,
          },
        },
      ],
    });
    expect(seen.map((request) => request.url)).toEqual([
      `${HOMESERVER}/_matrix/media/v1/create`,
    ]);
    if (!prepared.ok) throw new Error('not prepared');
    const batch = validateTransactionBatch({
      messages: prepared.messages,
      summary: prepared.summary,
      network: 'testnet',
    });
    expect(batch.routes.map((route) => route.messageName)).toEqual([
      'MsgAddLinkedResource',
    ]);
  });

  it('composes the card the way the Portal composes a fresh one', () => {
    const card = podDomainCardDocument({
      podDid: ENTITY,
      ownerDid: DID,
      profile: { name: 'Solar POD' },
      validFrom: NOW.toISOString(),
    });
    expect(card).toMatchObject({
      id: `${ENTITY}#dmn`,
      type: ['VerifiableCredential', 'ixo:DomainCard'],
      issuer: { id: DID },
      validFrom: '2026-11-08T10:00:00.000Z',
      credentialSchema: {
        id: 'https://w3id.org/ixo/schemas/ixo-domain-card-1.json',
        type: 'JsonSchema',
      },
      credentialSubject: {
        id: ENTITY,
        type: ['ixo:Domain'],
        additionalType: ['schema:Organization'],
        name: 'Solar POD',
        description: '',
        keywords: [],
        attributes: [],
      },
    });
  });

  it.each([
    ['devnet', {}, 'https://domain-indexer.devnet.ixo.earth/index'],
    ['testnet', {}, 'https://domain-indexer.testnet.ixo.earth/index'],
    ['mainnet', {}, 'https://domain-indexer.ixo.earth/index'],
    [
      'testnet',
      { DOMAIN_INDEXER_URL: 'https://indexer.example/' },
      'https://indexer.example/index',
    ],
  ] as const)(
    'asks the %s domain indexer to index the POD, without credentials',
    async (network, config, url) => {
      const { fetchImpl, seen } = upstream({
        index: () => json({ success: true }),
      });
      await gateway(fetchImpl).requestIndexing(
        { network, podDid: ENTITY },
        ownerCtx({ config: { NETWORK: network, ...config } }),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(url);
      expect(seen[0]?.method).toBe('POST');
      expect(seen[0]?.headers.get('authorization')).toBeNull();
      expect(seen[0]?.body).toBe(JSON.stringify({ did: ENTITY }));
    },
  );

  it('only logs when the indexer refuses or cannot be reached', async () => {
    for (const index of [
      () => json({ error: 'boom' }, 500),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const warn = vi.fn();
      const { fetchImpl } = upstream({ index });
      const base = ownerCtx();
      await expect(
        gateway(fetchImpl).requestIndexing(
          { network: 'testnet', podDid: ENTITY },
          { ...base, logger: { ...base.logger, warn } },
        ),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/its chain poller indexes it later/),
      );
    }
  });
});

/* ── findPodGroup ─────────────────────────────────────────────────────── */

const MEMBER = 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze';
const CORE = 'ixo1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zsrtecm8';
const MODULE = 'ixo1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurst089cd';
const GROUP = {
  name: 'Solar POD',
  members: [ADDRESS, MEMBER],
  threshold: 2,
  votingPeriodSeconds: 604_800,
  allowRevoting: true,
};

const base64Json = (value: unknown): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));

/**
 * The group's `MsgInstantiateContract` as chain REST shows it in a body
 * (the shape checked on a devnet `dao_core` instantiate on Nov 9 2026): the
 * top-level `msg` as JSON, each module's own `msg` as base64 of its JSON.
 */
function groupBody(
  over: {
    sender?: string;
    codeId?: string;
    name?: string;
    members?: string[];
    threshold?: string;
    votingPeriodSeconds?: number;
    allowRevoting?: boolean;
  } = {},
) {
  return {
    '@type': '/cosmwasm.wasm.v1.MsgInstantiateContract',
    sender: over.sender ?? ADDRESS,
    admin: over.sender ?? ADDRESS,
    code_id: over.codeId ?? '3',
    label: `did:ixo:${ADDRESS}contract3`,
    msg: {
      admin: null,
      automatically_add_cw20s: true,
      automatically_add_cw721s: true,
      name: over.name ?? GROUP.name,
      description: '',
      voting_module_instantiate_info: {
        admin: { core_module: {} },
        code_id: 20,
        label: `DAO_${GROUP.name}_DaoVotingCw4`,
        msg: base64Json({
          cw4_group_code_id: 24,
          initial_members: (over.members ?? GROUP.members).map((addr) => ({
            addr,
            weight: 1,
          })),
        }),
      },
      proposal_modules_instantiate_info: [
        {
          admin: { core_module: {} },
          code_id: 16,
          label: `DAO_${GROUP.name}_DaoProposalSingle`,
          msg: base64Json({
            threshold: {
              absolute_count: { threshold: over.threshold ?? '2' },
            },
            max_voting_period: {
              time: over.votingPeriodSeconds ?? GROUP.votingPeriodSeconds,
            },
            allow_revoting: over.allowRevoting ?? GROUP.allowRevoting,
          }),
        },
      ],
    },
    funds: [],
  };
}

/** The `instantiate` events of a group creation: the core, then its modules. */
const instantiated = (address: string, codeId: string) => ({
  type: 'instantiate',
  attributes: [
    { key: '_contract_address', value: address, index: true },
    { key: 'code_id', value: codeId, index: true },
    { key: 'msg_index', value: '0', index: true },
  ],
});
const GROUP_EVENTS = [instantiated(CORE, '3'), instantiated(MODULE, '16')];

function findGroup(
  tx: Handler,
  ctx: RuntimeContext = ownerCtx(),
  group: typeof GROUP = GROUP,
) {
  const { fetchImpl, seen } = upstream({ tx });
  const result = gateway(fetchImpl).findPodGroup(
    { txHash: TX_HASH, network: 'testnet', group },
    ctx,
  );
  return { result, seen };
}

describe('findPodGroup', () => {
  it('looks the transaction up again until the node has it, then reads the group’s core from its dao_core instantiate', async () => {
    const { result, seen } = findGroup((n) =>
      n < 2
        ? NOT_FOUND()
        : txAnswer({ messages: [groupBody()], events: GROUP_EVENTS, data: '' }),
    );
    await expect(result).resolves.toEqual({
      status: 'found',
      coreAddress: CORE,
      // The proposal module's own instantiate event (code 16) names it too.
      proposalModule: MODULE,
    });
    expect(seen).toHaveLength(2);
  });

  it('reads the members in any order: the group is the same', async () => {
    const { result } = findGroup(() =>
      txAnswer({
        messages: [groupBody({ members: [MEMBER, ADDRESS] })],
        events: GROUP_EVENTS,
        data: '',
      }),
    );
    await expect(result).resolves.toEqual({
      status: 'found',
      coreAddress: CORE,
      // The proposal module's own instantiate event (code 16) names it too.
      proposalModule: MODULE,
    });
  });

  it('answers failed, not to be tried again, for a transaction that is not the group this conversation sent', async () => {
    for (const messages of [
      [groupBody({ sender: MEMBER })],
      [groupBody({ codeId: '4' })],
      [groupBody({ name: 'Another group' })],
      [groupBody({ members: [ADDRESS] })],
      [groupBody({ threshold: '1' })],
      [groupBody({ votingPeriodSeconds: 86_400 })],
      [groupBody({ allowRevoting: false })],
      [groupBody(), groupBody()],
      [BODY_MESSAGE()],
    ]) {
      resetUpstreamHealth();
      const { result } = findGroup(() =>
        txAnswer({ messages, events: GROUP_EVENTS, data: '' }),
      );
      await expect(result).resolves.toEqual({
        status: 'failed',
        retryable: false,
        message: expect.stringMatching(
          /^That transaction is not the governance group this conversation sent/,
        ),
      });
    }
  });

  it('answers failed for a group transaction that failed on chain, or names no group', async () => {
    await expect(
      findGroup(() =>
        txAnswer({ code: 5, messages: [groupBody()], events: [], data: '' }),
      ).result,
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringMatching(
        /failed on chain \(code 5.*no group was created/,
      ),
    });
    await expect(
      findGroup(() =>
        txAnswer({
          messages: [groupBody()],
          events: [instantiated(MODULE, '16')],
          data: '',
        }),
      ).result,
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/names no new group contract/),
    });
  });

  it('answers pending within its budget, saying to call link_pod_group again', async () => {
    const { result } = findGroup(NOT_FOUND);
    await expect(result).resolves.toEqual({
      status: 'pending',
      retryable: true,
      message: expect.stringMatching(
        /it may not be in a block yet\. Call link_pod_group again in a moment\.$/,
      ),
    });
  });

  it('refuses a user whose DID is not an IXO account before any request', async () => {
    const base = ownerCtx();
    const { result, seen } = findGroup(() => txAnswer(), {
      ...base,
      user: { ...base.user, did: 'did:ixo:user1' },
    });
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/not an IXO account/),
    });
    expect(seen).toEqual([]);
  });
});
