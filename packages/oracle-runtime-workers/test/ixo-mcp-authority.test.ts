import {
  env,
  runInDurableObject,
  createExecutionContext,
} from 'cloudflare:test';
import {
  createDelegation,
  generateKeypair,
  parseDelegation,
  serializeDelegation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOracleWorker } from '../src';
import { createUserOracleDO } from '../src/do/user-oracle-do';
import { WorkersUcanService } from '../src/do/ucan-service';
import { userObjectName, type OracleWorkerEnv } from '../src/do/contracts';
import { createMcpIxoTools, mcpContext } from '../src/do/ixo-mcp';
import { createCurrentIxoAudienceReader } from '../src/do/ixo-tools';
import { createRuntimeCore } from '../src/core';
import { makeEnv } from '../src/core/test-fixtures';
import { IxoToolsPlugin } from '../src/plugins/ixo-tools';
import { readIxoToolsConfig } from '../src/ixo-tools/config';
import { createIxoSourceAuthority } from '../src/ixo-tools/source-authority';
import {
  parseIxoMcpConfig,
  type IxoMcpAuthorization,
} from '../src/ixo-tools/mcp';
import topic from '../../agent-tools-sources/tests/fixtures/topics.md?raw';

const mnemonic =
  'test-only stage seven oracle signer, never a deployed credential';
