import { createStaticResolver } from '@ixo/credentials-kit/did';
import { base64url, signJws } from '@ixo/credentials-kit/jose';
import {
  createAuthorizationResponse,
  createPresentation,
  matchCredential,
  verifyAuthorizationRequest,
} from '@ixo/credentials-kit/oid4vp';
import { parseSdJwt, sdDigest } from '@ixo/credentials-kit/sdjwt';
import {
  createStatusListToken,
  newStatusBits,
  setStatusBit,
} from '@ixo/credentials-kit/status';
import { describe, expect, it } from 'vitest';
import { deliverToPluginInbox } from '../../core/plugin-inbox';
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import { VerifierEntryMemo } from './credentials-client';
import {
  createCredentialsTools,
  type CredentialsToolsDeps,
} from './credentials-tools';
import { MESSAGES } from './errors';
import { canonicalJson, sha256Hex } from './hub-client';
import {
  CREDENTIALS_KV_NAMESPACE,
  inboxKeyOf,
  openResponseToken,
} from './response-route';
import {
  BLOCKSYNC_URL,
  channelCtx,
  HUB,
  ISSUER_DID,
  json,
  ORACLE_DID,
  party,
  PERSON_DID,
  recordingUcan,
  routedFetch,
  SELF,
  SERVICE_KEY,
  testConfig,
  VCT,
  WORKER,
  type RecordedCall,
} from './test-fixtures';
import { VerifierContext } from './verifier';

const STATUS_URI = 'https://status.ixo.world/lists/1';
const CATALOG = `${WORKER}/v1/catalog/verifiers/${ORACLE_DID}`;
const CARD = {
  id: 'card_1',
  url: `${HUB}/a/card_1?t=permission`,
  status: 'pending',
  expiresAt: 1793000000,
};

const issuer = party('issuer', ISSUER_DID);
const person = party('person', PERSON_DID);

/** The kit's DID and status-list reads: Blocksync GraphQL and one status list. */
function kitFetch(oracleDoc: unknown, revoked: number[] = []): typeof fetch {
  const docs = new Map<string, unknown>([
    [ORACLE_DID, oracleDoc],
    [ISSUER_DID, issuer.doc],
    [PERSON_DID, person.doc],
  ]);
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === BLOCKSYNC_URL) {
      const { variables } = JSON.parse(String(init?.body));
      const doc = docs.get(variables.id);
      return json({ data: { iids: { nodes: doc ? [doc] : [] } } });
    }
    if (url === STATUS_URI) {
      const bits = newStatusBits(16);
      for (const i of revoked) setStatusBit(bits, i);
      const now = Math.floor(Date.now() / 1000);
      return new Response(
        await createStatusListToken({
          bits,
          uri: STATUS_URI,
          iss: issuer.did,
          signer: issuer.signer,
          ttl: 300,
          exp: now + 3600,
          iat: now,
        }),
      );
    }
    return new Response('not found', { status: 404 });
  };
}

/** An SD-JWT VC issued to the person (RFC 9901, flat disclosures). */
async function heldCredential(exp = Math.floor(Date.now() / 1000) + 86_400) {
  const enc = (v: unknown) =>
    base64url.encode(new TextEncoder().encode(JSON.stringify(v)));
  const disclosures = Object.entries({
    age_over_18: true,
    birth_date: '2000-01-02',
  }).map(([name, value]) =>
    enc([
      base64url.encode(crypto.getRandomValues(new Uint8Array(16))),
      name,
      value,
    ]),
  );
  const jwt = await signJws(
    { alg: 'EdDSA', typ: 'dc+sd-jwt', kid: issuer.signer.kid },
    {
      _sd: disclosures.map(sdDigest).sort(),
      _sd_alg: 'sha-256',
      iss: issuer.did,
      sub: person.did,
      iat: Math.floor(Date.now() / 1000) - 100,
      exp,
      vct: VCT,
      cnf: { jwk: person.signer.publicJwk },
      status: { status_list: { uri: STATUS_URI, idx: 3 } },
    },
    issuer.signer,
  );
  return `${jwt}~${disclosures.map((d) => `${d}~`).join('')}`;
}

/**
 * The Hub answering under a standing consent: read the deposited request
 * as a wallet, present the credential, and POST the encrypted answer to
 * the response URI (here: open its token and put it in the check's inbox,
 * as the route does).
 */
