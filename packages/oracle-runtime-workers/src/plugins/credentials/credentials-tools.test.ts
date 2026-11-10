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
import { createMemoryUserKv } from '../../core/user-kv';
import type {
  PluginTool,
  RuntimeContext,
  UserKvSurface,
} from '../../plugin-api/types';
import { recordPermission } from './person-state';
import { VerifierEntryMemo } from './credentials-client';
import {
  createCredentialsTools,
  type CredentialsToolsDeps,
} from './credentials-tools';
import {
  CREDENTIALS_KV_NAMESPACE,
  readCheck,
  receiveAnswer,
  saveCheck,
} from './check-store';
import { purposeFor } from './config';
import { MESSAGES, refusal } from './errors';
import { canonicalJson, sha256Hex } from './hub-client';
import { openResponseToken } from './response-route';
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

/** A card's items: one identity-check action holding these grants. */
const identityItems = (grants: unknown[]) => [
  { index: 0, kind: 'service-action', action: 'self.identity-check', grants },
];

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
  revoked: number[] = [],
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
  // What the route does: the person's own object verifies the answer.
  return deliver(kv, target.checkId, response.body, oracleDoc, revoked);
}

/** The route's hand-off: the answer goes to the owner callback, which verifies it. */
function deliver(
  kv: UserKvSurface,
  checkId: string,
  body: string,
  oracleDoc: unknown,
  revoked: number[] = [],
) {
  return receiveAnswer({
    kv,
    ownerDid: PERSON_DID,
    checkId,
    body,
    verifier: new VerifierContext(
      BLOCKSYNC_URL,
      false,
      kitFetch(oracleDoc, revoked),
    ),
    nowMs: Date.now(),
  });
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

/** The card requests (the Hub's list of live cards is read before each). */
const cardPosts = (calls: RecordedCall[]) =>
  calls.filter(
    (c) => c.method === 'POST' && c.url === `${HUB}/api/internal/permissions`,
  );

const LIST_URL = `${HUB}/api/internal/permissions?bindingId=bind_1&bindingRevision=3`;

const CHECK_ARGS = { vct: VCT, issuers: [ISSUER_DID], claims: ['age_over_18'] };

describe('the WhatsApp gate', () => {
  it('refuses every tool outside our WhatsApp channel, before any call', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({});
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const inputs: Record<string, unknown> = {
      credentials_request_permissions: {
        items: [{ kind: 'service-action', action: 'self.identity-check' }],
      },
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
        await expect(run(tools[name], args, ctx)).resolves.toEqual(
          refusal('whatsapp_only', MESSAGES.whatsAppOnly),
        );
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

describe('the trust anchor (CREDENTIALS_TRUSTED_ISSUERS)', () => {
  const OTHER_ISSUER = 'did:ixo:entity:0004e35de01fe39b3b4222a44e2566dd';

  it('refuses a type or an issuer outside the configured list before any call', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({});
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    for (const name of [
      'credentials_check',
      'credentials_request_check_permission',
    ]) {
      await expect(
        run(tools[name], { ...CHECK_ARGS, issuers: [OTHER_ISSUER] }, ctx),
      ).resolves.toEqual(refusal('untrusted_issuer', MESSAGES.untrustedIssuer));
      await expect(
        run(
          tools[name],
          {
            ...CHECK_ARGS,
            vct: 'https://credentials.ixo.world/types/Other',
            issuers: undefined,
          },
          ctx,
        ),
      ).resolves.toEqual(
        refusal('untrusted_credential', MESSAGES.untrustedCredential),
      );
    }
    // No card, no catalog write, no request.
    expect(calls).toHaveLength(0);
  });

  it('uses the configured issuers when none are given', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
    });
    await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_request_check_permission,
      { vct: VCT, claims: ['age_over_18'] },
      channelCtx(adapter),
    );
    expect(
      JSON.parse(cardPosts(calls)[0]?.body ?? '').permissions[0].issuers,
    ).toEqual([ISSUER_DID]);
  });

  it('publishes every configured issuer, and asks only for the ones narrowed to', async () => {
    const { adapter, oracleKey } = recordingUcan();
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
      [`POST ${WORKER}/v1/requests`]: () => deposited(),
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
      cfg: testConfig({
        CREDENTIALS_TRUSTED_ISSUERS: { [VCT]: [ISSUER_DID, OTHER_ISSUER] },
      }),
    });
    await run(tools.credentials_check, CHECK_ARGS, channelCtx(adapter));
    const put = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(put?.body ?? '').accepts[0].issuers).toEqual(
      [ISSUER_DID, OTHER_ISSUER].sort(),
    );
    const { request } = JSON.parse(
      calls.find((c) => c.method === 'POST')?.body ?? '{}',
    );
    const payload = JSON.parse(
      atob(
        String(request).split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ??
          '',
      ),
    );
    expect(payload.dcql_query.credentials[0].claims).toContainEqual({
      path: ['iss'],
      values: [ISSUER_DID],
    });
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
      hint: 'Send `message` as it is, as one link in a short message. Never paste ids or tokens.',
    });
    const sent = JSON.parse(cardPosts(calls)[0]?.body ?? '');
    expect(sent).toMatchObject({
      bindingId: 'bind_1',
      bindingRevision: 3,
      requestKey: await sha256Hex('run-1:call-1:check-permission'),
      permissions: [
        {
          kind: 'credential-check',
          vct: VCT,
          issuers: [ISSUER_DID],
          claims: ['age_over_18', 'identity_level'],
          days: 30,
        },
      ],
    });
    // The Hub's list of the person's cards is read first, then the card is asked.
    const signed = {
      kind: 'self-signed',
      audience: 'did:web:dev.auth.ixo.earth',
      capability: { can: 'permissions/request', with: 'ixo:permissions' },
    };
    expect(mints).toEqual([
      {
        ...signed,
        facts: [
          {
            method: 'GET',
            path: '/api/internal/permissions?bindingId=bind_1&bindingRevision=3',
          },
        ],
      },
      expect.objectContaining({
        ...signed,
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
          items: [
            {
              index: 0,
              kind: 'service-action',
              action: 'self.identity-check',
              grants: [
                {
                  id: 'link',
                  can: 'identity/link',
                  with: 'ixo:identity',
                  audience: 'x',
                  expiresAt: 1794000000,
                  token: 'SECRET',
                },
              ],
            },
            {
              index: 1,
              kind: 'credential-check',
              consentIds: ['cons_1'],
            },
          ],
        }),
    });
    const kv = createMemoryUserKv();
    await recordPermission(kv, 'card_1', [
      'service-action',
      'credential-check',
    ]);
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_permission_status,
      { permissionId: 'card_1' },
      channelCtx(adapter, { kv }),
    );
    expect(out).toEqual({
      permissionId: 'card_1',
      status: 'allowed',
      allowedAt: 1792000000,
      expiresAt: 1794000000,
      items: [
        {
          index: 0,
          kind: 'service-action',
          action: 'self.identity-check',
          state: 'allowed',
          granted: {
            grants: [
              {
                id: 'link',
                can: 'identity/link',
                with: 'ixo:identity',
                audience: 'x',
                expiresAt: 1794000000,
              },
            ],
          },
        },
        {
          index: 1,
          kind: 'credential-check',
          state: 'allowed',
          granted: { consentIds: ['cons_1'] },
        },
      ],
      message: 'Thanks, you allowed it.',
      hint: 'Go on with the task.',
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
    ).resolves.toEqual(refusal('unknown_claim', MESSAGES.unknownClaim));
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
        expect(await walletAnswers(call, kv, oracleKey.doc)).toEqual({
          status: 200,
        });
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
      message: 'Thanks, your credential checks out.',
      hint: 'Use only the fields you asked for, for this task.',
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
      purpose: 'Check your Identity Level 1',
    });
    // The request object never names the person.
    expect(JSON.stringify(deposit.request)).not.toContain(PERSON_DID.slice(8));
    expect(
      mints.map((m) => [m.audience, m.capability.can, m.facts[0]]),
    ).toEqual([
      [
        'did:web:dev.credentials.ixo.earth',
        'credentials/verify',
        {
          method: 'PUT',
          path: `/v1/catalog/verifiers/${ORACLE_DID}`,
          body_sha256: await sha256Hex(calls[1]?.body ?? ''),
        },
      ],
      [
        'did:web:dev.credentials.ixo.earth',
        'credentials/verify',
        {
          method: 'POST',
          path: '/v1/requests',
          body_sha256: await sha256Hex(calls[2]?.body ?? ''),
        },
      ],
    ]);
    // The check's rows are gone once it ended.
    const queryHash = (
      await sha256Hex(canonicalJson({ subject: PERSON_DID, ...CHECK_ARGS }))
    ).slice(0, 32);
    expect(
      await kv.get(CREDENTIALS_KV_NAMESPACE, `open:${queryHash}`),
    ).toBeUndefined();
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
        await walletAnswers(call, kv, oracleKey.doc, [3]);
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
      message: 'Your credential has been revoked by its issuer.',
      hint: 'It cannot be used; do not retry.',
    });
  });

  it('keeps the real answer when junk came first (junk is refused, never stored)', async () => {
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
        const { request } = JSON.parse(call.body);
        const req = await verifyAuthorizationRequest(request, {
          resolver: createStaticResolver([oracleKey.doc as never]),
        });
        const token = new URL(req.responseUri).pathname.split('/').pop() ?? '';
        const target = await openResponseToken(token, {
          serviceKey: SERVICE_KEY,
          oracleDid: ORACLE_DID,
        });
        // Junk is refused and stores nothing, then the person's answer.
        for (let i = 0; i < 12; i++)
          expect(
            (
              await deliver(
                kv,
                target?.checkId ?? '',
                `response=junk-${i}`,
                oracleKey.doc,
              )
            ).status,
          ).toBe(400);
        await walletAnswers(call, kv, oracleKey.doc);
        return deposited();
      },
    });
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_check,
      CHECK_ARGS,
      channelCtx(adapter, { kv }),
    );
    expect(out).toMatchObject({
      result: 'valid',
      claims: { age_over_18: true },
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
      message: `Please answer in your IXO wallet: ${HUB}/credentials/requests/req_1`,
      hint: 'No standing permission answered. Send `message` as it is, or ask for standing permission with credentials_request_check_permission (it sends no new card when the Hub already holds one for this); then call again with the same fields to continue this request.',
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
        expect(
          (
            await deliver(
              kv,
              target?.checkId ?? '',
              'response=junk',
              oracleKey.doc,
            )
          ).status,
        ).toBe(400);
        // A JWE-shaped body that cannot be decrypted is a bad answer (400),
        // never a server fault (503).
        const shaped = btoa(JSON.stringify({ alg: 'ECDH-ES', enc: 'A256GCM' }))
          .replace(/=+$/, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        expect(
          (
            await deliver(
              kv,
              target?.checkId ?? '',
              `response=${shaped}..aXY.Y2lwaGVy.dGFn`,
              oracleKey.doc,
            )
          ).status,
        ).toBe(400);
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
      message: "You didn't share a credential for this.",
      hint: 'They declined or let it end; ask again only if they want to.',
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
    ).resolves.toEqual(refusal('answer_lost', MESSAGES.busy));
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
    ).resolves.toEqual(refusal('not_available', MESSAGES.notAvailable));
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
    ).resolves.toEqual(refusal('blocked', MESSAGES.blocked));
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
          items: identityItems(status === 'allowed' ? GRANTS : []),
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
    ).resolves.toEqual(refusal('no_permission', MESSAGES.noPermission));
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
    ).resolves.toEqual(
      refusal('permission_pending', MESSAGES.permissionPending),
    );
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
    expect(JSON.parse(cardPosts(calls)[0]?.body ?? '').permissions).toEqual([
      { kind: 'service-action', action: 'self.identity-check', days: 7 },
    ]);

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
      hint: 'Send `message` as it is. Keep the linkId to read progress. A new link replaces one nobody has opened yet, so do not call this again to resend.',
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
        {
          method: 'POST',
          path: '/identity/v1/links',
          body_sha256: await sha256Hex(create?.body ?? ''),
        },
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
      message: "You're doing the identity check now.",
      hint: 'Wait for them to finish; do not poll.',
    });
  });

  it('reuses an open link, and maps already_verified and 401 to plain sentences', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const ends = Date.UTC(2026, 10, 9, 14, 5) / 1000;
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({
          id: 'card_1',
          status: 'allowed',
          items: identityItems(GRANTS),
        }),
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
        'Your identity check is already in progress; it ends at 14:05. Please carry on with it.',
      hint: 'Its link cannot be sent again; read progress with this linkId.',
    });
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toEqual(refusal('already_verified', MESSAGES.alreadyVerified));
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toEqual(refusal('unauthorized', MESSAGES.notConfirmed));
  });
});

