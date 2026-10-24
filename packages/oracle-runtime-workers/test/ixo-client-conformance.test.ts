import { catalog, type ToolName } from '@ixo/agent-tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeRuntimeContext } from '../src/core/test-fixtures';
import { IxoToolsPlugin } from '../src/plugins/ixo-tools';
import { handleIxoMcp, parseIxoMcpConfig } from '../src/ixo-tools/mcp';
import { argsByName, facts, loopFixture } from './ixo-tools-fixtures';

const config = parseIxoMcpConfig({
  resource: 'https://companion.test/v1/mcp',
  issuer: 'https://auth.test',
  resourceClientId: 'resource',
  clients: [{ clientId: 'client', disclosure: 'private' }],
});
const clients = ['native-plugin', 'official-sdk', 'langchain-adapter'] as const;
const textBlocks = z.array(
  z.object({ type: z.literal('text'), text: z.string() }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(
  kind: (typeof clients)[number],
  options: Parameters<typeof loopFixture>[0] = {},
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T14:00:00Z'));
  const f = loopFixture(options);
  let active = true;
  const messages: { method: string; version: string | null }[] = [];
  let negotiatedProtocol: string | null = null;
  const run = (request: Request) =>
    handleIxoMcp(request, {
      config,
      secret: 'test-secret',
      surfaceFor: async () => f.binding.tools,
    });
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${config.issuer}/oauth/introspect`) {
        const now = Math.floor(Date.now() / 1000);
        return Response.json(
          active
            ? {
                active: true,
                iss: config.issuer,
                sub: f.context.userDid,
                aud: config.resource,
                client_id: 'client',
                gid: 'grant',
                gver: 'generation',
                scope: 'ixo:tools:read',
                iat: now - 1,
                exp: now + 300,
                jti: 'token',
                token_type: 'Bearer',
              }
            : { active: false },
        );
      }
      expect(request.url).toBe(config.resource);
      const message =
        request.method === 'POST'
          ? z.object({ method: z.string() }).parse(await request.clone().json())
          : null;
      if (message) {
        messages.push({
          method: message.method,
          version: request.headers.get('mcp-protocol-version'),
        });
      }
      const response = await run(request);
      if (message?.method === 'initialize' && response.status === 200) {
        negotiatedProtocol = z
          .object({ result: z.object({ protocolVersion: z.string() }) })
          .parse(await response.clone().json()).result.protocolVersion;
      }
      return response;
    },
  );
  let call: (
    name: ToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  let list: () => Promise<string[]>;
  let close: () => Promise<void>;
  async function connect() {
    if (kind === 'native-plugin') {
      const base = makeRuntimeContext();
      const ctx = makeRuntimeContext({
        ixoTools: f.binding.tools,
        user: {
          ...base.user,
          did: f.context.userDid,
          timezone: f.context.timezone,
        },
        session: {
          ...base.session,
          id: f.context.sessionId,
          roomId: f.context.roomId,
        },
      });
      const plugin = new IxoToolsPlugin();
      const tools = await plugin.getRequestTools(ctx);
      call = async (name, args, signal) => {
        const tool = tools.find((tool) => tool.name === name);
        if (!tool) return { status: 'unauthorized', reason: 'grant_missing' };
        return tool.handler(
          args,
          signal ? { ...ctx, abortSignal: signal } : ctx,
        );
      };
      list = async () =>
        (await plugin.getRequestTools(ctx)).map((tool) => tool.name);
      close = async () => {};
    } else if (kind === 'official-sdk') {
      const client = new Client({ name: 'ixo-stage8-official', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.resource), {
          requestInit: { headers: { authorization: 'Bearer token' } },
        }),
      );
      call = async (name, args, signal) => {
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          { signal },
        );
        const text = textBlocks.parse(result.content)[0]?.text;
        expect(text).toBe(JSON.stringify(result.structuredContent));
        expect(result.isError).toBe(
          z.object({ status: z.string() }).parse(result.structuredContent)
            .status !== 'available',
        );
        return result.structuredContent;
      };
      list = async () => {
        const result = await client.listTools();
        expect(result.nextCursor).toBeUndefined();
        return result.tools.map((tool) => tool.name);
      };
      close = () => client.close();
    } else {
      const client = new MultiServerMCPClient({
        mcpServers: {
          ixo: {
            transport: 'http',
            url: config.resource,
            headers: { authorization: 'Bearer token' },
            automaticSSEFallback: false,
          },
        },
        prefixToolNameWithServerName: false,
      });
      const tools = await client.getTools();
      call = async (name, args, signal) => {
        const tool = tools.find((tool) => tool.name === name);
        if (!tool) return { status: 'unauthorized', reason: 'grant_missing' };
        try {
          const result: unknown = await tool.invoke(args, { signal });
          const content = z
            .union([
              textBlocks,
              z.object({
                type: z.literal('text'),
                text: z.string(),
                structuredContent: z.unknown(),
              }),
            ])
            .parse(result);
          const block = Array.isArray(content) ? content[0] : content;
          if (!block) throw new Error('MCP adapter returned no text result');
          return JSON.parse(block.text);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const start = error.message.indexOf('{"status":');
          if (start < 0) throw error;
          return JSON.parse(error.message.slice(start));
        }
      };
      list = async () => tools.map((tool) => tool.name);
      close = () => client.close();
    }
  }
  await connect();
  return {
    ...f,
    call: (
      name: ToolName,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => call(name, args, signal),
    list: () => list(),
    close: () => close(),
    messages,
    protocol: () => negotiatedProtocol,
    reconnect: async () => {
      await close();
      await connect();
    },
    revokeOAuth: () => {
      active = false;
    },
  };
}

async function settle(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    () => ({ status: 'rejected' }),
  );
}
function invalidOutcome(client: (typeof clients)[number]) {
  return client === 'langchain-adapter'
    ? { status: 'rejected' }
    : { status: 'fulfilled', value: { status: 'invalid_request' } };
}
function assertParity(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expected);
}
async function digest(value: unknown) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
for (const client of clients) {
  describe(`IXO conformance ${client}`, () => {
    it.each(catalog.map((tool) => tool.name))(
      'preserves %s domain value and provenance',
      async (name) => {
        const f = await setup(client);
        try {
          const expected = await f.binding.tools.invoke(name, argsByName[name]);
          expect(expected.status).toBe('available');
          const before = f.requests.length;
          const actual = await f.call(name, argsByName[name]);
          assertParity(actual, expected);
          expect(f.protocol()).toBe(
            client === 'native-plugin' ? null : LATEST_PROTOCOL_VERSION,
          );
          expect(
            f.messages
              .filter((message) => message.method === 'tools/call')
              .map((message) => message.version),
          ).toEqual(client === 'native-plugin' ? [] : [f.protocol()]);
          console.info(
            'IXO_CONFORMANCE_OBSERVATION ' +
              JSON.stringify({
                client,
                tool: name,
                protocol: f.protocol(),
                sourceCallCount: f.requests.length - before,
                expectedDomainDigest: await digest(expected),
                observedDomainDigest: await digest(actual),
                expectedEvidenceDigest: await digest(
                  expected.status === 'available' ? expected.evidence : [],
                ),
                observedEvidenceDigest: await digest(
                  z.object({ evidence: z.array(z.unknown()) }).parse(actual)
                    .evidence,
                ),
                comparison: 'equal',
              }),
          );
        } finally {
          await f.close();
        }
      },
    );
    it('rejects a changed domain value and swapped provenance assignment', async () => {
      const f = await setup(client);
      try {
        const credit = z
          .object({ value: z.object({ amount: z.string() }).passthrough() })
          .passthrough()
          .parse(await f.call('ixo_credits_get', {}));
        expect(() =>
          assertParity(
            { ...credit, value: { ...credit.value, amount: '99999' } },
            credit,
          ),
        ).toThrow();
        const personal = z
          .object({ evidence: z.array(z.unknown()) })
          .passthrough()
          .parse(
            await f.call('ixo_memory_personal_search', { query: 'goals' }),
          );
        const oracle = z
          .object({ evidence: z.array(z.unknown()) })
          .passthrough()
          .parse(await f.call('ixo_memory_oracle_search', { query: 'goals' }));
        expect(personal.evidence.length).toBe(oracle.evidence.length);
        expect(() =>
          assertParity({ ...personal, evidence: oracle.evidence }, personal),
        ).toThrow();
      } finally {
        await f.close();
      }
    });
    it('enumerates only current descriptors and terminates without a cursor', async () => {
      const f = await setup(client);
      try {
        expect(await f.list()).toEqual(catalog.map((tool) => tool.name));
        const listings = f.messages.filter(
          (message) => message.method === 'tools/list',
        );
        expect(listings).toHaveLength(client === 'native-plugin' ? 0 : 1);
        expect(listings.map((message) => message.version)).toEqual(
          client === 'native-plugin' ? [] : [f.protocol()],
        );
      } finally {
        await f.close();
      }
    });
    it('cancels the pending client call and discards its late result', async () => {
      let enter: () => void = () => undefined;
      let release: () => void = () => undefined;
      const entered = new Promise<void>((done) => {
        enter = done;
      });
      const held = new Promise<void>((done) => {
        release = done;
      });
      const f = await setup(client, {
        onFetch: async (url) => {
          if (url.includes('/api/v1/subscriptions?')) {
            enter();
            await held;
          }
          return undefined;
        },
      });
      const controller = new AbortController();
      try {
        const result = f.call('ixo_credits_get', {}, controller.signal);
        await entered;
        controller.abort();
        await expect(result).rejects.toThrow(/abort|cancel/i);
        release();
        await expect(result).rejects.toThrow();
        expect(await f.call('ixo_account_get', {})).toMatchObject({
          status: 'available',
        });
      } finally {
        release();
        await f.close();
      }
    }, 2_000);
    it('reconnects without a transport session and rechecks the current grant', async () => {
      const f = await setup(client);
      try {
        const before = await f.call('ixo_account_get', {});
        await f.reconnect();
        expect(await f.call('ixo_account_get', {})).toEqual(before);
        f.revoke();
        expect(await f.call('ixo_account_get', {})).toMatchObject({
          status: 'unauthorized',
        });
      } finally {
        await f.close();
      }
    });
    it('preserves explicit partial file coverage without accepting invented page controls', async () => {
      const f = await setup(client);
      try {
        expect(
          await f.call('ixo_files_find', argsByName.ixo_files_find),
        ).toEqual(
          await f.binding.tools.invoke(
            'ixo_files_find',
            argsByName.ixo_files_find,
          ),
        );
        const bad = {
          ...argsByName.ixo_files_find,
          cursor: 'another-client-page',
        };
        expect(await settle(f.call('ixo_files_find', bad))).toMatchObject(
          invalidOutcome(client),
        );
      } finally {
        await f.close();
      }
    });
    it('keeps personal and oracle memory receipts distinct', async () => {
      const f = await setup(client);
      try {
        expect(
          await f.call('ixo_memory_personal_search', { query: 'goals' }),
        ).toMatchObject({
          status: 'available',
          evidence: [expect.objectContaining({ source: 'personal_memory' })],
        });
        expect(
          await f.call('ixo_memory_oracle_search', { query: 'goals' }),
        ).toMatchObject({
          status: 'available',
          evidence: [expect.objectContaining({ source: 'oracle_knowledge' })],
        });
      } finally {
        await f.close();
      }
    });
    it('preserves confirmed zero and source outage as distinct results', async () => {
      const f = await setup(client);
      try {
        f.setCreditsBaseUnits('0');
        expect(await f.call('ixo_credits_get', {})).toMatchObject({
          status: 'available',
          value: { amount: '0', denomination: 'upay', decimals: 3 },
        });
        f.failPath('/api/v1/subscriptions?');
        expect(await f.call('ixo_credits_get', {})).toEqual(
          await f.binding.tools.invoke('ixo_credits_get', {}),
        );
        expect(
          JSON.stringify(await f.call('ixo_credits_get', {})),
        ).not.toContain('"amount"');
      } finally {
        await f.close();
      }
    });
    it('refuses a cached descriptor after native authority is withdrawn', async () => {
      const f = await setup(client);
      try {
        await f.list();
        f.revoke();
        expect(await f.call('ixo_credits_get', {})).toEqual(
          await f.binding.tools.invoke('ixo_credits_get', {}),
        );
        expect(f.requests).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('does not expose private tools to a shared audience', async () => {
      const f = await setup(client, {
        context: { ...facts, visibility: 'shared' },
      });
      try {
        expect(await f.list()).not.toContain('ixo_account_get');
        expect(await f.call('ixo_account_get', {})).toMatchObject({
          status: 'unauthorized',
        });
        expect(f.requests).toEqual([]);
        expect(
          await f.call('ixo_concept_get', { concept: 'Topic' }),
        ).toMatchObject({ status: 'available' });
      } finally {
        await f.close();
      }
    });
    it('rejects owner and network overrides before source access', async () => {
      const f = await setup(client);
      try {
        expect(
          await settle(
            f.call('ixo_account_get', {
              userDid: 'did:ixo:bob',
              network: 'mainnet',
            }),
          ),
        ).toMatchObject(invalidOutcome(client));
        expect(f.requests).toEqual([]);
      } finally {
        await f.close();
      }
    });
  });
}