async function walletAnswers(
  call: RecordedCall,
  kv: UserKvSurface,
  oracleDoc: unknown,
) {
  const { request } = JSON.parse(call.body);
  const req = await verifyAuthorizationRequest(request, {
    resolver: createStaticResolver([oracleDoc as never]),
  });
  const held = await heldCredential();
  const query = req.dcql.credentials[0];
  if (!query) throw new Error('no query');
  const match = matchCredential(query, parseSdJwt(held));
  if (!match.ok) throw new Error(match.reason);
  const presentation = await createPresentation({
    sdjwt: held,
    disclose: match.disclose,
    signer: person.signer,
    audience: req.clientId,
    nonce: req.nonce,
  });
  const response = await createAuthorizationResponse({
    request: req,
    vpToken: { [query.id]: [presentation] },
  });
  const token = new URL(response.url).pathname.split('/').pop() ?? '';
  const target = await openResponseToken(token, {
    serviceKey: SERVICE_KEY,
    oracleDid: ORACLE_DID,
  });
  if (!target || target.ownerDid !== PERSON_DID)
    throw new Error('bad response URI');
  return deliverToPluginInbox(
    kv,
    CREDENTIALS_KV_NAMESPACE,
    inboxKeyOf(target.checkId),
    response.body,
  );
}

function deposited(id = 'req_1') {
  return json(
    {
      id,
      request_uri: `${WORKER}/v1/requests/${id}/object`,
      openid4vp_url: 'openid4vp://?x',
      wallet_url: `${HUB}/credentials/requests/${id}`,
      status: 'pending',
    },
    201,
  );
}

function toolsFor(
  fetchImpl: (r: Request) => Promise<Response>,
  oracleDoc: unknown,
  extra: Partial<CredentialsToolsDeps> = {},
): Record<string, PluginTool> {
  const tools = createCredentialsTools({
    cfg: testConfig(),
    oracle: { name: 'Companion' },
    verifier: new VerifierContext(BLOCKSYNC_URL, false, kitFetch(oracleDoc)),
    memo: new VerifierEntryMemo(),
    fetchImpl,
    sleep: async () => undefined,
    ...extra,
  });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

/** A manual clock that advances on every sleep. */
function clock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(ms, 1);
    },
  };
}

async function run(
  t: PluginTool | undefined,
  args: unknown,
  ctx: RuntimeContext,
) {
  if (!t) throw new Error('missing tool');
  return t.handler(args, ctx);
}

const CHECK_ARGS = { vct: VCT, issuers: [ISSUER_DID], claims: ['age_over_18'] };

describe('the WhatsApp gate', () => {
  it('refuses every tool outside our WhatsApp channel, before any call', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({});
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const inputs: Record<string, unknown> = {
      credentials_request_check_permission: CHECK_ARGS,
      credentials_permission_status: { permissionId: 'card_1' },
      credentials_check: CHECK_ARGS,
      credentials_request_action_permission: { action: 'self.identity-check' },
      credentials_request_action: { action: 'self.identity-check' },
      credentials_action_status: {
        action: 'self.identity-check',
        ref: 'lnk_1',
      },
    };
    expect(Object.keys(tools).sort()).toEqual(Object.keys(inputs).sort());
    for (const ctx of [
      channelCtx(adapter, { client: 'portal' }),
      channelCtx(adapter, { client: 'matrix' }),
      channelCtx(adapter, { provider: 'telegram' }),
    ])
      for (const [name, args] of Object.entries(inputs))
        await expect(run(tools[name], args, ctx)).resolves.toEqual({
          error: 'whatsapp_only',
          message: MESSAGES.whatsAppOnly,
        });
    expect(calls).toHaveLength(0);
  });

  it('refuses when the plugin is switched off', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({});
    const tools = toolsFor(fetchImpl, oracleKey.doc, {
      cfg: testConfig({ CREDENTIALS_ENABLED: 'false' }),
    });
    await expect(
      run(
        tools.credentials_request_check_permission,
        CHECK_ARGS,
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({ error: 'not_available' });
  });
});

