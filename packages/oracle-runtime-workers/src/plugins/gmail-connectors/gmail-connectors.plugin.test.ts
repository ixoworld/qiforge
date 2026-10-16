import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import {
  createDelegation,
  createUCANValidator,
  defineCapability,
  generateKeypair,
  parseDelegation,
  serializeDelegation,
  signerFromMnemonic,
  type Capability,
  type Signer,
} from '@ixo/ucan';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { WorkersUcanService } from '../../do/ucan-service';
import type { RuntimeContext } from '../../plugin-api/types';
import { GmailConnectorPlugin } from './gmail-connectors.plugin';
import { gmailProfileResource, gmailRequestHash } from './contract';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ACCOUNT = 'ca_gmail-selected';
const PROFILE = {
  emailAddress: 'owner@example.com',
  messagesTotal: 42,
  threadsTotal: 12,
  historyId: '1234',
};
const plugin = new GmailConnectorPlugin();
let owner: Signer;
let oracle: Signer;
let service: Signer;
let server: Server;
let origin: string;
let grant: string;
let expiresAt: number;
let wireStatus: unknown;
let profileBody: unknown;
let statusCode: number;
let delay: boolean;
let statusCalls: number;
let profileCalls: number;
let received: Array<{ action: string; body: unknown; invocation: string }>;
let serverErrors: unknown[];

async function delegation(
  capabilities: Capability[] = [
    { can: 'tool/execute', with: gmailProfileResource(ACCOUNT) },
  ],
  overrides: {
    issuer?: Signer;
    audience?: string;
    expiration?: number;
    notBefore?: number;
    proofs?: Awaited<ReturnType<typeof createDelegation>>[];
  } = {},
): Promise<string> {
  return serializeDelegation(
    await createDelegation({
      issuer: owner,
      audience: oracle.did(),
      capabilities,
      expiration: expiresAt,
      ...overrides,
    }),
  );
}

function context(): RuntimeContext {
  const ucan = new WorkersUcanService({
    oracleDid: oracle.did(),
    signingMnemonic: MNEMONIC,
  });
  const ctx = makeRuntimeContext({
    config: {
      GMAIL_CONNECTOR_URL: origin,
      GMAIL_CONNECTOR_OWNER_URL: 'https://portal.example/settings/agents/gmail',
      ORACLE_DID: oracle.did(),
      NETWORK: 'testnet',
      BLOCKSYNC_GRAPHQL_URL: `${origin}/graphql`,
    },
    user: {
      did: owner.did(),
      matrixUserId: '@owner:test',
      ucanDelegation: { raw: 'unrelated-chat-grant' },
    },
  });
  return {
    ...ctx,
    ucan: {
      ...ctx.ucan,
      hasSigningKey: () => ucan.hasSigningKey(),
      mintSelfSignedInvocation: (...args) =>
        ucan.mintSelfSignedInvocation(...args),
      createInvocationFromDelegation: (...args) =>
        ucan.createInvocationFromDelegation(...args),
    },
  };
}