const oracle = await signerFromMnemonic(mnemonic);
const user = await generateKeypair();
const registration = {
  resource: 'https://mcp.test/v1/mcp',
  issuer: 'https://auth.test',
  resourceClientId: 'resource-client',
  clients: [{ clientId: 'client-a' }, { clientId: 'client-b' }],
};
const settings = parseIxoMcpConfig(registration);
const sourceRecord = {
  IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: 'https://subscriptions.test',
  IXO_TOOLS_MEMORY_ORIGIN: 'https://memory.test',
  IXO_TOOLS_VFS_ORIGIN: 'https://vfs.test',
  IXO_TOOLS_YELLOWCARD_ORIGIN: 'https://yellowcard.test',
  IXO_TOOLS_UCAN_STORE_ORIGIN: 'https://store.test',
};
const sourceConfig = readIxoToolsConfig(sourceRecord);
const principal = () => ({
  active: true as const,
  iss: settings.issuer,
  sub: user.did,
  aud: settings.resource,
  client_id: 'client-a',
  gid: 'grant-a',
  gver: 'generation-a',
  scope: 'ixo:tools:read',
  iat: Math.floor(Date.now() / 1000) - 1,
  exp: Math.floor(Date.now() / 1000) + 20,
  jti: 'access-a',
  token_type: 'Bearer' as const,
});
const authorization = (current = async () => true): IxoMcpAuthorization => ({
  principal: principal(),
  client: settings.clients[0]!,
  current,
});
const contextInput = () => ({
  authorization: authorization(),
  oracleDid: oracle.did,
  network: 'devnet' as const,
  visibility: 'private' as const,
});
const request = (
  name = 'ixo_concept_get',
  args: Record<string, unknown> = { concept: 'Topic' },
) =>
  new Request(settings.resource, {
    method: 'POST',
    headers: {
      authorization: 'Bearer access-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
const unused = (): never => {
  throw new Error('Unexpected namespace use');
};
const namespace = {
  newUniqueId: unused,
  idFromName: unused,
  idFromString: unused,
  get: unused,
  getByName: unused,
  getExisting: unused,
  jurisdiction: unused,
};

afterEach(() => vi.unstubAllGlobals());

describe('MCP owner scope and native authority', () => {
  it('isolates actor, client, grant generation, resource, oracle and network deterministically', async () => {
    const input = contextInput();
    const base = await mcpContext(input);
    expect(await mcpContext(input)).toEqual(base);
    for (const patch of [
      { sub: 'did:ixo:other' },
      { client_id: 'client-b' },
      { gid: 'grant-b' },
      { gver: 'generation-b' },
      { aud: 'https://other.test/v1/mcp' },
      { iss: 'https://other-auth.test' },
    ]) {
      const changed = await mcpContext({
        ...input,
        authorization: {
          ...input.authorization,
          principal: { ...input.authorization.principal, ...patch },
        },
      });
      expect(changed.sessionId).not.toBe(base.sessionId);
      expect(changed.roomId).not.toBe(base.roomId);
    }
    expect(
      (await mcpContext({ ...input, network: 'testnet' })).sessionId,
    ).not.toBe(base.sessionId);
    expect(
      (await mcpContext({ ...input, oracleDid: 'did:ixo:other' })).sessionId,
    ).not.toBe(base.sessionId);
  });

  it('does not infer private MCP disclosure from a direct-session name', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: {
          iids: {
            nodes: [
              {
                id: 'did:ixo:alice',
                service: [
                  {
                    type: 'MatrixHomeServer',
                    serviceEndpoint: 'https://matrix.test',
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    const participants = vi.fn(async () => ({
      oracleMatrixId: '@oracle:matrix.test',
      joined: ['@did-ixo-alice:matrix.test', '@oracle:matrix.test'],
    }));
    const read = createCurrentIxoAudienceReader({
      client: 'mcp',
      sessionId: 'direct-session',
      roomId: '!owner:matrix.test',
      userDid: 'did:ixo:alice',
      blocksyncUri: 'https://indexer.test/graphql',
      participants,
      fetch: fetcher,
    });
    expect(await read()).toBe('private');
    expect(fetcher).toHaveBeenCalledTimes(1);
    participants.mockResolvedValue({
      oracleMatrixId: '@oracle:matrix.test',
      joined: [
        '@did-ixo-alice:matrix.test',
        '@oracle:matrix.test',
        '@guest:matrix.test',
      ],
    });
    expect(await read()).toBe('shared');
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await read()).toBe('shared');
  });

  it('never upgrades missing native grants', async () => {
    const binding = await createMcpIxoTools({
      ...contextInput(),
      config: sourceConfig,
      ucan: new WorkersUcanService({ oracleDid: oracle.did }).forTurn(
        user.did,
        undefined,
      ),
      currentVerifiedDelegation: async () => null,
      currentAudience: async () => 'shared',
    });
    expect(await binding.tools.discover()).toEqual({
      status: 'available',
      tools: [],
    });
    expect(await binding.tools.invoke('ixo_credits_get', {})).toMatchObject({
      status: 'unauthorized',
    });
  });

  it('reports incomplete chat attachment coverage while retaining authorized VFS reads', async () => {
    const auth = authorization();
    const binding = await createMcpIxoTools({
      authorization: auth,
      oracleDid: oracle.did,
      network: 'devnet',
      config: sourceConfig,
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => 'did:web:store.test',
        getServiceDelegation: async () => ({
          token: 'stored-filesystem-proof',
          with: 'ixo:filesystem',
        }),
        createInvocationFromDelegation: async () => ({
          invocation: 'narrow-vfs-invocation',
        }),
      },
      currentVerifiedDelegation: async () => ({
        raw: 'verified-native-proof',
        revision: auth,
        expiration: auth.principal.exp,
        capabilities: [
          { with: 'ixo:agent-tools', can: 'agent-tools/ixo_files_find' },
        ],
      }),
      currentAudience: async () => 'private',
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/.well-known/did.json')
          return Response.json({ id: 'did:web:vfs.test' });
        const scope = {
          userDid: user.did,
          namespace: `user:${user.did.split(':')[2]}`,
          path: '/',
        };
        if (url.pathname === '/api/fs/observations/check')
          return Response.json({
            scope,
            observedAt: new Date().toISOString(),
            current: true,
            files: [],
          });
        expect(url.pathname).toBe('/api/fs/observations');
        return Response.json({
          scope,
          observedAt: new Date().toISOString(),
          revisionKind: 'metadata-observation',
          coverage: 'complete',
          searchCoverage: 'unverified',
          snapshotRevision: 'b'.repeat(64),
          files: [],
        });
      },
    });
    const result = await binding.tools.invoke('ixo_files_find', {
      query: 'invoice',
      when: 'yesterday',
    });
    expect(result).toMatchObject({
      status: 'available',
      value: {
        matches: [],
        coverage: [
          { source: 'vfs', state: 'complete' },
          { source: 'attachment', state: 'partial' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('not_found');
  });

  it('withholds a result when OAuth is revoked during a source read', async () => {
    let active = true;
    const auth = authorization(async () => active);
    const binding = await createMcpIxoTools({
      authorization: auth,
      oracleDid: oracle.did,
      network: 'devnet',
      config: sourceConfig,
      ucan: new WorkersUcanService({ oracleDid: oracle.did }).forTurn(
        user.did,
        undefined,
      ),
      currentVerifiedDelegation: async () => ({
        raw: 'verified-native-proof',
        revision: auth,
        expiration: auth.principal.exp,
        capabilities: [
          { with: 'ixo:agent-tools', can: 'agent-tools/ixo_concept_get' },
        ],
      }),
      currentAudience: async () => 'shared',
      fetch: async () => {
        active = false;
        return new Response(topic);
      },
    });
    const result = await binding.tools.invoke('ixo_concept_get', {
      concept: 'Topic',
    });
    expect(result.status).toBe('unauthorized');
    expect(result).not.toHaveProperty('value');
  });

  it('caps real ordinary and VFS UCANs at the absolute ingress expiry', async () => {
    const issuer = new WorkersUcanService({
      oracleDid: oracle.did,
      signingMnemonic: mnemonic,
    });
    const expiration = Math.floor(Date.now() / 1000) + 8;
    const native = await serializeDelegation(
      await createDelegation({
        issuer: user.signer,
        audience: oracle.did,
        expiration: expiration + 600,
        capabilities: [
          { with: 'ixo:subscriptions', can: 'subscriptions/read' },
          { with: 'ixo:filesystem', can: 'fs/list' },
        ],
      }),
    );
    const context = await mcpContext(contextInput());
    const authority = createIxoSourceAuthority({
      context,
      origins: sourceConfig.origins,
      storeUrl: sourceConfig.storeUrl,
      currentDelegation: async () => ({
        raw: native,
        expiration,
        capabilities: [
          { with: 'ixo:subscriptions', can: 'subscriptions/read' },
        ],
      }),
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => 'did:web:store.test',
        getServiceDelegation: async () => ({
          token: native,
          with: 'ixo:filesystem',
        }),
        createInvocationFromDelegation: (...args) =>
          issuer.createInvocationFromDelegation(...args),
      },
    });
    for (const token of [
      await authority.subscriptions(context),
      await authority.vfs(context, 'list'),
    ]) {
      expect(token).toBeTruthy();
      const parsed = await parseDelegation(token!);
      expect(parsed.expiration).toBe(expiration);
    }
    expect(
      await issuer.createInvocationFromDelegation(
        native,
        'did:web:subscriptions.test',
        { can: 'subscriptions/read', with: 'ixo:subscriptions' },
        { expiresAt: Math.floor(Date.now() / 1000) - 1 },
      ),
    ).toMatchObject({ error: 'Invocation authority expired' });
  });

  it('runs the real owner class against stored signed native grants without booting chat', async () => {
    const native = await serializeDelegation(
      await createDelegation({
        issuer: user.signer,
        audience: oracle.did,
        expiration: Math.floor(Date.now() / 1000) + 600,
        capabilities: [
          { with: 'ixo:agent-tools', can: 'agent-tools/ixo_concept_get' },
        ],
      }),
    );
    let active = true;
    const tokenPrincipal = principal();
    const calls: Request[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const outbound = new Request(input, init);
        calls.push(outbound.clone());
        if (outbound.url === 'https://auth.test/oauth/introspect')
          return Response.json(active ? tokenPrincipal : { active: false });
        expect(outbound.url).toBe('https://docs.ixo.world/articles/topics.md');
        expect(outbound.headers.has('authorization')).toBe(false);
        return new Response(topic);
      },
    );
    const environment = {
      ...makeEnv(),
      ...sourceRecord,
      NETWORK: 'devnet',
      ORACLE_NAME: 'MCP test',
      ORACLE_DID: oracle.did,
      USER_ORACLE: namespace,
      MATRIX_GATEWAY: namespace,
      BLOCKSYNC_GRAPHQL_URL: 'https://indexer.test/graphql',
      MATRIX_BASE_URL: 'https://matrix.test',
      MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:matrix.test',
      MATRIX_ORACLE_ADMIN_PASSWORD: 'unused',
      ORACLE_SIGNING_MNEMONIC: mnemonic,
      IXO_MCP_RESOURCE_CLIENT_SECRET: 'resource-secret',
      OPEN_ROUTER_API_KEY: 'unused',
    } satisfies OracleWorkerEnv;
    const core = createRuntimeCore({
      config: { name: 'MCP test' },
      plugins: [new IxoToolsPlugin()],
      env: environment,
    });
    const Owner = createUserOracleDO({
      core: () => core,
      ixoToolsMcp: settings,
    });
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName(userObjectName(user.did, oracle.did)),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('meta:delegation', {
        raw: native,
        at: Date.now(),
        expiration: Math.floor(Date.now() / 1000) + 600,
      });
      const owner = new Owner(state, environment);
      const response = await owner.handleIxoMcp(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          structuredContent: { status: 'available', value: { text: topic } },
        },
      });
      expect(await state.storage.get('meta:userDid')).toBeUndefined();
      active = false;
      const denied = await owner.handleIxoMcp(request());
      expect(denied.status).toBe(401);
      active = true;
      const privateRead = await owner.handleIxoMcp(
        request('ixo_credits_get', {}),
      );
      expect(JSON.stringify(await privateRead.json())).toContain(
        'unauthorized',
      );
    });
    expect(
      calls.filter((call) => call.url.includes('/topics.md')),
    ).toHaveLength(1);
  });

  it('mounts metadata and rejects bad authentication before selecting an owner object', async () => {
    const worker = createOracleWorker({
      config: { name: 'MCP test' },
      plugins: [new IxoToolsPlugin()],
      ixoToolsMcp: registration,
    });
    const environment = {
      ORACLE_NAME: 'MCP test',
      BLOCKSYNC_GRAPHQL_URL: 'https://indexer.test/graphql',
      MATRIX_BASE_URL: 'https://matrix.test',
      MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:matrix.test',
      MATRIX_ORACLE_ADMIN_PASSWORD: 'unused',
      OPEN_ROUTER_API_KEY: 'unused',
      USER_ORACLE: namespace,
      MATRIX_GATEWAY: namespace,
      ORACLE_DID: oracle.did,
      IXO_MCP_RESOURCE_CLIENT_SECRET: 'secret',
    } satisfies OracleWorkerEnv;
    const response = await worker.fetch(
      new Request(
        'https://mcp.test/.well-known/oauth-protected-resource/v1/mcp',
      ),
      environment,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: settings.resource,
      scopes_supported: ['ixo:tools:read'],
    });
    const deniedRequest = request();
    deniedRequest.headers.delete('authorization');
    const denied = await worker.fetch(
      deniedRequest,
      environment,
      createExecutionContext(),
    );
    expect(denied.status).toBe(401);
    const preflight = new Request(settings.resource, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://unregistered.test',
        'access-control-request-method': 'POST',
      },
    });
    expect(
      (await worker.fetch(preflight, environment, createExecutionContext()))
        .status,
    ).toBe(403);
  });
});