describe('permission cards', () => {
  it('asks the Hub for a check card and hands back one link to send', async () => {
    const { adapter, mints, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const out = await run(
      tools.credentials_request_check_permission,
      { ...CHECK_ARGS, claims: ['identity_level', 'age_over_18'], days: 30 },
      channelCtx(adapter),
    );
    expect(out).toEqual({
      status: 'sent',
      permissionId: 'card_1',
      url: CARD.url,
      expiresAt: CARD.expiresAt,
      message: `Tap this link to see what Companion is asking and choose Allow or Don't allow: ${CARD.url}`,
    });
    const sent = JSON.parse(calls[0]?.body ?? '');
    expect(sent).toMatchObject({
      bindingId: 'bind_1',
      bindingRevision: 3,
      requestKey: await sha256Hex('run-1:call-1:check-permission'),
      permission: {
        kind: 'credential-check',
        vct: VCT,
        issuers: [ISSUER_DID],
        claims: ['age_over_18', 'identity_level'],
        days: 30,
      },
    });
    expect(mints).toEqual([
      expect.objectContaining({
        kind: 'self-signed',
        audience: 'did:web:dev.auth.ixo.earth',
        capability: { can: 'permissions/request', with: 'ixo:permissions' },
        facts: [
          expect.objectContaining({
            method: 'POST',
            path: '/api/internal/permissions',
          }),
        ],
      }),
    ]);
  });

  it('reads a card status without ever passing grants on', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({
          id: 'card_1',
          status: 'allowed',
          allowedAt: 1792000000,
          expiresAt: 1794000000,
          grants: [
            {
              can: 'identity/link',
              with: 'ixo:identity',
              audience: 'x',
              expiresAt: 1794000000,
              token: 'SECRET',
            },
          ],
        }),
    });
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_permission_status,
      { permissionId: 'card_1' },
      channelCtx(adapter),
    );
    expect(out).toEqual({
      permissionId: 'card_1',
      status: 'allowed',
      allowedAt: 1792000000,
      expiresAt: 1794000000,
      message: 'They allowed it.',
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('maps a Hub refusal to a plain sentence', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () =>
        json({ error: 'unknown_claim', message: 'x' }, 400),
    });
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_request_check_permission,
        CHECK_ARGS,
        channelCtx(adapter),
      ),
    ).resolves.toEqual({
      error: 'unknown_claim',
      message: MESSAGES.unknownClaim,
    });
  });
});