async function call(name: string, ctx = context(), args: unknown = {}) {
  const tool = plugin.getTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool missing ${name}`);
  return tool.handler(args, ctx);
}

beforeAll(async () => {
  owner = (await generateKeypair()).signer;
  oracle = (await signerFromMnemonic(MNEMONIC)).signer;
  service = (await generateKeypair()).signer;
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/.well-known/did.json') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: service.did() }));
        return;
      }
      const action = req.url?.split('/').at(-1) ?? '';
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      const invocation = (req.headers.authorization ?? '').replace(
        /^Bearer /,
        '',
      );
      received.push({ action, body, invocation });
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-auth-type'], 'ucan');
      assert.equal(req.headers['x-ixo-network'], 'testnet');
      assert.deepEqual(
        body,
        action === 'status'
          ? { ownerDid: owner.did() }
          : { ownerDid: owner.did(), connectedAccountId: ACCOUNT },
      );
      const validator = await createUCANValidator({
        serverDid: service.did(),
        rootIssuers: [action === 'status' ? oracle.did() : owner.did()],
        requireExpiration: true,
      });
      const resource =
        action === 'status'
          ? `composio://agent/${oracle.did()}/toolkit/gmail`
          : gmailProfileResource(ACCOUNT);
      const valid = await validator.validate(
        invocation,
        defineCapability({
          can: action === 'status' ? 'connector/status' : 'tool/execute',
          protocol: 'composio:',
        }),
        resource,
      );
      assert.equal(valid.ok, true);
      const parsed = await parseDelegation(invocation);
      assert.equal(parsed.issuer.did(), oracle.did());
      assert.equal(parsed.proofs.length, action === 'status' ? 0 : 1);
      assert.ok(parsed.expiration <= Math.floor(Date.now() / 1000) + 60);
      assert.deepEqual(parsed.capabilities[0]?.nb, {
        requestHash: await gmailRequestHash({
          action: action === 'status' ? 'status' : 'profile',
          ownerDid: owner.did(),
          oracleDid: oracle.did(),
          connectedAccountId: action === 'status' ? null : ACCOUNT,
        }),
      });
      if (action === 'status') statusCalls++;
      if (action === 'profile') profileCalls++;
      if (delay) return;
      res.statusCode = statusCode;
      if (statusCode === 302)
        res.setHeader('location', `${origin}/redirect-target`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(action === 'status' ? wireStatus : profileBody));
    } catch (error) {
      serverErrors.push(error);
      res.statusCode = 500;
      res.end('controlled endpoint assertion failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP server missing address');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

beforeEach(async () => {
  expiresAt = Math.floor(Date.now() / 1000) + 3600;
  grant = await delegation();
  wireStatus = {
    status: 'ready',
    connectedAccountId: ACCOUNT,
    delegation: grant,
    expiresAt,
  };
  profileBody = {
    status: 'ready',
    profile: { ...PROFILE, accessToken: 'SECRET' },
    delegation: 'SECRET',
  };
  statusCode = 200;
  delay = false;
  statusCalls = 0;
  profileCalls = 0;
  received = [];
  serverErrors = [];
});

describe('GmailConnectorPlugin over controlled HTTP with real signatures', () => {
  it('mints a fresh invocation for repeated status and profile calls in one second', async () => {
    const ctx = context();
    expect(await call('read_gmail_profile', ctx)).toEqual({
      status: 'ready',
      profile: PROFILE,
    });
    expect(await call('read_gmail_profile', ctx)).toEqual({
      status: 'ready',
      profile: PROFILE,
    });
    const cids = await Promise.all(
      received.map(async ({ invocation }) =>
        (await parseDelegation(invocation)).cid.toString(),
      ),
    );
    expect(new Set(cids).size).toBe(4);
    expect(serverErrors).toEqual([]);
  });

  it('refuses redirects without forwarding the bearer invocation', async () => {
    statusCode = 302;
    expect(await call('read_gmail_profile')).toEqual({
      status: 'unavailable',
      reason: 'connector',
    });
    expect(statusCalls).toBe(1);
    expect(received).toHaveLength(1);
    expect(profileCalls).toBe(0);
    expect(serverErrors).toEqual([]);
  });
  it('is opt-in, on-demand, read-only and has exactly four zero-argument tools', () => {
    expect(plugin.name).toBe('gmail-connectors');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetect(context().config)).toBe(true);
    expect(
      plugin.autoDetect({
        GMAIL_CONNECTOR_URL: 'https://proxy.example',
        GMAIL_CONNECTOR_OWNER_URL: 'https://user:secret@portal.example',
      }),
    ).toBe(false);
    const tools = plugin.getTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'gmail_connection_status',
      'connect_gmail',
      'read_gmail_profile',
      'disconnect_gmail',
    ]);
    for (const tool of tools) {
      expect(tool.effect).toBe('read');
      expect(tool.schema.safeParse({ ownerDid: 'attacker' }).success).toBe(
        false,
      );
    }
  });

  it('verifies the status signer, scope, owner hash and TTL, and returns readiness without the proof', async () => {
    const result = await call('gmail_connection_status');
    expect(result).toEqual({
      status: 'ready',
      connectedAccountId: ACCOUNT,
      expiresAt,
      permission: 'gmail.profile.read',
    });
    expect(JSON.stringify(result)).not.toContain(grant);
    expect(statusCalls).toBe(1);
    expect(profileCalls).toBe(0);
    expect(serverErrors).toEqual([]);
  });

  it('obtains a fresh proof and executes exactly the selected fixed profile read', async () => {
    const result = await call('read_gmail_profile');
    expect(result).toEqual({ status: 'ready', profile: PROFILE });
    expect(statusCalls).toBe(1);
    expect(profileCalls).toBe(1);
    expect(serverErrors).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain(grant);
    expect(received[1]?.body).toEqual({
      ownerDid: owner.did(),
      connectedAccountId: ACCOUNT,
    });
  });

  it.each(['authorization_required', 'pending', 'unavailable'])(
    'truthfully returns %s and never attempts a profile read',
    async (status) => {
      wireStatus = {
        status,
        delegation: 'SECRET',
        ownerActionUrl: 'https://attacker.example',
      };
      const result = await call('read_gmail_profile');
      expect(result).toMatchObject({ status });
      expect(JSON.stringify(result)).toContain(
        status === 'unavailable'
          ? '"reason":"connector"'
          : 'https://portal.example/settings/agents/gmail?',
      );
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(JSON.stringify(result)).not.toContain('attacker');
      expect(profileCalls).toBe(0);
      expect(serverErrors).toEqual([]);
    },
  );

  it.each(['connect', 'disconnect'] as const)(
    'returns an owner action for %s without any network effect',
    async (action) => {
      const result = await call(`${action}_gmail`);
      const url = new URL(`https://portal.example/settings/agents/gmail`);
      url.searchParams.set('oracleDid', oracle.did());
      url.searchParams.set('ownerDid', owner.did());
      url.searchParams.set('action', action);
      expect(result).toEqual({
        status: 'owner_action_required',
        action,
        ownerActionUrl: url.toString(),
      });
      expect(received).toEqual([]);
    },
  );

  it.each([
    'wrong owner',
    'wrong oracle',
    'wrong account',
    'wrong tool',
    'wildcard',
    'extra capability',
    'expired',
    'unbounded',
    'over seven days',
    'future',
    'proof chain',
    'caveat',
    'wrong expiry',
    'forged signature',
    'malformed',
  ])('rejects a %s grant before profile admission', async (variant) => {
    const other = (await generateKeypair()).signer;
    let bad = grant;
    let reportedExpiry = expiresAt;
    switch (variant) {
      case 'wrong owner':
        bad = await delegation(undefined, { issuer: other });
        break;
      case 'wrong oracle':
        bad = await delegation(undefined, { audience: other.did() });
        break;
      case 'wrong account':
        bad = await delegation([
          { can: 'tool/execute', with: gmailProfileResource('ca_other') },
        ]);
        break;
      case 'wrong tool':
        bad = await delegation([
          {
            can: 'tool/execute',
            with: 'composio://toolkit/gmail/account/ca_gmail-selected/tool/GMAIL_SEND_EMAIL',
          },
        ]);
        break;
      case 'wildcard':
        bad = await delegation([
          { can: 'tool/*', with: 'composio://toolkit/gmail/*' },
        ]);
        break;
      case 'extra capability':
        bad = await delegation([
          { can: 'tool/execute', with: gmailProfileResource(ACCOUNT) },
          { can: 'tool/execute', with: gmailProfileResource('ca_other') },
        ]);
        break;
      case 'expired':
        reportedExpiry = Math.floor(Date.now() / 1000) - 1;
        bad = await delegation(undefined, { expiration: reportedExpiry });
        break;
      case 'unbounded':
        bad = await delegation(undefined, { expiration: Infinity });
        break;
      case 'over seven days':
        reportedExpiry = Math.floor(Date.now() / 1000) + 7 * 86400 + 60;
        bad = await delegation(undefined, { expiration: reportedExpiry });
        break;
      case 'future':
        bad = await delegation(undefined, {
          notBefore: Math.floor(Date.now() / 1000) + 100,
        });
        break;
      case 'proof chain':
        bad = await delegation(undefined, {
          proofs: [await parseDelegation(grant)],
        });
        break;
      case 'caveat':
        bad = await delegation([
          {
            can: 'tool/execute',
            with: gmailProfileResource(ACCOUNT),
            nb: { arbitrary: true },
          },
        ]);
        break;
      case 'wrong expiry':
        reportedExpiry++;
        break;
      case 'forged signature':
        bad = await delegation(undefined, {
          issuer: other.withDID(owner.did()),
        });
        break;
      case 'malformed':
        bad = 'SECRET_BAD_CAR';
        break;
    }
    wireStatus = {
      status: 'ready',
      connectedAccountId: ACCOUNT,
      delegation: bad,
      expiresAt: reportedExpiry,
    };
    const result = await call('read_gmail_profile');
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(profileCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(bad);
    expect(serverErrors).toEqual([]);
  });

  it('rejects model account and slug inputs before any HTTP request', async () => {
    expect(
      await call('read_gmail_profile', context(), {
        connectedAccountId: 'ca_other',
        slug: 'GMAIL_SEND_EMAIL',
      }),
    ).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(received).toEqual([]);
  });

  it('fails closed with missing config or signing key without network effects', async () => {
    const ctx = context();
    expect(await call('read_gmail_profile', { ...ctx, config: {} })).toEqual({
      status: 'unavailable',
      reason: 'configuration',
    });
    expect(
      await call('read_gmail_profile', {
        ...ctx,
        ucan: { ...ctx.ucan, hasSigningKey: () => false },
      }),
    ).toEqual({ status: 'unavailable', reason: 'signing' });
    expect(received).toEqual([]);
  });

  it('sanitizes upstream errors without retrying or leaking response bodies to logs or state', async () => {
    statusCode = 503;
    wireStatus = { error: `SECRET:${grant}` };
    const ctx = context();
    const logs = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const result = await call('read_gmail_profile', { ...ctx, logger: logs });
    expect(result).toEqual({ status: 'unavailable', reason: 'connector' });
    expect(statusCalls).toBe(1);
    expect(profileCalls).toBe(0);
    expect(logs.log).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
    expect(ctx.history.messages).toEqual([]);
  });

  it('bounds an oversized successful response and exposes no proof', async () => {
    wireStatus = {
      status: 'ready',
      delegation: grant,
      padding: 'X'.repeat(70_000),
    };
    expect(await call('read_gmail_profile')).toEqual({
      status: 'unavailable',
      reason: 'connector',
    });
    expect(profileCalls).toBe(0);
  });

  it('honors caller cancellation for a stalled HTTP response without retry', async () => {
    delay = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      expect(
        await call('read_gmail_profile', {
          ...context(),
          abortSignal: controller.signal,
        }),
      ).toEqual({ status: 'unavailable', reason: 'connector' });
      expect(statusCalls).toBe(1);
      expect(profileCalls).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  });

  it('bounds a stalled response with its own deadline and does not retry', async () => {
    delay = true;
    expect(await call('read_gmail_profile')).toEqual({
      status: 'unavailable',
      reason: 'connector',
    });
    expect(statusCalls).toBe(1);
    expect(profileCalls).toBe(0);
  }, 15_000);
});