describe('one card for everything (credentials_request_permissions)', () => {
  const IDENTITY = {
    kind: 'service-action',
    action: 'self.identity-check',
    days: 7,
  } as const;
  const LINK_GRANT = {
    id: 'link',
    can: 'identity/link',
    with: 'ixo:identity',
    audience: ORACLE_DID,
    expiresAt: 4_000_000_000,
    token: 'LINK_DELEGATION',
  };
  const OFFER_GRANT = {
    id: 'offer',
    can: 'credentials/offer',
    with: 'ixo:credentials',
    audience: 'did:ixo:entity:80f392610e8a128b4f4b1ed828dbeb7f',
    expiresAt: 4_000_000_000,
    token: 'OFFER_DELEGATION',
  };

  it('sends several items as one card, once per request key, and records the id once', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    const args = {
      items: [IDENTITY, { kind: 'credential-check', ...CHECK_ARGS, days: 30 }],
    };
    const first = await run(tools.credentials_request_permissions, args, ctx);
    expect(first).toMatchObject({
      status: 'sent',
      permissionId: 'card_1',
      url: CARD.url,
    });
    // A resumed run asks again: the same list under the same key.
    await run(tools.credentials_request_permissions, args, ctx);
    expect(cardPosts(calls)).toHaveLength(2);
    const [a, b] = cardPosts(calls).map((c) => JSON.parse(c.body));
    expect(a.permission).toBeUndefined();
    expect(a.permissions).toEqual([
      IDENTITY,
      {
        kind: 'credential-check',
        vct: VCT,
        issuers: [ISSUER_DID],
        claims: ['age_over_18'],
        days: 30,
      },
    ]);
    expect(a.requestKey).toBe(await sha256Hex('run-1:call-1:permissions'));
    expect(b.requestKey).toBe(a.requestKey);
    expect(b.permissions).toEqual(a.permissions);
    // The id is recorded once, with its item kinds.
    const stored = await kv.get(CREDENTIALS_KV_NAMESPACE, 'permissions');
    expect(stored).toEqual([
      {
        id: 'card_1',
        kinds: ['service-action', 'credential-check'],
        url: CARD.url,
      },
    ]);
  });

  it('refuses more than 5 items or none, and an issuer outside the trust list before any call', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({});
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const { RequestPermissionsInput } = await import('./credentials-tools');
    expect(RequestPermissionsInput.safeParse({ items: [] }).success).toBe(
      false,
    );
    expect(
      RequestPermissionsInput.safeParse({
        items: Array.from({ length: 6 }, () => IDENTITY),
      }).success,
    ).toBe(false);
    await expect(
      run(
        tools.credentials_request_permissions,
        {
          items: [
            {
              kind: 'credential-check',
              ...CHECK_ARGS,
              issuers: ['did:ixo:entity:other'],
              days: 30,
            },
          ],
        },
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({ error: 'untrusted_issuer' });
    expect(calls).toHaveLength(0);
  });

  it('maps invalid_item to a plain sentence naming the item position', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () =>
        json(
          {
            error: 'invalid_item',
            message: "Item 3 of this request isn't something we can set up.",
            details: { index: 2, reason: 'unknown_claim' },
          },
          400,
        ),
    });
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_request_permissions,
      { items: [IDENTITY] },
      channelCtx(adapter),
    );
    expect(out).toMatchObject({
      error: 'invalid_item',
      message: "Item 3 of this request isn't something we can set up.",
    });
    // No DID, code or URL reaches the person.
    expect(JSON.stringify((out as { message: string }).message)).not.toMatch(
      /unknown_claim|did:/,
    );
  });

  it('maps an entry id the Hub does not know to a plain message', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: [
        () => json({ error: 'unknown_action', message: 'x' }, 400),
        () =>
          json(
            {
              error: 'invalid_item',
              message: 'x',
              details: { index: 0, reason: 'unknown_action' },
            },
            400,
          ),
      ],
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const items = [{ kind: 'service-action', action: 'yo.rewards-claim' }];
    // Any id of the Hub's pattern is sent as it is; the Hub decides.
    await expect(
      run(
        tools.credentials_request_action_permission,
        { action: 'yo.rewards-claim' },
        channelCtx(adapter),
      ),
    ).resolves.toEqual(refusal('unknown_action', MESSAGES.unknownAction));
    await expect(
      run(
        tools.credentials_request_permissions,
        { items },
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({
      error: 'invalid_item',
      message: "Item 1 of this request isn't something we can set up.",
    });
    expect(JSON.parse(cardPosts(calls)[0]?.body ?? '').permissions).toEqual([
      { kind: 'service-action', action: 'yo.rewards-claim' },
    ]);
  });

  it('needs only this one card for the identity flow (link, offer and consent)', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({
          id: 'card_1',
          status: 'allowed',
          expiresAt: 4_000_000_000,
          items: [
            {
              index: 0,
              kind: 'service-action',
              action: 'self.identity-check',
              consentIds: ['cons_1'],
              grants: [OFFER_GRANT, LINK_GRANT],
            },
          ],
        }),
      [`POST ${SELF}/identity/v1/links`]: () =>
        json(
          {
            linkId: 'lnk_1',
            url: 'https://dev.self.ixo.earth/l/tok',
            expiresAt: 4_000_000_000,
          },
          201,
        ),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(
      tools.credentials_request_permissions,
      { items: [IDENTITY] },
      ctx,
    );
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toMatchObject({ status: 'sent', linkId: 'lnk_1' });
    // Exactly one card was asked, and the link used the item's grants.
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.startsWith(HUB)),
    ).toHaveLength(1);
    const create = calls.find((c) => c.url === `${SELF}/identity/v1/links`);
    expect(JSON.parse(create?.body ?? '')).toMatchObject({
      offerConsent: 'OFFER_DELEGATION',
    });
  });

  it('finds the grants in the item of its own action when the card holds several', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({
          id: 'card_1',
          status: 'allowed',
          items: [
            { index: 0, kind: 'credential-check', consentIds: ['c1'] },
            {
              index: 1,
              kind: 'service-action',
              action: 'self.identity-check',
              grants: [LINK_GRANT, OFFER_GRANT],
            },
          ],
        }),
      [`POST ${SELF}/identity/v1/links`]: () =>
        json(
          {
            linkId: 'lnk_2',
            url: 'https://dev.self.ixo.earth/l/t',
            expiresAt: 4_000_000_000,
          },
          201,
        ),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(
      tools.credentials_request_permissions,
      {
        items: [
          { kind: 'credential-check', ...CHECK_ARGS, days: 30 },
          IDENTITY,
        ],
      },
      ctx,
    );
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toMatchObject({ linkId: 'lnk_2' });
  });

  it('returns the granted capabilities, never tokens, for an entry with no flow here', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({
          id: 'card_1',
          status: 'allowed',
          items: [
            {
              index: 0,
              kind: 'service-action',
              action: 'yo.rewards-claim',
              consentIds: ['c1'],
              grants: [{ ...LINK_GRANT, id: 'claim', can: 'rewards/claim' }],
            },
          ],
        }),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(
      tools.credentials_request_action_permission,
      { action: 'yo.rewards-claim' },
      ctx,
    );
    const out = await run(
      tools.credentials_request_action,
      { action: 'yo.rewards-claim' },
      ctx,
    );
    expect(out).toMatchObject({
      status: 'granted',
      action: 'yo.rewards-claim',
      granted: {
        consentIds: ['c1'],
        grants: [
          {
            id: 'claim',
            can: 'rewards/claim',
            with: 'ixo:identity',
            audience: ORACLE_DID,
            expiresAt: 4_000_000_000,
          },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toContain('LINK_DELEGATION');
    await expect(
      run(
        tools.credentials_action_status,
        { action: 'yo.rewards-claim', ref: 'x' },
        ctx,
      ),
    ).resolves.toMatchObject({ error: 'unknown_action' });
  });

  it('keeps the two single-item tools as one-item lists', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(
      tools.credentials_request_check_permission,
      { ...CHECK_ARGS, days: 30 },
      ctx,
    );
    await run(
      tools.credentials_request_action_permission,
      { action: 'self.identity-check' },
      ctx,
    );
    const bodies = cardPosts(calls).map((c) => JSON.parse(c.body));
    expect(bodies.map((b) => b.permissions.length)).toEqual([1, 1]);
    expect(bodies[1].permissions[0]).toEqual({
      kind: 'service-action',
      action: 'self.identity-check',
    });
    expect(Object.keys(tools)).toEqual([
      'credentials_request_permissions',
      'credentials_request_check_permission',
      'credentials_permission_status',
      'credentials_check',
      'credentials_request_action_permission',
      'credentials_request_action',
      'credentials_action_status',
    ]);
  });
});