describe('credentials_check', () => {
  it('publishes the verifier entry, deposits a signed request and verifies the answer', async () => {
    const { adapter, mints, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl, calls } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () =>
        json(
          {
            sender_key: ORACLE_DID,
            entry: {},
            updated_at: 1,
            display_dropped: [],
          },
          201,
        ),
      [`POST ${WORKER}/v1/requests`]: async (call) => {
        expect(await walletAnswers(call, kv, oracleKey.doc)).toBe(true);
        return deposited();
      },
    });
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_check,
      CHECK_ARGS,
      channelCtx(adapter, { kv }),
    );
    expect(out).toEqual({
      result: 'valid',
      claims: { age_over_18: true },
      requestId: 'req_1',
      message: 'Their credential checks out.',
    });
    // Only the field asked for comes back, never the birth date.
    expect(JSON.stringify(out)).not.toContain('2000-01-02');
    expect(JSON.parse(calls[1]?.body ?? '')).toMatchObject({
      did: ORACLE_DID,
      name: 'Companion',
      accepts: [{ vct: VCT, claims: ['age_over_18'], issuers: [ISSUER_DID] }],
    });
    const deposit = JSON.parse(calls[2]?.body ?? '');
    expect(deposit).toMatchObject({
      subject: PERSON_DID,
      purpose: 'Companion would like to check this.',
    });
    // The request object never names the person.
    expect(JSON.stringify(deposit.request)).not.toContain(PERSON_DID.slice(8));
    expect(
      mints.map((m) => [m.audience, m.capability.can, m.facts[0]]),
    ).toEqual([
      [
        'did:web:dev.credentials.ixo.earth',
        'credentials/verify',
        { method: 'PUT', path: `/v1/catalog/verifiers/${ORACLE_DID}` },
      ],
      [
        'did:web:dev.credentials.ixo.earth',
        'credentials/verify',
        { method: 'POST', path: '/v1/requests' },
      ],
    ]);
    // The check's rows are gone once it ended.
    const rowKey = `check:${(await sha256Hex(canonicalJson({ subject: PERSON_DID, ...CHECK_ARGS }))).slice(0, 32)}`;
    expect(await kv.get(CREDENTIALS_KV_NAMESPACE, rowKey)).toBeUndefined();
  });

  it('reports a revoked credential as revoked', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () =>
        json(
          {
            sender_key: ORACLE_DID,
            entry: {},
            updated_at: 1,
            display_dropped: [],
          },
          201,
        ),
      [`POST ${WORKER}/v1/requests`]: async (call) => {
        await walletAnswers(call, kv, oracleKey.doc);
        return deposited();
      },
    });
    const tools = createCredentialsTools({
      cfg: testConfig(),
      oracle: { name: 'Companion' },
      // Index 3 (the credential's) is set on the issuer's status list.
      verifier: new VerifierContext(
        BLOCKSYNC_URL,
        false,
        kitFetch(oracleKey.doc, [3]),
      ),
      memo: new VerifierEntryMemo(),
      fetchImpl,
      sleep: async () => undefined,
    });
    await expect(
      run(
        tools.find((t) => t.name === 'credentials_check'),
        CHECK_ARGS,
        channelCtx(adapter, { kv }),
      ),
    ).resolves.toEqual({
      result: 'revoked',
      requestId: 'req_1',
      message: 'Their credential has been revoked by its issuer.',
    });
  });

  it('answers pending with the wallet link, then continues the same request', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    let depositCall: RecordedCall | undefined;
    const { fetchImpl, calls } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () =>
        json(
          {
            sender_key: ORACLE_DID,
            entry: {},
            updated_at: 1,
            display_dropped: [],
          },
          201,
        ),
      [`POST ${WORKER}/v1/requests`]: (call) => {
        depositCall = call;
        return deposited();
      },
      [`GET ${WORKER}/v1/requests/req_1`]: () =>
        json({
          id: 'req_1',
          ref: 'x',
          status: 'pending',
          created_at: 1,
          expires_at: 2,
          updated_at: 1,
        }),
    });
    const time = clock();
    const tools = toolsFor(fetchImpl, oracleKey.doc, {
      now: time.now,
      sleep: time.sleep,
    });
    const ctx = channelCtx(adapter, { kv });
    const first = await run(tools.credentials_check, CHECK_ARGS, ctx);
    expect(first).toEqual({
      result: 'pending',
      requestId: 'req_1',
      walletUrl: `${HUB}/credentials/requests/req_1`,
      message: `They need to answer in their IXO wallet: ${HUB}/credentials/requests/req_1`,
    });
    // Bounded polling: a status read every few seconds, not every pass.
    const polls = calls.filter(
      (c) => c.method === 'GET' && c.url.endsWith('/req_1'),
    ).length;
    expect(polls).toBeGreaterThan(0);
    expect(polls).toBeLessThanOrEqual(5);

    // The person answers in their wallet; the next call picks it up.
    if (!depositCall) throw new Error('no deposit');
    await walletAnswers(depositCall, kv, oracleKey.doc);
    const second = await run(tools.credentials_check, CHECK_ARGS, ctx);
    expect(second).toMatchObject({
      result: 'valid',
      claims: { age_over_18: true },
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('ignores junk at the response endpoint and reports a decline as none', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl } = routedFetch({
      [`GET ${CATALOG}`]: () =>
        json({
          sender_key: ORACLE_DID,
          entry: {
            did: ORACLE_DID,
            name: 'Companion',
            accepts: [
              {
                purpose: 'p',
                vct: VCT,
                claims: ['age_over_18'],
                issuers: [ISSUER_DID],
              },
            ],
          },
          updated_at: 1,
        }),
      [`POST ${WORKER}/v1/requests`]: async (call) => {
        const { request } = JSON.parse(call.body);
        const req = await verifyAuthorizationRequest(request, {
          resolver: createStaticResolver([oracleKey.doc as never]),
        });
        const token = new URL(req.responseUri).pathname.split('/').pop() ?? '';
        const target = await openResponseToken(token, {
          serviceKey: SERVICE_KEY,
          oracleDid: ORACLE_DID,
        });
        await deliverToPluginInbox(
          kv,
          CREDENTIALS_KV_NAMESPACE,
          inboxKeyOf(target?.checkId ?? ''),
          'response=junk',
        );
        return deposited();
      },
      [`GET ${WORKER}/v1/requests/req_1`]: () =>
        json({
          id: 'req_1',
          ref: 'x',
          status: 'declined',
          created_at: 1,
          expires_at: 2,
          updated_at: 1,
        }),
    });
    const time = clock();
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc, { now: time.now, sleep: time.sleep })
        .credentials_check,
      CHECK_ARGS,
      channelCtx(adapter, { kv }),
    );
    expect(out).toEqual({
      result: 'none',
      requestId: 'req_1',
      message: "They didn't share a credential for this.",
    });
  });

  it('closes a request answered at the worker whose answer never arrived, so the next call starts again', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl, calls } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () =>
        json(
          {
            sender_key: ORACLE_DID,
            entry: {},
            updated_at: 1,
            display_dropped: [],
          },
          201,
        ),
      [`POST ${WORKER}/v1/requests`]: [
        () => deposited('req_1'),
        () => deposited('req_2'),
      ],
      [`GET ${WORKER}/v1/requests/req_1`]: () =>
        json({
          id: 'req_1',
          ref: 'x',
          status: 'answered',
          created_at: 1,
          expires_at: 2,
          updated_at: 1,
        }),
      [`GET ${WORKER}/v1/requests/req_2`]: () =>
        json({
          id: 'req_2',
          ref: 'x',
          status: 'pending',
          created_at: 1,
          expires_at: 2,
          updated_at: 1,
        }),
    });
    const time = clock();
    const tools = toolsFor(fetchImpl, oracleKey.doc, {
      now: time.now,
      sleep: time.sleep,
    });
    const ctx = channelCtx(adapter, { kv });
    await expect(
      run(tools.credentials_check, CHECK_ARGS, ctx),
    ).resolves.toEqual({
      error: 'answer_lost',
      message: MESSAGES.busy,
    });
    await expect(
      run(tools.credentials_check, CHECK_ARGS, ctx),
    ).resolves.toMatchObject({
      result: 'pending',
      requestId: 'req_2',
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('refuses plainly when the oracle key is not on its DID document', async () => {
    const { adapter } = recordingUcan();
    const stranger = party('someone-else', ORACLE_DID);
    const { fetchImpl } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () =>
        json(
          {
            sender_key: ORACLE_DID,
            entry: {},
            updated_at: 1,
            display_dropped: [],
          },
          201,
        ),
    });
    await expect(
      run(
        toolsFor(fetchImpl, stranger.doc).credentials_check,
        CHECK_ARGS,
        channelCtx(adapter),
      ),
    ).resolves.toEqual({
      error: 'not_available',
      message: MESSAGES.notAvailable,
    });
  });

  it('passes on a blocked deposit as a plain sentence and keeps nothing', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () =>
        json(
          {
            sender_key: ORACLE_DID,
            entry: {},
            updated_at: 1,
            display_dropped: [],
          },
          201,
        ),
      [`POST ${WORKER}/v1/requests`]: () =>
        json({ error: 'blocked', message: 'x' }, 403),
    });
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_check,
        CHECK_ARGS,
        channelCtx(adapter, { kv }),
      ),
    ).resolves.toEqual({ error: 'blocked', message: MESSAGES.blocked });
  });
});

