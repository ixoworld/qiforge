import {
  createUCANValidator,
  defineCapability,
  generateKeypair,
} from '@ixo/ucan';
import { describe, expect, it } from 'vitest';
import { WorkersUcanService } from '../do/ucan-service';
import { createImportTransport, readRpcResponse } from './transport';
import {
  signedFixture,
  ORACLE_MNEMONIC,
  ORACLE_DID,
  USER_DID,
} from './fixtures/signed';

describe('dedicated memory MCP transport', () => {
  async function transport(
    mode:
      | 'queued'
      | 'refused'
      | 'server-error'
      | 'disconnect'
      | 'malformed'
      | 'sse'
      | 'redirect'
      | 'throttled'
      | 'expired-grant',
  ) {
    const signed = await signedFixture();
    const memoryDid = (await generateKeypair()).did;
    const validator = await createUCANValidator({
      serverDid: memoryDid,
      rootIssuers: ['*'],
      didResolver: signed.config.didResolver,
      requireExpiration: true,
      invocationStore: {
        has: async () => false,
        add: async () => undefined,
        addIfAbsent: async () => true,
      },
    });
    let effects = 0;
    const seen: unknown[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      expect(init?.redirect).toBe('manual');
      if (String(url) === 'https://memory.test/.well-known/did.json')
        return Response.json({ id: memoryDid });
      expect(String(url)).toBe('https://memory.test/mcp');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-room-id')).toBe('!server-derived:matrix.test');
      const token = headers.get('authorization')?.slice('Bearer '.length);
      if (!token) throw new Error('Missing downstream invocation');
      const verdict = await validator.validate(
        token,
        defineCapability({ can: 'memory/*', protocol: 'ixo:' }),
        'ixo:memory',
      );
      expect(verdict.error).toBeUndefined();
      expect(verdict.ok).toBe(true);
      expect(verdict.invoker).toBe(ORACLE_DID);
      expect(verdict.proofChain).toEqual([USER_DID, ORACLE_DID]);
      expect(verdict.expiration).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000) + 60,
      );
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === 'initialize')
        return Response.json(
          {
            jsonrpc: '2.0',
            id: rpc.id,
            result: { protocolVersion: '2025-03-26' },
          },
          { headers: { 'mcp-session-id': 'session-1' } },
        );
      expect(headers.get('mcp-session-id')).toBe('session-1');
      if (rpc.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      expect(rpc.method).toBe('tools/call');
      effects++;
      seen.push(rpc.params);
      if (mode === 'disconnect')
        throw new Error('Connection dropped after enqueue');
      if (mode === 'server-error')
        return new Response('bad gateway', { status: 502 });
      if (mode === 'throttled')
        return new Response('slow down', { status: 429 });
      if (mode === 'redirect')
        return new Response(null, {
          status: 307,
          headers: { location: 'https://attacker.test' },
        });
      if (mode === 'malformed')
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: 'stored' }] },
        });
      const response = {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                mode === 'refused'
                  ? { success: false }
                  : { success: true, queue_position: 4 },
              ),
            },
          ],
        },
      };
      if (mode === 'sse')
        return new Response(
          `event: message\ndata: ${JSON.stringify(response)}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return Response.json(response);
    };
    const ucan = new WorkersUcanService({
      oracleDid: ORACLE_DID,
      signingMnemonic: ORACLE_MNEMONIC,
    });
    let mints = 0;
    const client = await createImportTransport({
      url: 'https://memory.test/mcp',
      userRoom: '!server-derived:matrix.test',
      delegation: signed.grant,
      ucan: {
        // The handshake mints twice; afterwards the grant has "expired".
        createInvocationFromDelegation: async (...args) =>
          mode === 'expired-grant' && ++mints > 2
            ? { error: 'Delegation expired' }
            : ucan.createInvocationFromDelegation(...args),
      },
      fetcher,
    });
    const chunk = signed.body.chunks[0];
    if (!chunk) throw new Error('No fixture chunk');
    return {
      outcome: await client.add(chunk, 'private'),
      effects,
      seen,
      chunk,
    };
  }
  it.each(['queued', 'sse'] satisfies ('queued' | 'sse')[])(
    'verifies the real minted proof and records only observed queue acceptance (%s)',
    async (mode) => {
      const result = await transport(mode);
      expect(result.outcome).toEqual({
        id: result.chunk.id,
        state: 'queued',
        queuePosition: 4,
      });
      expect(result.effects).toBe(1);
      expect(result.seen).toEqual([
        {
          name: 'add_oracle_knowledge',
          arguments: {
            name: result.chunk.sourceName,
            content: result.chunk.content,
            source: 'text',
            source_description: `${result.chunk.locator}; source sha256:${result.chunk.sourceSha256}; content sha256:${result.chunk.contentSha256}`,
            knowledge_space_type: 'private',
            confirmed_insertion_from_user: true,
          },
        },
      ]);
    },
  );
  it.each(['server-error', 'disconnect', 'malformed', 'redirect'] satisfies (
    | 'server-error'
    | 'disconnect'
    | 'malformed'
    | 'redirect'
  )[])('does not replay after %s', async (mode) => {
    const result = await transport(mode);
    expect(result.effects).toBe(1);
    expect(result.outcome.state).toBe('unknown');
  });
  it('records explicit upstream refusal', async () => {
    expect((await transport('refused')).outcome.state).toBe('rejected');
  });
  it('records an upstream 429 as a refusal', async () => {
    const result = await transport('throttled');
    expect(result.effects).toBe(1);
    expect(result.outcome).toEqual({
      id: result.chunk.id,
      state: 'rejected',
      code: 'upstream_http_429',
    });
  });
  it('records a chunk it could not mint for as not submitted', async () => {
    const result = await transport('expired-grant');
    expect(result.effects).toBe(0);
    expect(result.outcome).toEqual({
      id: result.chunk.id,
      state: 'not_submitted',
      code: 'memory_invocation_unavailable',
    });
  });
  it('cancels an SSE stream once the matching response arrives', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"jsonrpc":"2.0","id":3,"result":{}}\n\n',
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(
      (
        await readRpcResponse(
          new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          }),
          3,
        )
      ).id,
    ).toBe(3);
    expect(cancelled).toBe(true);
  });
});
