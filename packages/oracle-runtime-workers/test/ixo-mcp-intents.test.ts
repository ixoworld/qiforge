import { catalog } from '@ixo/agent-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleIxoMcp, parseIxoMcpConfig } from '../src/ixo-tools/mcp';
import { argsByName, facts, loopFixture } from './ixo-tools-fixtures';

const config = parseIxoMcpConfig({
  resource: 'https://companion.test/v1/mcp',
  issuer: 'https://auth.test',
  resourceClientId: 'resource-client',
  clients: [
    { clientId: 'client-a', disclosure: 'private', timezone: facts.timezone },
  ],
});
const call = (name: string, args: unknown) =>
  new Request(config.resource, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ingress-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(options: Parameters<typeof loopFixture>[0] = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T14:00:00.000Z'));
  const fixture = loopFixture(options);
  let active = true;
  const now = Math.floor(Date.now() / 1000);
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://auth.test/oauth/introspect');
      expect(request.headers.get('authorization')).toMatch(/^Basic /);
      return Response.json(
        active
          ? {
              active: true,
              iss: config.issuer,
              sub: fixture.context.userDid,
              aud: config.resource,
              client_id: 'client-a',
              gid: 'grant-a',
              gver: 'generation-a',
              scope: 'ixo:tools:read',
              iat: now - 1,
              exp: now + 300,
              jti: 'access-a',
              token_type: 'Bearer',
            }
          : { active: false },
      );
    },
  );
  return {
    ...fixture,
    revokeOAuth: () => {
      active = false;
    },
    run: (request: Request) =>
      handleIxoMcp(request, {
        config,
        secret: 'resource-secret',
        surfaceFor: async () => fixture.binding.tools,
      }),
  };
}

describe('IXO user intents through MCP and the shared source handlers', () => {
  it.each(catalog.map(({ name }) => name))(
    'preserves the native result for %s',
    async (name) => {
      const fixture = setup();
      const native = await fixture.binding.tools.invoke(name, argsByName[name]);
      const response = await fixture.run(call(name, argsByName[name]));
      expect(response.status).toBe(200);
      const body = await response.json<{
        result: {
          structuredContent: Record<string, unknown>;
          isError: boolean;
        };
      }>();
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent.status).toBe('available');
      expect(native.status).toBe('available');
      if (native.status !== 'available')
        throw new Error('Native fixture unexpectedly refused');
      expect(body.result.structuredContent.value).toEqual(native.value);
      expect(JSON.stringify(body)).not.toContain('ingress-token');
      expect(
        fixture.requests.some((url) =>
          /execute|settle|withdraw|transfer/.test(url),
        ),
      ).toBe(false);
    },
  );

  it('distinguishes confirmed zero credits from a failed credit source', async () => {
    const fixture = setup();
    fixture.setCreditsBaseUnits('0');
    const zero = await fixture.run(call('ixo_credits_get', {}));
    expect(await zero.json()).toMatchObject({
      result: {
        structuredContent: {
          status: 'available',
          value: { amount: '0', denomination: 'upay', decimals: 3 },
        },
      },
    });
    fixture.failPath('/api/v1/subscriptions?');
    const failed = await fixture.run(call('ixo_credits_get', {}));
    const body = await failed.json();
    expect(body).toMatchObject({
      result: { structuredContent: { status: 'unavailable' }, isError: true },
    });
    expect(JSON.stringify(body)).not.toContain('"amount"');
  });

  it('keeps shared personal reads unavailable while canonical concepts and supplied errors remain usable', async () => {
    const fixture = setup({ context: { ...facts, visibility: 'shared' } });
    for (const name of [
      'ixo_account_get',
      'ixo_credits_get',
      'ixo_memory_personal_search',
    ]) {
      const result = await fixture.run(
        call(
          name,
          name === 'ixo_memory_personal_search' ? { query: 'my goals' } : {},
        ),
      );
      expect(JSON.stringify(await result.json())).toContain('unauthorized');
    }
    const concept = await fixture.run(
      call('ixo_concept_get', { concept: 'Topic' }),
    );
    expect(await concept.json()).toMatchObject({
      result: { structuredContent: { status: 'available' } },
    });
    const supplied = await fixture.run(
      call('ixo_error_explain', { errorText: 'Network request failed' }),
    );
    expect(await supplied.json()).toMatchObject({
      result: { structuredContent: { status: 'available' } },
    });
  });

  it('rechecks OAuth and native consent after discovery instead of treating listing as permission', async () => {
    const fixture = setup();
    expect((await fixture.binding.tools.discover()).status).toBe('available');
    fixture.revoke();
    const nativeDenied = await fixture.run(call('ixo_credits_get', {}));
    expect(JSON.stringify(await nativeDenied.json())).toContain('unauthorized');
    expect(fixture.requests).toEqual([]);
    fixture.revokeOAuth();
    expect((await fixture.run(call('ixo_credits_get', {}))).status).toBe(401);
    expect(fixture.requests).toEqual([]);
  });

  it('rejects caller-supplied authority and preserves distinct memory provenance', async () => {
    const fixture = setup();
    const injected = await fixture.run(
      call('ixo_account_get', {
        userDid: 'did:ixo:bob',
        network: 'mainnet',
        origin: 'https://other.test',
      }),
    );
    expect(await injected.json()).toMatchObject({
      result: {
        structuredContent: { status: 'invalid_request' },
        isError: true,
      },
    });
    expect(fixture.requests).toEqual([]);
    for (const entry of [
      {
        name: 'ixo_memory_personal_search',
        source: 'personal_memory',
        value: { facts: [] },
      },
      {
        name: 'ixo_memory_oracle_search',
        source: 'oracle_knowledge',
        value: { knowledge: [], visibility: 'public' },
      },
    ]) {
      const result = await fixture.run(call(entry.name, { query: 'my goals' }));
      expect(await result.json()).toMatchObject({
        result: {
          structuredContent: {
            status: 'available',
            value: entry.value,
            evidence: [
              expect.objectContaining({
                source: entry.source,
                network: 'devnet',
              }),
            ],
          },
        },
      });
    }
  });
});