describe('catalogued actions (self.identity-check)', () => {
  const GRANTS = [
    {
      // Listed second on purpose: grants are picked by id.
      id: 'offer',
      can: 'credentials/offer',
      with: 'ixo:credentials',
      audience: 'did:ixo:entity:80f392610e8a128b4f4b1ed828dbeb7f',
      expiresAt: 4_000_000_000,
      token: 'OFFER_DELEGATION',
    },
    {
      id: 'link',
      can: 'identity/link',
      with: 'ixo:identity',
      audience: ORACLE_DID,
      expiresAt: 4_000_000_000,
      token: 'LINK_DELEGATION',
    },
  ];

  function hubAndSelf(
    selfRoutes: Record<string, (c: RecordedCall) => Response> = {},
    status = 'allowed',
  ) {
    return routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({
          id: 'card_1',
          status,
          ...(status === 'allowed' ? { grants: GRANTS } : {}),
        }),
      ...selfRoutes,
    });
  }

  it('asks for permission first when none was asked', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = hubAndSelf();
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_request_action,
        { action: 'self.identity-check' },
        channelCtx(adapter),
      ),
    ).resolves.toEqual({
      error: 'no_permission',
      message: MESSAGES.noPermission,
    });
  });

  it('says so while the card is unanswered', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = hubAndSelf({}, 'pending');
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(
      tools.credentials_request_action_permission,
      { action: 'self.identity-check', days: 7 },
      ctx,
    );
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toEqual({
      error: 'permission_pending',
      message: MESSAGES.permissionPending,
    });
  });

  it('creates the link with the allowed delegations, then reads its status', async () => {
    const { adapter, mints, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = hubAndSelf({
      [`POST ${SELF}/identity/v1/links`]: () =>
        json(
          {
            linkId: 'lnk_1',
            url: 'https://dev.self.ixo.earth/l/tok',
            expiresAt: Date.UTC(2026, 10, 9, 14, 5) / 1000,
          },
          201,
        ),
      [`GET ${SELF}/identity/v1/links/lnk_1`]: () =>
        json({
          linkId: 'lnk_1',
          status: 'in_progress',
          updatedAt: 1,
          expiresAt: 2,
        }),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { timezone: 'Asia/Tbilisi' });
    const card = await run(
      tools.credentials_request_action_permission,
      { action: 'self.identity-check', days: 7 },
      ctx,
    );
    expect(card).toMatchObject({ status: 'sent', permissionId: 'card_1' });
    expect(JSON.parse(calls[0]?.body ?? '').permission).toEqual({
      kind: 'service-action',
      action: 'self.identity-check',
      days: 7,
    });

    const link = await run(
      tools.credentials_request_action,
      { action: 'self.identity-check' },
      ctx,
    );
    expect(link).toEqual({
      status: 'sent',
      url: 'https://dev.self.ixo.earth/l/tok',
      linkId: 'lnk_1',
      expiresAt: Date.UTC(2026, 10, 9, 14, 5) / 1000,
      message:
        'Tap this link to start your identity check. It works once and ends at 18:05: https://dev.self.ixo.earth/l/tok',
    });
    const create = calls.find((c) => c.url === `${SELF}/identity/v1/links`);
    expect(JSON.parse(create?.body ?? '')).toMatchObject({
      offerConsent: 'OFFER_DELEGATION',
    });
    expect(mints.filter((m) => m.kind === 'delegated')[0]).toEqual({
      kind: 'delegated',
      delegation: 'LINK_DELEGATION',
      audience: 'did:web:api.dev.self.ixo.earth',
      capability: { can: 'identity/link', with: 'ixo:identity' },
      // The request binding, then the oracle's entity (Self names the requester from it).
      facts: [
        { method: 'POST', path: '/identity/v1/links' },
        { entityDid: 'did:ixo:entity:309db22aa6e41e3929597dcb185a23be' },
      ],
    });
    // No token ever reaches the agent.
    expect(JSON.stringify(link)).not.toContain('DELEGATION');

    await expect(
      run(
        tools.credentials_action_status,
        { action: 'self.identity-check', ref: 'lnk_1' },
        ctx,
      ),
    ).resolves.toEqual({
      linkId: 'lnk_1',
      status: 'in_progress',
      updatedAt: 1,
      expiresAt: 2,
      message: "They're doing the identity check now.",
    });
  });

  it('reuses an open link, and maps already_verified and 401 to plain sentences', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const ends = Date.UTC(2026, 10, 9, 14, 5) / 1000;
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({ id: 'card_1', status: 'allowed', grants: GRANTS }),
      [`POST ${SELF}/identity/v1/links`]: [
        () =>
          json(
            {
              error: 'link_active',
              message: 'x',
              linkId: 'lnk_0',
              status: 'sent',
              expiresAt: ends,
            },
            409,
          ),
        () => json({ error: 'already_verified', message: 'x' }, 409),
        () => json({ error: 'unauthorized', message: 'x' }, 401),
      ],
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { timezone: 'UTC' });
    await run(
      tools.credentials_request_action_permission,
      { action: 'self.identity-check' },
      ctx,
    );
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toEqual({
      status: 'already_open',
      linkId: 'lnk_0',
      linkStatus: 'sent',
      expiresAt: ends,
      message:
        'A link is already open; it ends at 14:05. Please use the link you already have.',
    });
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toEqual({
      error: 'already_verified',
      message: 'They already have an identity credential.',
    });
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toEqual({
      error: 'unauthorized',
      message: MESSAGES.notConfirmed,
    });
  });
});