describe('review fixes for the one-card plugin', () => {
  const IDENTITY = { kind: 'service-action', action: 'self.identity-check' };
  const grant = (id: string, can: string, expiresAt = 4_000_000_000) => ({
    id,
    can,
    with: 'ixo:identity',
    audience: ORACLE_DID,
    expiresAt,
    token: `${id.toUpperCase()}_DELEGATION`,
  });
  const allowedBody = (items: unknown[], status = 'allowed') => ({
    id: 'card_1',
    status,
    items,
  });

  it('says a service update is needed when the Hub answers without items', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    await recordPermission(kv, 'card_1');
    const { fetchImpl } = routedFetch({
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({ id: 'card_1', status: 'allowed', grants: [] }),
    });
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_permission_status,
        { permissionId: 'card_1' },
        channelCtx(adapter, { kv }),
      ),
    ).resolves.toMatchObject({
      error: 'hub_update_needed',
      message: "This isn't available yet; a service update is needed.",
    });
  });

  it('keeps a card status 5 s, an ended one for good, and caps reads at 6 a minute', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    await recordPermission(kv, 'card_1');
    let reads = 0;
    let status = 'pending';
    const { fetchImpl } = routedFetch({
      [`GET ${HUB}/api/internal/permissions/card_1`]: () => {
        reads += 1;
        return json(
          allowedBody([{ index: 0, kind: 'credential-check' }], status),
        );
      },
    });
    const c = clock();
    const tools = toolsFor(fetchImpl, oracleKey.doc, c);
    const ctx = channelCtx(adapter, { kv });
    const call = () =>
      run(tools.credentials_permission_status, { permissionId: 'card_1' }, ctx);
    await call();
    await call();
    expect(reads).toBe(1);
    await c.sleep(6_000);
    status = 'declined';
    await expect(call()).resolves.toMatchObject({ status: 'declined' });
    expect(reads).toBe(2);
    // An ended card is final: never asked again.
    await c.sleep(60_000);
    status = 'allowed';
    await expect(call()).resolves.toMatchObject({ status: 'declined' });
    expect(reads).toBe(2);

    // The cap: with nothing kept, past 6 calls in a minute is a wait.
    const kv2 = createMemoryUserKv();
    await recordPermission(kv2, 'card_1');
    status = 'pending';
    const c2 = clock();
    const tools2 = toolsFor(fetchImpl, oracleKey.doc, c2);
    const ctx2 = channelCtx(adapter, { kv: kv2 });
    const answers = [];
    for (let i = 0; i < 8; i += 1) {
      answers.push(
        await run(
          tools2.credentials_permission_status,
          { permissionId: 'card_1' },
          ctx2,
        ),
      );
      await c2.sleep(5_001);
    }
    expect(answers.map((a) => (a as { error?: string }).error ?? 'ok')).toEqual(
      ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'rate_limited', 'rate_limited'],
    );
  });

  it("uses each item's own status and drops grants that ended", async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json(
          allowedBody([
            {
              index: 0,
              kind: 'service-action',
              action: 'yo.rewards-claim',
              status: 'allowed',
              grants: [
                grant('old', 'rewards/old', 5),
                grant('claim', 'rewards/claim'),
              ],
            },
            {
              index: 1,
              kind: 'credential-check',
              status: 'stopped',
              consentIds: ['c1'],
            },
          ]),
        ),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    await run(
      tools.credentials_request_action_permission,
      { action: 'yo.rewards-claim' },
      ctx,
    );
    const out = (await run(
      tools.credentials_request_action,
      { action: 'yo.rewards-claim' },
      ctx,
    )) as { granted: { grants: { id: string }[] } };
    expect(out.granted.grants.map((g) => g.id)).toEqual(['claim']);
    const status = (await run(
      tools.credentials_permission_status,
      { permissionId: 'card_1' },
      ctx,
    )) as { items: { kind: string; state: string }[] };
    expect(status.items.map((i) => [i.kind, i.state])).toEqual([
      ['service-action', 'allowed'],
      ['credential-check', 'stopped'],
    ]);
  });

  it('returns a stopping item with no grants, and an unknown state as unknown', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    let item: Record<string, unknown> = { status: 'stopping' };
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json(
          allowedBody([
            {
              index: 0,
              kind: 'service-action',
              action: 'yo.rewards-claim',
              grants: [grant('claim', 'rewards/claim')],
              ...item,
            },
          ]),
        ),
    });
    const c = clock();
    const tools = toolsFor(fetchImpl, oracleKey.doc, c);
    const ctx = channelCtx(adapter, { kv });
    await run(
      tools.credentials_request_action_permission,
      { action: 'yo.rewards-claim' },
      ctx,
    );
    const status = (await run(
      tools.credentials_permission_status,
      { permissionId: 'card_1' },
      ctx,
    )) as { items: { state: string; granted?: unknown }[] };
    expect(status.items.map((i) => i.state)).toEqual(['stopping']);
    expect(status.items[0]?.granted).toBeUndefined();
    const used = (await run(
      tools.credentials_request_action,
      { action: 'yo.rewards-claim' },
      ctx,
    )) as { error?: string; granted?: unknown };
    expect(used.error).toBe('permission_ended');
    expect(used.granted).toBeUndefined();

    // A state this version does not know: unknown, never a throw.
    item = { status: 'frozen' };
    await c.sleep(5_001);
    const unknown = (await run(
      tools.credentials_permission_status,
      { permissionId: 'card_1' },
      ctx,
    )) as { items: { state: string; granted?: unknown }[] };
    expect(unknown.items.map((i) => i.state)).toEqual(['unknown']);
    expect(unknown.items[0]?.granted).toBeUndefined();
    await c.sleep(5_001);
    // The stopping answer above ended the waiting card; ask again.
    await run(
      tools.credentials_request_action_permission,
      { action: 'yo.rewards-claim' },
      ctx,
    );
    const refused = (await run(
      tools.credentials_request_action,
      { action: 'yo.rewards-claim' },
      ctx,
    )) as { error?: string; message?: string };
    expect(refused.error).toBe('permission_ended');
    expect(refused.message).toContain("doesn't know yet");
  });

  it('names the item for a local refusal in a several-item request', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({});
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_request_permissions,
      {
        items: [
          IDENTITY,
          {
            kind: 'credential-check',
            ...CHECK_ARGS,
            issuers: ['did:ixo:entity:other'],
            days: 30,
          },
        ],
      },
      channelCtx(adapter),
    );
    expect(out).toMatchObject({
      error: 'untrusted_issuer',
      message: "Item 2 of this request isn't something we can set up.",
    });
    expect((out as { hint: string }).hint).toContain('issuer');
    expect(calls).toHaveLength(0);
  });

  it('refuses the same action twice in one request, before any call', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({});
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_request_permissions,
        { items: [IDENTITY, { ...IDENTITY, days: 3 }] },
        channelCtx(adapter),
      ),
    ).resolves.toEqual(refusal('duplicate_item', MESSAGES.duplicateItem));
    expect(calls).toHaveLength(0);
  });

  it('keeps working grants when a second card for the same action is declined', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    let n = 0;
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: [
        () => json(CARD, 201),
        () => json({ ...CARD, id: 'card_2' }, 201),
      ],
      [`GET ${HUB}/api/internal/permissions/card_1`]: () => {
        n += 1;
        return json(
          allowedBody([
            {
              index: 0,
              kind: 'service-action',
              action: 'self.identity-check',
              grants: [
                grant('link', 'identity/link'),
                {
                  ...grant('offer', 'credentials/offer'),
                  with: 'ixo:credentials',
                },
              ],
            },
          ]),
        );
      },
      [`GET ${HUB}/api/internal/permissions/card_2`]: () =>
        json({
          id: 'card_2',
          status: 'declined',
          items: [
            { index: 0, kind: 'service-action', action: 'self.identity-check' },
          ],
        }),
      [`POST ${SELF}/identity/v1/links`]: () =>
        json(
          {
            linkId: 'lnk_1',
            url: 'https://dev.self.ixo.earth/l/t',
            expiresAt: 4_000_000_000,
          },
          201,
        ),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    const ask = { items: [IDENTITY] };
    await run(tools.credentials_request_permissions, ask, ctx);
    await run(
      tools.credentials_request_action,
      { action: 'self.identity-check' },
      ctx,
    );
    expect(n).toBe(1);
    // A second card is asked (another turn) and declined.
    await run(tools.credentials_request_permissions, ask, ctx);
    await expect(
      run(
        tools.credentials_request_action,
        { action: 'self.identity-check' },
        ctx,
      ),
    ).resolves.toMatchObject({ status: 'sent', linkId: 'lnk_1' });
  });

  it('answers plainly for request_conflict, no_longer_available and a malformed invalid_item', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: [
        () => json({ error: 'request_conflict', message: 'x' }, 409),
        () => json({ error: 'no_longer_available', message: 'x' }, 409),
        () =>
          json(
            { error: 'invalid_item', message: 'x', details: { index: '2' } },
            400,
          ),
      ],
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const send = () =>
      run(
        tools.credentials_request_permissions,
        { items: [IDENTITY] },
        channelCtx(adapter),
      );
    const plain =
      "This request can't be set up any more. Ask again in the chat.";
    await expect(send()).resolves.toMatchObject({
      error: 'request_conflict',
      message: plain,
    });
    await expect(send()).resolves.toMatchObject({
      error: 'no_longer_available',
      message: plain,
    });
    await expect(send()).resolves.toMatchObject({
      error: 'invalid_item',
      message:
        "One of the items in this request isn't something we can set up.",
    });
  });
});

