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
    expect(JSON.parse(calls[0]?.body ?? '').permission.issuers).toEqual([
      ISSUER_DID,
    ]);
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
    const kv = createMemoryUserKv();
    await recordPermission(kv, 'card_1');
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
      hint: 'No standing permission answered. Send `message` as it is, or ask for standing permission with credentials_request_check_permission; then call again with the same fields to continue this request.',
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

describe('what the plugin keeps per person (kv)', () => {
  const ALLOWED = (calls?: { n: number }) => () => {
    if (calls) calls.n += 1;
    return json({
      id: 'card_1',
      status: 'allowed',
      grants: [
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
      ],
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
        json({ id: 'card_9', status: 'allowed' }),
    });
    await expect(
      run(
        toolsFor(fetchImpl, oracleKey.doc).credentials_permission_status,
        { permissionId: 'card_9' },
        channelCtx(adapter),
      ),
    ).resolves.toEqual(refusal('not_found', MESSAGES.notFound));
    expect(calls).toHaveLength(0);
  });

  it("records the check cards' ids too", async () => {
    const { adapter, oracleKey } = recordingUcan();
    const kv = createMemoryUserKv();
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}/api/internal/permissions`]: () => json(CARD, 201),
      [`GET ${HUB}/api/internal/permissions/card_1`]: () =>
        json({ id: 'card_1', status: 'pending' }),
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
