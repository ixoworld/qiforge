import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authzGiven from './fixtures/authz-given.json';
import authzReceived from './fixtures/authz-received.json';
import {
  HTTP_500_FAILURE,
  MICHAEL,
  chainFetch,
  contextOf,
  pathsOf,
  refusal,
  reply,
  resetChainState,
  run,
  upayRoute,
} from './fixtures/context';
import feeGrantsIssued from './fixtures/fee-grants-issued.json';
import feeGrantsReceived from './fixtures/fee-grants-received.json';
import {
  GRANTS_TTL_MS,
  KNOWN_GRANTERS,
  authzGrantsKind,
  feeGrantsKind,
} from './grants';

const SERVICE = 'ixo1vafr2dqhgz8frc7gf22njz8y2u0fue4kuetey6';
const ADMIN = 'ixo1sd7r80y445fp5e7ycru8w6zl2p34l2wnp05hqm';
const AGENT = 'ixo1rtjje8u0ctwwcdk8x07f4zgmexnjcmk8w6dgvq';
/** Every grants read asks for 20 rows and never counts the total. */
const PAGE = 'pagination.limit=20';
const PAY = {
  amount: '1000000',
  symbol: 'PAY',
  denom: 'upay',
  amountBaseUnits: '1000000000000',
  verified: true,
};
const ixoCoin = (amount: string, amountBaseUnits: string) => ({
  amount,
  symbol: 'IXO',
  denom: 'uixo',
  amountBaseUnits,
  verified: true,
});
const EMPTY_PAGE = { next_key: null, total: '0' };
const NONE = 'none allowed';

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fee_grants', () => {
  const received = `/cosmos/feegrant/v1beta1/allowances/${MICHAEL}?${PAGE}`;

  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(feeGrantsKind, {}, ctx)).toBeNull();
    expect(
      refusal(feeGrantsKind, { direction: 'given', address: SERVICE }, ctx),
    ).toBeNull();
    expect(refusal(feeGrantsKind, { direction: 'sideways' }, ctx)).toMatch(
      /^Invalid args for kind "fee_grants" \(direction: /,
    );
    expect(refusal(feeGrantsKind, { granter: SERVICE }, ctx)).toMatch(
      /Invalid args for kind "fee_grants"/,
    );
    expect(refusal(feeGrantsKind, { address: 'ixo1/../x' }, ctx)).toBe(
      'address must be an ixo1… address or a did:ixo:ixo1… DID.',
    );
    expect(
      refusal(feeGrantsKind, {}, contextOf(chainFetch({}), { address: null })),
    ).toBe('The user has no IXO account address; give one.');
  });

  it("reads the grants paying the user's fees and names the known granter (recorded mainnet answer)", async () => {
    const fetcher = chainFetch({ [received]: feeGrantsReceived });
    const result = await run(feeGrantsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher)).toEqual([received]);
    expect(result).toEqual({
      ok: true,
      subject: 'user',
      first: 10,
      data: {
        address: MICHAEL,
        direction: 'received',
        more: false,
        grants: [
          {
            granter: SERVICE,
            granterLabel: 'IXO fee-grant service (feegrant.ixo.world)',
            grantee: MICHAEL,
            type: 'BasicAllowance',
            kindLabel: 'one budget until it expires',
            spendLimit: 'unlimited',
            expiration: '2027-06-26T07:54:41.109Z',
            expired: false,
          },
        ],
      },
    });
  });

  it('reads the grants an account issued, `first` rows of one page, with no total (recorded mainnet answer)', async () => {
    const issued = `/cosmos/feegrant/v1beta1/issued/${SERVICE}?${PAGE}`;
    const fetcher = chainFetch({ [issued]: feeGrantsIssued });
    const result = await run(
      feeGrantsKind,
      { direction: 'given', address: SERVICE },
      contextOf(fetcher, { first: 2 }),
    );
    expect(pathsOf(fetcher)).toEqual([issued]);
    expect(result).toMatchObject({
      ok: true,
      subject: 'other',
      first: 2,
      data: { direction: 'given', more: true },
    });
    expect(JSON.stringify(result)).not.toContain('total');
    expect(result.ok && result.data).toMatchObject({
      grants: [
        {
          granterLabel: 'IXO fee-grant service (feegrant.ixo.world)',
          grantee: 'ixo1qqpzcyz8yeyxwjddelakj2qawxy4m0ugfnzr26',
          expiration: '2027-09-13T17:05:41.619Z',
        },
        { grantee: 'ixo1qqz897jf8dam0evyjxeayv8lgt43xdm3c25s8n' },
      ],
    });
  });

  it('names known granters on mainnet only', async () => {
    expect(KNOWN_GRANTERS.testnet).toEqual({});
    expect(KNOWN_GRANTERS.devnet).toEqual({});
    const result = await run(
      feeGrantsKind,
      {},
      contextOf(chainFetch({ [received]: feeGrantsReceived }), {
        network: 'testnet',
      }),
    );
    expect(result.ok && result.data).toMatchObject({
      grants: [
        expect.not.objectContaining({ granterLabel: expect.anything() }),
      ],
    });
  });

  it('labels Periodic and AllowedMsg allowances, unwrapping the nested one', async () => {
    const periodic = {
      '@type': '/cosmos.feegrant.v1beta1.PeriodicAllowance',
      basic: {
        spend_limit: [{ denom: 'uixo', amount: '5000000' }],
        expiration: '2026-01-01T00:00:00Z',
      },
      period: '86400s',
      period_spend_limit: [{ denom: 'uixo', amount: '1000000' }],
      period_can_spend: [{ denom: 'uixo', amount: '250000' }],
      period_reset: '2026-10-29T18:00:00Z',
    };
    const body = {
      allowances: [
        { granter: ADMIN, grantee: MICHAEL, allowance: periodic },
        {
          granter: ADMIN,
          grantee: MICHAEL,
          allowance: {
            ...periodic,
            basic: { spend_limit: [], expiration: null },
            period_can_spend: [],
          },
        },
        {
          granter: ADMIN,
          grantee: MICHAEL,
          allowance: {
            '@type': '/cosmos.feegrant.v1beta1.AllowedMsgAllowance',
            allowance: {
              ...periodic,
              basic: { spend_limit: [], expiration: null },
              period_reset: '2026-10-28T00:00:00Z',
            },
            allowed_messages: [
              '/ixo.claims.v1beta1.MsgSubmitClaim',
              '/cosmos.bank.v1beta1.MsgSend',
            ],
          },
        },
        {
          granter: ADMIN,
          grantee: MICHAEL,
          allowance: { '@type': '/example.v1.FutureAllowance', x: 1 },
        },
      ],
      pagination: { next_key: null, total: '4' },
    };
    const result = await run(
      feeGrantsKind,
      {},
      contextOf(chainFetch({ [received]: body })),
    );
    expect(result.ok && result.data).toEqual({
      address: MICHAEL,
      direction: 'received',
      more: false,
      grants: [
        {
          granter: ADMIN,
          grantee: MICHAEL,
          type: 'PeriodicAllowance',
          kindLabel: 'refills every period',
          spendLimit: [ixoCoin('5', '5000000')],
          period: {
            every: '1 day',
            limit: [ixoCoin('1', '1000000')],
            canSpendThisPeriod: { coins: [ixoCoin('0.25', '250000')] },
            resetAt: '2026-10-29T18:00:00Z',
          },
          expiration: '2026-01-01T00:00:00Z',
          expired: true,
        },
        {
          // All of this period's budget is used: nothing left until the
          // reset, never an empty list.
          granter: ADMIN,
          grantee: MICHAEL,
          type: 'PeriodicAllowance',
          kindLabel: 'refills every period',
          spendLimit: 'unlimited',
          period: {
            every: '1 day',
            limit: [ixoCoin('1', '1000000')],
            canSpendThisPeriod: { coins: [], nothingLeftThisPeriod: true },
            resetAt: '2026-10-29T18:00:00Z',
          },
          expiration: null,
          expired: false,
        },
        {
          granter: ADMIN,
          grantee: MICHAEL,
          type: 'AllowedMsgAllowance',
          innerType: 'PeriodicAllowance',
          kindLabel: 'only for listed actions; refills every period',
          allowedMessages: ['MsgSubmitClaim', 'MsgSend'],
          spendLimit: 'unlimited',
          period: {
            every: '1 day',
            limit: [ixoCoin('1', '1000000')],
            canSpendThisPeriod: { coins: [ixoCoin('0.25', '250000')] },
            resetAt: '2026-10-28T00:00:00Z',
            resetDue: true,
          },
          expiration: null,
          expired: false,
        },
        {
          granter: ADMIN,
          grantee: MICHAEL,
          type: 'FutureAllowance',
          kindLabel: 'an allowance type this reader does not know',
          expiration: null,
          expired: false,
        },
      ],
    });
  });

  it('answers an account without grants with an empty list', async () => {
    const issued = `/cosmos/feegrant/v1beta1/issued/${MICHAEL}?${PAGE}`;
    const result = await run(
      feeGrantsKind,
      { direction: 'given' },
      contextOf(
        chainFetch({ [issued]: { allowances: [], pagination: EMPTY_PAGE } }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      subject: 'user',
      first: 10,
      data: {
        address: MICHAEL,
        direction: 'given',
        more: false,
        grants: [],
      },
    });
  });

  it('keeps an answer for 30 s per account and direction, for any `first`, and never a failure', async () => {
    const fetcher = chainFetch({ [received]: feeGrantsReceived });
    await run(feeGrantsKind, {}, contextOf(fetcher));
    expect(
      await run(feeGrantsKind, {}, contextOf(fetcher, { first: 1 })),
    ).toMatchObject({ ok: true, first: 1, data: { more: false } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + GRANTS_TTL_MS + 1);
    await run(feeGrantsKind, {}, contextOf(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(2);
    resetChainState();
    const broken = chainFetch({ [received]: reply(500) });
    await run(feeGrantsKind, {}, contextOf(broken));
    await run(feeGrantsKind, {}, contextOf(broken));
    expect(broken).toHaveBeenCalledTimes(2);
  });

  it('says more rows exist past `first` even on the last page', async () => {
    const two = {
      allowances: [
        ...feeGrantsReceived.allowances,
        ...feeGrantsReceived.allowances,
      ],
      pagination: EMPTY_PAGE,
    };
    expect(
      await run(
        feeGrantsKind,
        {},
        contextOf(chainFetch({ [received]: two }), { first: 1 }),
      ),
    ).toMatchObject({ ok: true, data: { more: true, grants: [{}] } });
  });

  it('passes an upstream failure through; a 404 is a wrong route, not "none"', async () => {
    expect(
      await run(
        feeGrantsKind,
        {},
        contextOf(chainFetch({ [received]: reply(500) })),
      ),
    ).toEqual(HTTP_500_FAILURE);
    expect(
      await run(
        feeGrantsKind,
        {},
        contextOf(chainFetch({ [received]: reply(404) })),
      ),
    ).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('authz_grants', () => {
  const asGrantee = `/cosmos/authz/v1beta1/grants/grantee/${MICHAEL}?${PAGE}`;

  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(authzGrantsKind, { direction: 'given' }, ctx)).toBeNull();
    expect(refusal(authzGrantsKind, { direction: 'both' }, ctx)).toMatch(
      /^Invalid args for kind "authz_grants"/,
    );
    expect(refusal(authzGrantsKind, { first: 50 }, ctx)).toMatch(/first: /);
    expect(refusal(authzGrantsKind, { address: 'did:ixo:entity:1' }, ctx)).toBe(
      'address must be an ixo1… address or a did:ixo:ixo1… DID.',
    );
  });

  it('points to smart_account for who else can sign for an account', () => {
    expect(authzGrantsKind.explain).toContain('see `smart_account`');
  });

  it('labels the claims authorizations the user holds (recorded mainnet answer)', async () => {
    const fetcher = chainFetch({ [asGrantee]: authzReceived, ...upayRoute });
    const result = await run(authzGrantsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher)[0]).toBe(asGrantee);
    expect(result).toEqual({
      ok: true,
      subject: 'user',
      first: 10,
      data: {
        address: MICHAEL,
        direction: 'received',
        more: false,
        grants: [
          {
            granter: ADMIN,
            grantee: MICHAEL,
            type: 'CreateClaimAuthorizationAuthorization',
            kindLabel: 'may create submit authorizations in collection 340',
            admin: ADMIN,
            constraints: [
              {
                collections: ['340'],
                creates: 'submit',
                maxAuthorizations: '1000000000',
                maxAgentQuota: '1000000000',
                // Empty caps on a meta-authorization: what it creates may set any.
                maxAmount: [PAY],
                maxCw20: 'any',
                maxCw1155: 'any',
                maxIntentDuration: '30 days',
                expiration: null,
                expired: false,
              },
            ],
            expiration: null,
            expired: false,
          },
          {
            granter: ADMIN,
            grantee: MICHAEL,
            type: 'EvaluateClaimAuthorization',
            kindLabel: 'may evaluate claims in collection 340',
            admin: ADMIN,
            constraints: [
              {
                collectionId: '340',
                evaluationsLeft: '1000000000',
                before: '2126-06-29T09:58:26.326Z',
                // Empty caps on an evaluate grant: no custom payment of that kind.
                maxCustomAmount: [PAY],
                maxCustomCw20: NONE,
                maxCustomCw1155: NONE,
              },
            ],
            expiration: '2126-06-29T09:58:26.326Z',
            expired: false,
          },
        ],
      },
    });
  });

  it('reads who may act for an account: submit, evaluate and generic grants (recorded mainnet answer)', async () => {
    const asGranter = `/cosmos/authz/v1beta1/grants/granter/${ADMIN}?${PAGE}`;
    const fetcher = chainFetch({ [asGranter]: authzGiven, ...upayRoute });
    const result = await run(
      authzGrantsKind,
      { direction: 'given', address: `did:ixo:${ADMIN}` },
      contextOf(fetcher, { first: 3 }),
    );
    expect(pathsOf(fetcher)[0]).toBe(asGranter);
    expect(result).toMatchObject({
      ok: true,
      subject: 'other',
      first: 3,
      data: { direction: 'given', more: true },
    });
    expect(result.ok && result.data).toMatchObject({
      grants: [
        {
          grantee: AGENT,
          type: 'EvaluateClaimAuthorization',
          kindLabel: 'may evaluate claims in collections 340, 339',
        },
        {
          grantee: AGENT,
          type: 'SubmitClaimAuthorization',
          kindLabel: 'may submit claims in collections 340, 339',
          constraints: [
            {
              collectionId: '340',
              claimsLeft: '1000000000',
              maxAmount: [PAY],
              maxCw20: NONE,
              maxCw1155: NONE,
              intentDuration: '30 days',
            },
            {
              collectionId: '339',
              claimsLeft: '1000000000',
              maxAmount: [PAY],
              maxCw20: NONE,
              maxCw1155: NONE,
            },
          ],
          expiration: null,
          expired: false,
        },
        {
          grantee: AGENT,
          type: 'GenericAuthorization',
          message: 'MsgUpdateCollectionState',
          kindLabel: 'may send MsgUpdateCollectionState for the granter',
        },
      ],
    });
    // A zero intent duration is no duration.
    expect(JSON.stringify(result)).not.toContain('0 seconds');
  });

  it('labels send, stake and withdraw-payment authorizations and an unknown type', async () => {
    const grant = (authorization: Record<string, unknown>) => ({
      granter: MICHAEL,
      grantee: AGENT,
      authorization,
      expiration: '2026-10-01T00:00:00Z',
    });
    const asGranter = `/cosmos/authz/v1beta1/grants/granter/${MICHAEL}?${PAGE}`;
    const body = {
      grants: [
        grant({
          '@type': '/cosmos.bank.v1beta1.SendAuthorization',
          spend_limit: [{ denom: 'uixo', amount: '10000000' }],
          allow_list: [ADMIN],
        }),
        grant({
          '@type': '/cosmos.staking.v1beta1.StakeAuthorization',
          max_tokens: { denom: 'uixo', amount: '2500000' },
          allow_list: {
            address: ['ixovaloper1qeex565vg4uu7zwudh9ff2dauxptqf72nf2l44'],
          },
          authorization_type: 'AUTHORIZATION_TYPE_DELEGATE',
        }),
        grant({
          '@type': '/cosmos.staking.v1beta1.StakeAuthorization',
          max_tokens: null,
          authorization_type: 'AUTHORIZATION_TYPE_UNDELEGATE',
        }),
        grant({
          '@type': '/ixo.claims.v1beta1.WithdrawPaymentAuthorization',
          admin: ADMIN,
          constraints: [
            {
              claim_id: 'bafkreiexampleclaim',
              inputs: [],
              outputs: [],
              payment_type: 'APPROVAL',
              release_date: '2026-11-01T00:00:00Z',
              toAddress: '',
              fromAddress: '',
              cw20_payment: [],
              cw1155_payment: [],
            },
          ],
        }),
        grant({ '@type': '/example.v1.FutureAuthorization' }),
      ],
      pagination: { next_key: null },
    };
    const result = await run(
      authzGrantsKind,
      { direction: 'given' },
      contextOf(chainFetch({ [asGranter]: body })),
    );
    expect(result.ok && result.data).toMatchObject({
      grants: [
        {
          type: 'SendAuthorization',
          kindLabel: 'may send up to 10 IXO from the granter',
          spendLimit: [ixoCoin('10', '10000000')],
          onlyTo: [ADMIN],
          expiration: '2026-10-01T00:00:00Z',
          expired: true,
        },
        {
          type: 'StakeAuthorization',
          kindLabel: "may delegate the granter's stake (up to 2.5 IXO)",
          maxTokens: ixoCoin('2.5', '2500000'),
          onlyValidators: ['ixovaloper1qeex565vg4uu7zwudh9ff2dauxptqf72nf2l44'],
        },
        {
          type: 'StakeAuthorization',
          kindLabel: "may undelegate the granter's stake",
          maxTokens: 'unlimited',
        },
        {
          type: 'WithdrawPaymentAuthorization',
          kindLabel: 'may withdraw payments for 1 claim',
          constraints: [
            {
              claimId: 'bafkreiexampleclaim',
              paymentType: 'approval',
              releasesAt: '2026-11-01T00:00:00Z',
            },
          ],
        },
        {
          type: 'FutureAuthorization',
          kindLabel:
            'may act for the granter as FutureAuthorization allows (a type this reader does not know)',
        },
      ],
    });
  });

  it('shows cw1155 and cw20 caps, and says what empty caps allow per authorization type', async () => {
    const CW1155 =
      'ixo1yw4xvtc43me9scqfr2jr2gzvcxd3a9y4eq7gaukreugw2yd2f8tsz3392y';
    const cw1155 = [
      { address: CW1155, token_id: ['CARBON'], amount: '10' },
      { address: CW1155, token_id: [], amount: '3' },
    ];
    const grant = (authorization: Record<string, unknown>) => ({
      granter: ADMIN,
      grantee: MICHAEL,
      authorization,
      expiration: null,
    });
    const body = {
      grants: [
        grant({
          '@type': '/ixo.claims.v1beta1.SubmitClaimAuthorization',
          admin: ADMIN,
          constraints: [
            {
              collection_id: '340',
              agent_quota: '5',
              max_amount: [],
              max_cw20_payment: [{ address: CW1155, amount: '7' }],
              intent_duration_ns: '0s',
              max_cw1155_payment: cw1155,
              member_address: '',
            },
          ],
        }),
        grant({
          '@type': '/ixo.claims.v1beta1.EvaluateClaimAuthorization',
          admin: ADMIN,
          constraints: [
            {
              collection_id: '340',
              claim_ids: [],
              agent_quota: '5',
              before_date: null,
              max_custom_amount: [],
              max_custom_cw20_payment: [],
              max_custom_cw1155_payment: cw1155,
            },
          ],
        }),
        grant({
          '@type': '/ixo.claims.v1beta1.CreateClaimAuthorizationAuthorization',
          admin: ADMIN,
          constraints: [
            {
              max_authorizations: '0',
              max_agent_quota: '0',
              max_amount: [],
              max_cw20_payment: [],
              expiration: null,
              collection_ids: [],
              allowed_auth_types: 'ALL',
              max_intent_duration_ns: '0s',
              max_cw1155_payment: [],
              member_address: '',
            },
          ],
        }),
      ],
      pagination: { next_key: null },
    };
    const shownCw1155 = [
      { contract: CW1155, tokenIds: ['CARBON'], amount: '10' },
      { contract: CW1155, tokenIds: 'any', amount: '3' },
    ];
    const result = await run(
      authzGrantsKind,
      {},
      contextOf(chainFetch({ [asGrantee]: body })),
    );
    expect(result.ok && result.data).toMatchObject({
      grants: [
        {
          type: 'SubmitClaimAuthorization',
          constraints: [
            {
              maxAmount: NONE,
              maxCw20: [{ contract: CW1155, amountBaseUnits: '7' }],
              maxCw1155: shownCw1155,
            },
          ],
        },
        {
          type: 'EvaluateClaimAuthorization',
          constraints: [
            {
              maxCustomAmount: NONE,
              maxCustomCw20: NONE,
              maxCustomCw1155: shownCw1155,
            },
          ],
        },
        {
          type: 'CreateClaimAuthorizationAuthorization',
          constraints: [
            {
              maxAuthorizations: 'no cap',
              maxAmount: 'any',
              maxCw20: 'any',
              maxCw1155: 'any',
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('[]');
  });

  it('keeps an answer for 30 s per account and direction', async () => {
    const fetcher = chainFetch({ [asGrantee]: authzReceived, ...upayRoute });
    await run(authzGrantsKind, {}, contextOf(fetcher));
    await run(authzGrantsKind, {}, contextOf(fetcher, { first: 1 }));
    expect(pathsOf(fetcher).filter((path) => path === asGrantee)).toHaveLength(
      1,
    );
    vi.setSystemTime(Date.now() + GRANTS_TTL_MS + 1);
    await run(authzGrantsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher).filter((path) => path === asGrantee)).toHaveLength(
      2,
    );
  });

  it('answers an account nobody granted anything with an empty list, and passes failures through', async () => {
    const asGranter = `/cosmos/authz/v1beta1/grants/granter/${MICHAEL}?${PAGE}`;
    expect(
      await run(
        authzGrantsKind,
        { direction: 'given' },
        contextOf(
          chainFetch({ [asGranter]: { grants: [], pagination: EMPTY_PAGE } }),
        ),
      ),
    ).toMatchObject({
      ok: true,
      data: { grants: [], more: false },
    });
    expect(
      await run(
        authzGrantsKind,
        {},
        contextOf(chainFetch({ [asGrantee]: reply(500) })),
      ),
    ).toEqual(HTTP_500_FAILURE);
  });
});