describe('what the plugin keeps per person (kv)', () => {
  const ALLOWED = (calls?: { n: number }) => () => {
    if (calls) calls.n += 1;
    return json({
      id: 'card_1',
      status: 'allowed',
      items: identityItems([
        {
          id: 'offer',
          can: 'credentials/offer',
          with: 'ixo:credentials',
          audience: 'x',
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
      ]),
    });
  };
  const LINK = {
    linkId: 'lnk_1',
    url: 'https://dev.self.ixo.earth/l/tok',
    expiresAt: 4_000_000_000,
  };
  const ACTION = { action: 'self.identity-check' };

  it('answers a permission id only when this person was asked that card', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({
      [`GET ${HUB}/api/internal/permissions/card_9`]: () =>
        json({ id: 'card_9', status: 'allowed', items: identityItems([]) }),
    });
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_permission_status,
        { permissionId: 'card_9' },
        channelCtx(adapter),
      ),
    ).resolves.toEqual(refusal('not_found', MESSAGES.notFound));
    // The card itself is never read: only the list of this person's own cards.
    expect(calls.map((c) => c.url)).toEqual([LIST_URL]);
  });

  it("records the check cards' ids too", async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({ id: 'card_1', status: 'pending', items: identityItems([]) }),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    await run(tools.credentials_request_check_permission, CHECK_ARGS, ctx);
    await expect(
      run(tools.credentials_permission_status, { permissionId: 'card_1' }, ctx),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('keeps the allowed grants, asks the Hub again only when Self refuses them', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const hub = { n: 0 };
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: ALLOWED(hub),
      [`POST ${SELF}/identity/v1/links`]: [
        () => json(LINK, 201),
        () => json(LINK, 201),
        () => json({ error: 'forbidden', message: 'x' }, 403),
        () => json(LINK, 201),
      ],
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(tools.credentials_request_action_permission, ACTION, ctx);
    await run(tools.credentials_request_action, ACTION, ctx);
    expect(hub.n).toBe(1);
    // Kept: the Hub is not asked again.
    await expect(
      run(tools.credentials_request_action, ACTION, ctx),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(hub.n).toBe(1);
    // Self refuses the kept grants (the person stopped it): fetched again, retried once.
    await expect(
      run(tools.credentials_request_action, ACTION, ctx),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(hub.n).toBe(2);
    expect(
      calls.filter((c) => c.url === `${SELF}/identity/v1/links`),
    ).toHaveLength(4);
  });

  it('keeps a link status 5 s, and caps status calls at 6 a minute per link', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const self = { n: 0 };
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: ALLOWED(),
      [`GET ${SELF}/identity/v1/links/lnk_1`]: () => {
        self.n += 1;
        return json({
          linkId: 'lnk_1',
          status: 'opened',
          updatedAt: 1,
          expiresAt: 2,
        });
      },
      [`GET ${SELF}/identity/v1/links/lnk_2`]: () => {
        self.n += 100;
        return json({ error: 'not_found', message: 'x' }, 404);
      },
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(tools.credentials_request_action_permission, ACTION, ctx);
    for (let i = 0; i < 3; i++)
      await expect(
        run(tools.credentials_action_status, { ...ACTION, ref: 'lnk_1' }, ctx),
      ).resolves.toMatchObject({ status: 'opened' });
    expect(self.n).toBe(1);
    // Failures are not kept, so the cap is what stops the 7th call.
    const results: unknown[] = [];
    for (let i = 0; i < 7; i++)
      results.push(
        await run(
          tools.credentials_action_status,
          { ...ACTION, ref: 'lnk_2' },
          ctx,
        ),
      );
    expect(self.n).toBe(601);
    expect(results[6]).toMatchObject({ error: 'rate_limited' });
    expect(results[5]).toMatchObject({ error: 'not_found' });
  });

  it('keeps waiting when the worker cannot be asked for the status', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () => json({ entry: {} }, 201),
      [`POST ${WORKER}/v1/requests`]: () => deposited(),
      [`GET ${WORKER}/v1/requests/req_1`]: () =>
        json({ error: 'internal', message: 'x' }, 500),
    });
    const time = clock();
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc, { now: time.now, sleep: time.sleep })
        .credentials_check,
      CHECK_ARGS,
      channelCtx(adapter, { kv }),
    );
    expect(out).toMatchObject({ result: 'pending', requestId: 'req_1' });
  });

  it('removes the rows of an ended check on the next check', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const old = {
      v: 1 as const,
      checkId: 'old-check-id-0001',
      queryHash: 'oldhash',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      subject: PERSON_DID,
      query: { vct: VCT, issuers: [ISSUER_DID], claims: [] },
      requestJwt: 'jwt',
      privateJwk: {
        kty: 'EC' as const,
        crv: 'P-256' as const,
        x: 'x',
        y: 'y',
        d: 'd',
      },
    };
    await saveCheck(kv, old, Date.now() - 20_000);
    const { fetchImpl } = routedFetch({
      [`GET ${CATALOG}`]: () => json({ error: 'not_found', message: 'x' }, 404),
      [`PUT ${CATALOG}`]: () => json({ entry: {} }, 201),
      [`POST ${WORKER}/v1/requests`]: () => deposited(),
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
    await run(
      toolsFor(fetchImpl, oracleKey.doc, { now: time.now, sleep: time.sleep })
        .credentials_check,
      CHECK_ARGS,
      channelCtx(adapter, { kv }),
    );
    expect(await readCheck(kv, old.checkId)).toBeNull();
  });
});

describe('receiveAnswer (the person object verifies the wallet answer)', () => {
  const check = (over: Record<string, unknown> = {}) => ({
    v: 1 as const,
    checkId: 'check-id-0000000001',
    queryHash: 'h',
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    subject: PERSON_DID,
    query: { vct: VCT, issuers: [ISSUER_DID], claims: ['age_over_18'] },
    requestJwt: 'jwt',
    privateJwk: {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: 'x',
      y: 'y',
      d: 'd',
    },
    ...over,
  });
  const input = (kv: UserKvSurface, ownerDid = PERSON_DID) => ({
    kv,
    ownerDid,
    checkId: 'check-id-0000000001',
    body: 'response=junk',
    verifier: new VerifierContext(BLOCKSYNC_URL, false, async () => {
      throw new Error('no network');
    }),
    nowMs: Date.now(),
  });

  it('answers 410 for an unknown, ended or another person’s check', async () => {
    const kv = createMemoryUserKv();
    await expect(receiveAnswer(input(kv))).resolves.toMatchObject({
      status: 410,
    });
    await saveCheck(
      kv,
      check({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
      Date.now(),
    );
    await expect(receiveAnswer(input(kv))).resolves.toMatchObject({
      status: 410,
    });
    const other = createMemoryUserKv();
    await saveCheck(other, check({ subject: 'did:ixo:ixo1other' }), Date.now());
    await expect(receiveAnswer(input(other))).resolves.toMatchObject({
      status: 410,
    });
  });

  it('ignores any answer once a verified one is stored', async () => {
    const kv = createMemoryUserKv();
    await saveCheck(kv, check(), Date.now());
    const stored = {
      result: 'valid',
      claims: { age_over_18: true },
      issuer: 'i',
    };
    await kv.set(
      CREDENTIALS_KV_NAMESPACE,
      'result:check-id-0000000001',
      stored,
    );
    await expect(receiveAnswer(input(kv))).resolves.toEqual({ status: 200 });
    expect(
      await kv.get(CREDENTIALS_KV_NAMESPACE, 'result:check-id-0000000001'),
    ).toEqual(stored);
  });
});

describe('why the oracle asks (never the model)', () => {
  it('is the operator’s words or "Check your <type>", cleaned of links and markup', () => {
    const cfg = testConfig();
    expect(purposeFor(cfg, VCT)).toBe('Check your Identity Level 1');
    const custom = testConfig({
      CREDENTIALS_PURPOSES: {
        [VCT]: '<b>Confirm</b> your age at https://evil.example/x now',
      },
    });
    expect(purposeFor(custom, VCT)).toBe('Confirm your age at now');
  });

  it('is not an input of credentials_check', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({});
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_check,
        { ...CHECK_ARGS, purpose: 'Send your passport to evil.example' },
        channelCtx(adapter),
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('the Hub is the source of truth, the kv a cache', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const ACTION = { action: 'self.identity-check' };
  const GRANTS = [
    {
      id: 'offer',
      can: 'credentials/offer',
      with: 'ixo:credentials',
      audience: 'x',
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
  const fresh = (token: string) =>
    GRANTS.map((g) => ({ ...g, token: `${token}_${g.id}` }));
  const identityCard = (
    id: string,
    status: string,
    grants: unknown[] = [],
  ) => ({
    id,
    status,
    ...(status === 'allowed' ? { allowedAt: NOW - 100 } : {}),
    expiresAt: NOW + 86_000,
    items: [
      {
        index: 0,
        kind: 'service-action',
        action: 'self.identity-check',
        days: 30,
        status,
        ...(grants.length ? { grants } : {}),
      },
    ],
  });
  const checkCard = (
    id: string,
    status: string,
    claims: string[],
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    status,
    expiresAt: NOW + 86_000,
    items: [
      {
        index: 0,
        kind: 'credential-check',
        vct: VCT,
        issuers: [ISSUER_DID],
        claims,
        days: 30,
        status,
        ...(status === 'allowed' ? { consentIds: ['cons_1'] } : {}),
      },
    ],
    ...extra,
  });
  const listed = (...permissions: unknown[]) => ({
    [`GET ${LIST_URL}`]: () => json({ permissions }),
  });
  const LINK = {
    linkId: 'lnk_1',
    url: 'https://dev.self.ixo.earth/l/tok',
    expiresAt: 4_000_000_000,
  };
  const NEW_CARD = {
    [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
  };

  it('sends no new card when the Hub holds an allowed one, and fills the kv again', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl, calls } = routedFetch({
      ...NEW_CARD,
      ...listed(identityCard('card_7', 'allowed', GRANTS)),
      [`POST ${SELF}/identity/v1/links`]: () => json(LINK, 201),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    const out = await run(
      tools.credentials_request_action_permission,
      ACTION,
      ctx,
    );
    expect(out).toEqual({
      status: 'already_allowed',
      permissionId: 'card_7',
      message: "You've already allowed this.",
      hint: 'No new card was sent: a permission they allowed earlier still covers everything asked. Go on with the task (credentials_check, or credentials_request_action for a service action).',
    });
    expect(cardPosts(calls)).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain('DELEGATION');
    // The kv is filled again: the card in use, its grants, its id.
    expect(
      await kv.get(CREDENTIALS_KV_NAMESPACE, 'action:self.identity-check'),
    ).toEqual({ permissionId: 'card_7' });
    expect(
      await kv.get(CREDENTIALS_KV_NAMESPACE, 'grants:self.identity-check'),
    ).toMatchObject({ permissionId: 'card_7', grants: GRANTS });
    expect(await kv.get(CREDENTIALS_KV_NAMESPACE, 'permissions')).toEqual([
      { id: 'card_7', kinds: ['service-action'] },
    ]);
    // The action then runs from the kv alone: no card status read, no second list.
    await expect(
      run(tools.credentials_request_action, ACTION, ctx),
    ).resolves.toMatchObject({ status: 'sent', linkId: 'lnk_1' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${LIST_URL}`,
      `POST ${SELF}/identity/v1/links`,
    ]);
  });

  it('restores the grants from the Hub when the kv is empty', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl, calls } = routedFetch({
      ...listed(
        identityCard('card_9', 'pending'),
        identityCard('card_7', 'allowed', GRANTS),
      ),
      [`POST ${SELF}/identity/v1/links`]: () => json(LINK, 201),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    await expect(
      run(
        tools.credentials_request_action,
        ACTION,
        channelCtx(adapter, { kv }),
      ),
    ).resolves.toMatchObject({ status: 'sent', linkId: 'lnk_1' });
    const create = calls.find((c) => c.url === `${SELF}/identity/v1/links`);
    expect(JSON.parse(create?.body ?? '')).toMatchObject({
      offerConsent: 'OFFER_DELEGATION',
    });
    expect(
      await kv.get(CREDENTIALS_KV_NAMESPACE, 'grants:self.identity-check'),
    ).toMatchObject({ permissionId: 'card_7' });
  });

  it('says the card is still waiting when the Hub lists only a pending one', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch(
      listed(identityCard('card_9', 'pending')),
    );
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_request_action,
        ACTION,
        channelCtx(adapter),
      ),
    ).resolves.toEqual(
      refusal('permission_pending', MESSAGES.permissionPending),
    );
  });

  it('hands back the same waiting card instead of a new one', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const waiting = identityCard('card_1', 'pending');
    let live: unknown[] = [];
    const { fetchImpl, calls } = routedFetch({
      ...NEW_CARD,
      [`GET ${LIST_URL}`]: () => json({ permissions: live }),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    const first = await run(
      tools.credentials_request_action_permission,
      ACTION,
      ctx,
    );
    expect(first).toMatchObject({ status: 'sent', permissionId: 'card_1' });
    live = [waiting];
    // Asked again (another tool, another turn): the Hub still holds the card.
    const again = await run(
      tools.credentials_request_permissions,
      { items: [{ kind: 'service-action', ...ACTION }] },
      { ...ctx, toolCallId: 'call-2' },
    );
    expect(again).toEqual({
      status: 'sent',
      permissionId: 'card_1',
      url: CARD.url,
      expiresAt: waiting.expiresAt,
      message: `Tap this link to see what Companion is asking and choose Allow or Don't allow: ${CARD.url}`,
      hint: 'This is the card they were sent before and have not answered yet; no new card was made. Send `message` as it is, as one link in a short message. Never paste ids or tokens.',
    });
    expect(cardPosts(calls)).toHaveLength(1);
  });

  it('uses the link the Hub lists for a waiting card when the kv is empty, and sends a new card when there is no link', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const url = `${HUB}/a/act_9?t=permission`;
    const withLink = routedFetch({
      ...NEW_CARD,
      ...listed({ ...identityCard('card_9', 'pending'), url }),
    });
    await expect(
      run(
        toolsFor(withLink.fetchImpl, oracleKey.doc)
          .credentials_request_action_permission,
        ACTION,
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({ status: 'sent', permissionId: 'card_9', url });
    expect(cardPosts(withLink.calls)).toHaveLength(0);

    // No link from the Hub and none kept: the card cannot be sent again.
    const without = routedFetch({
      ...NEW_CARD,
      ...listed(identityCard('card_9', 'pending')),
    });
    await expect(
      run(
        toolsFor(without.fetchImpl, oracleKey.doc)
          .credentials_request_action_permission,
        ACTION,
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({ status: 'sent', permissionId: 'card_1' });
    expect(cardPosts(without.calls)).toHaveLength(1);
  });

  it('sends one new card for the whole list when a card covers only some of it', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch({
      ...NEW_CARD,
      ...listed(
        // Allowed, but for one field only; and a waiting card for the action alone.
        checkCard('card_5', 'allowed', ['age_over_18']),
        { ...identityCard('card_6', 'pending'), url: `${HUB}/a/act_6` },
      ),
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const items = [
      { kind: 'service-action', ...ACTION },
      {
        kind: 'credential-check',
        ...CHECK_ARGS,
        claims: ['age_over_18', 'birth_date'],
        days: 30,
      },
    ];
    await expect(
      run(
        tools.credentials_request_permissions,
        { items },
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({ status: 'sent', permissionId: 'card_1' });
    const posts = cardPosts(calls);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? '').permissions).toHaveLength(2);

    // The fields asked are all among the allowed card's: nothing is sent.
    const covered = routedFetch({
      ...NEW_CARD,
      ...listed(checkCard('card_5', 'allowed', ['age_over_18', 'birth_date'])),
    });
    await expect(
      run(
        toolsFor(covered.fetchImpl, oracleKey.doc)
          .credentials_request_check_permission,
        CHECK_ARGS,
        channelCtx(adapter),
      ),
    ).resolves.toMatchObject({
      status: 'already_allowed',
      permissionId: 'card_5',
    });
    expect(cardPosts(covered.calls)).toHaveLength(0);

    // Another issuer than the card's, or an item that is no longer allowed: a new card.
    for (const card of [
      {
        ...checkCard('card_5', 'allowed', ['age_over_18']),
        items: [
          {
            index: 0,
            kind: 'credential-check',
            vct: VCT,
            issuers: ['did:ixo:entity:other'],
            claims: ['age_over_18'],
            status: 'allowed',
          },
        ],
      },
      {
        ...checkCard('card_5', 'allowed', ['age_over_18']),
        items: [
          {
            index: 0,
            kind: 'credential-check',
            vct: VCT,
            issuers: [ISSUER_DID],
            claims: ['age_over_18'],
            status: 'stopped',
          },
        ],
      },
      // Top-level allowed, but nothing Allow wrote is left on the item.
      {
        ...checkCard('card_5', 'allowed', ['age_over_18']),
        items: [
          {
            index: 0,
            kind: 'credential-check',
            vct: VCT,
            issuers: [ISSUER_DID],
            claims: ['age_over_18'],
            status: 'allowed',
          },
        ],
      },
      checkCard('card_5', 'stopping', ['age_over_18']),
      checkCard('card_5', 'allowing', ['age_over_18']),
    ]) {
      const other = routedFetch({ ...NEW_CARD, ...listed(card) });
      await expect(
        run(
          toolsFor(other.fetchImpl, oracleKey.doc)
            .credentials_request_check_permission,
          CHECK_ARGS,
          channelCtx(adapter),
        ),
      ).resolves.toMatchObject({ status: 'sent', permissionId: 'card_1' });
      expect(cardPosts(other.calls)).toHaveLength(1);
    }
  });

  it('refreshes a stale grant from the Hub once and retries once', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const hub = { status: 0, list: 0 };
    const { fetchImpl, calls } = routedFetch({
      ...NEW_CARD,
      // The kv's card was stopped; the person allowed a newer one elsewhere.
      [`GET ${HUB}/api/internal/permissions/card_1`]: [
        () => {
          hub.status += 1;
          return json(identityCard('card_1', 'allowed', fresh('OLD')));
        },
        () => {
          hub.status += 1;
          return json(identityCard('card_1', 'stopped'));
        },
      ],
      [`GET ${HUB}/api/internal/permissions/card_8`]: () =>
        json(identityCard('card_8', 'allowed', fresh('NEW'))),
      [`GET ${LIST_URL}`]: [
        () => {
          hub.list += 1;
          return json({ permissions: [] });
        },
        () => {
          hub.list += 1;
          return json({
            permissions: [identityCard('card_8', 'allowed', fresh('NEW'))],
          });
        },
      ],
      [`POST ${SELF}/identity/v1/links`]: [
        () => json(LINK, 201),
        () => json({ error: 'forbidden', message: 'x' }, 403),
        () => json(LINK, 201),
        () => json({ error: 'forbidden', message: 'x' }, 403),
      ],
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    await run(tools.credentials_request_action_permission, ACTION, ctx);
    await run(tools.credentials_request_action, ACTION, ctx);
    expect(hub).toEqual({ status: 1, list: 1 });
    // Self refuses the kept grants: dropped, the card read again (stopped),
    // the list read once, the newer card's grants used for the one retry.
    await expect(
      run(tools.credentials_request_action, ACTION, ctx),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(hub).toEqual({ status: 2, list: 2 });
    const links = calls.filter((c) => c.url === `${SELF}/identity/v1/links`);
    expect(links.map((c) => JSON.parse(c.body).offerConsent)).toEqual([
      'OLD_offer',
      'OLD_offer',
      'NEW_offer',
    ]);
    expect(
      await kv.get(CREDENTIALS_KV_NAMESPACE, 'action:self.identity-check'),
    ).toEqual({ permissionId: 'card_8' });
    // Refused again with nothing newer at the Hub: one refresh, one retry, then the plain answer.
    const before = calls.length;
    await expect(
      run(tools.credentials_request_action, ACTION, ctx),
    ).resolves.toEqual(refusal('forbidden', MESSAGES.permissionEnded));
    expect(calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${SELF}/identity/v1/links`,
      `GET ${HUB}/api/internal/permissions/card_8`,
      `POST ${SELF}/identity/v1/links`,
    ]);
  });

  it('asks for permission, as before, when the refreshed list holds nothing', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl } = routedFetch({
      ...NEW_CARD,
      [`GET ${HUB}/api/internal/permissions/card_1`]: [
        () => json(identityCard('card_1', 'allowed', GRANTS)),
        () => json(identityCard('card_1', 'stopped')),
      ],
      ...listed(),
      [`POST ${SELF}/identity/v1/links`]: [
        () => json(LINK, 201),
        () => json({ error: 'forbidden', message: 'x' }, 403),
      ],
    });
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    await run(tools.credentials_request_action_permission, ACTION, ctx);
    await run(tools.credentials_request_action, ACTION, ctx);
    await expect(
      run(tools.credentials_request_action, ACTION, ctx),
    ).resolves.toEqual(refusal('permission_ended', MESSAGES.permissionEnded));
  });

  it('behaves as before when the list cannot be read (older Hub, down, slow, broken)', async () => {
    const { adapter, oracleKey } = recordingUcan();
    for (const answer of [
      () => json({ error: 'not_found', message: 'x' }, 404),
      () => new Response('', { status: 405 }),
      () => json({ error: 'unauthorized', message: 'x' }, 401),
      () => json({ error: 'unavailable', message: 'x' }, 503),
      () =>
        json({ error: 'rate_limited', message: 'x' }, 429, {
          'retry-after': '10',
        }),
      () => json({ error: 'invalid_request', message: 'x' }, 400),
      () => json({ nothing: true }),
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ]) {
      const { fetchImpl, calls } = routedFetch({
        ...NEW_CARD,
        [`GET ${LIST_URL}`]: answer,
      });
      const tools = toolsFor(fetchImpl, oracleKey.doc);
      const ctx = channelCtx(adapter);
      // No permission in the kv: the usual answer, never an error from the lookup.
      await expect(
        run(tools.credentials_request_action, ACTION, ctx),
      ).resolves.toEqual(refusal('no_permission', MESSAGES.noPermission));
      await expect(
        run(
          tools.credentials_permission_status,
          { permissionId: 'card_9' },
          ctx,
        ),
      ).resolves.toEqual(refusal('not_found', MESSAGES.notFound));
      // A card is sent as it always was.
      await expect(
        run(tools.credentials_request_action_permission, ACTION, ctx),
      ).resolves.toMatchObject({ status: 'sent', permissionId: 'card_1' });
      expect(cardPosts(calls)).toHaveLength(1);
    }
  });

  it('reads the status of a card the kv forgot when the Hub lists it for this person', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl, calls } = routedFetch(
      listed(identityCard('card_7', 'allowed', GRANTS)),
    );
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter, { kv });
    const out = await run(
      tools.credentials_permission_status,
      { permissionId: 'card_7' },
      ctx,
    );
    expect(out).toMatchObject({
      permissionId: 'card_7',
      status: 'allowed',
      items: [{ index: 0, kind: 'service-action', state: 'allowed' }],
    });
    expect(JSON.stringify(out)).not.toContain('DELEGATION');
    // An id the Hub does not list for this person stays unknown.
    await expect(
      run(tools.credentials_permission_status, { permissionId: 'card_8' }, ctx),
    ).resolves.toEqual(refusal('not_found', MESSAGES.notFound));
    expect(calls.map((c) => c.url)).toEqual([LIST_URL, LIST_URL]);
  });

  it('reads the list at most 6 times a minute per person, then goes on from the kv', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const { fetchImpl, calls } = routedFetch(listed());
    const tools = toolsFor(fetchImpl, oracleKey.doc);
    const ctx = channelCtx(adapter);
    for (let i = 0; i < 9; i++)
      await expect(
        run(tools.credentials_request_action, ACTION, ctx),
      ).resolves.toEqual(refusal('no_permission', MESSAGES.noPermission));
    expect(calls).toHaveLength(6);
  });

  it('returns the capabilities of another entry from the Hub when the kv is empty', async () => {
    const { adapter, oracleKey } = recordingUcan();
    const card = identityCard('card_4', 'allowed', GRANTS);
    const { fetchImpl } = routedFetch(
      listed({
        ...card,
        items: [{ ...card.items[0], action: 'yo.rewards-claim' }],
      }),
    );
    const out = await run(
      toolsFor(fetchImpl, oracleKey.doc).credentials_request_action,
      { action: 'yo.rewards-claim' },
      channelCtx(adapter),
    );
    expect(out).toMatchObject({
      status: 'granted',
      permissionId: 'card_4',
      action: 'yo.rewards-claim',
      state: 'allowed',
    });
    expect(JSON.stringify(out)).not.toContain('DELEGATION');
  });
});
