/* eslint-disable no-console */
// Reproduction object: does an MCP round trip leave a Durable Object resident?
// Deploy with the wrangler.jsonc next to this file; see docs/testing.md.
import { DurableObject } from 'cloudflare:workers';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const FIRECRAWL = 'https://mcp-firecrawl.ixo.earth/v2/mcp';

export class HibProbe extends DurableObject {
  private readonly instanceId = crypto.randomUUID();
  private readonly bootedAt = Date.now();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp-sdk') {
      const client = new MultiServerMCPClient({
        useStandardContentBlocks: true,
        prefixToolNameWithServerName: true,
        mcpServers: {
          firecrawl: { type: 'http', transport: 'http', url: FIRECRAWL },
        },
      });
      let names: string[] = [];
      try {
        names = (await client.getTools()).map((t) => t.name);
      } finally {
        await client.close().catch(() => undefined);
      }
      return Response.json({
        ok: true,
        tools: names.length,
        instanceId: this.instanceId,
      });
    }
    if (url.pathname === '/mcp-call') {
      const client = new MultiServerMCPClient({
        useStandardContentBlocks: true,
        prefixToolNameWithServerName: true,
        mcpServers: {
          firecrawl: { type: 'http', transport: 'http', url: FIRECRAWL },
        },
      });
      let head = '';
      try {
        const tools = await client.getTools();
        const scrape = tools.find(
          (t) => t.name === 'firecrawl__firecrawl_scrape',
        );
        if (!scrape) throw new Error('no scrape tool');
        const out = await scrape.invoke({
          url: 'https://example.com',
          formats: ['markdown'],
          onlyMainContent: true,
        });
        head = JSON.stringify(out).slice(0, 80);
      } finally {
        await client.close().catch(() => undefined);
      }
      return Response.json({ ok: true, head, instanceId: this.instanceId });
    }
    if (url.pathname === '/mcp-rawcall') {
      const post = async (body: unknown, sessionId?: string) => {
        const res = await fetch(FIRECRAWL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          },
          body: JSON.stringify(body),
        });
        const sid = res.headers.get('mcp-session-id') ?? sessionId;
        const text = await res.text();
        return { status: res.status, sid, len: text.length };
      };
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'probe', version: '0' },
        },
      });
      await post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        init.sid,
      );
      const call = await post(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'firecrawl_scrape',
            arguments: {
              url: 'https://example.com',
              formats: ['markdown'],
              onlyMainContent: true,
            },
          },
        },
        init.sid,
      );
      if (init.sid)
        await fetch(FIRECRAWL, {
          method: 'DELETE',
          headers: { 'mcp-session-id': init.sid },
        }).catch(() => undefined);
      return Response.json({
        ok: true,
        call: call.status,
        len: call.len,
        instanceId: this.instanceId,
      });
    }
    if (url.pathname === '/mcp-call2') {
      // The oracle's memory/sandbox client shape: reconnect + tool timeout + auth header.
      const client = new MultiServerMCPClient({
        useStandardContentBlocks: true,
        prefixToolNameWithServerName: true,
        defaultToolTimeout: 120_000,
        mcpServers: {
          firecrawl: {
            type: 'http',
            transport: 'http',
            url: FIRECRAWL,
            headers: { authorization: 'Bearer probe', 'x-auth-type': 'ucan' },
            reconnect: { enabled: true, maxAttempts: 3, delayMs: 2000 },
          },
        },
      });
      let head = '';
      try {
        const tools = await client.getTools();
        const scrape = tools.find(
          (t) => t.name === 'firecrawl__firecrawl_scrape',
        );
        if (!scrape) throw new Error('no scrape tool');
        const out = await scrape.invoke({
          url: 'https://example.com',
          formats: ['markdown'],
          onlyMainContent: true,
        });
        head = JSON.stringify(out).slice(0, 60);
      } finally {
        await client.close().catch(() => undefined);
      }
      return Response.json({ ok: true, head, instanceId: this.instanceId });
    }
    if (url.pathname.startsWith('/mcp-opt/')) {
      const variant = url.pathname.split('/')[2] ?? '';
      const server: Record<string, unknown> = {
        type: 'http',
        transport: 'http',
        url: FIRECRAWL,
      };
      const top: Record<string, unknown> = {
        useStandardContentBlocks: true,
        prefixToolNameWithServerName: true,
      };
      if (variant === 'reconnect')
        server.reconnect = { enabled: true, maxAttempts: 3, delayMs: 2000 };
      if (variant === 'timeout') top.defaultToolTimeout = 120_000;
      if (variant === 'headers')
        server.headers = {
          authorization: 'Bearer probe',
          'x-auth-type': 'ucan',
        };
      if (variant === 'own') {
        // No SDK timeout: our own race with a timer we always clear.
        const client2 = new MultiServerMCPClient({
          ...top,
          mcpServers: { firecrawl: server },
        } as ConstructorParameters<typeof MultiServerMCPClient>[0]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const tools = await client2.getTools();
          const scrape = tools.find(
            (t) => t.name === 'firecrawl__firecrawl_scrape',
          );
          if (!scrape) throw new Error('no scrape tool');
          const call = scrape.invoke({
            url: 'https://example.com',
            formats: ['markdown'],
            onlyMainContent: true,
          });
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 120_000);
          });
          const out = await Promise.race([call, timeout]);
          return Response.json({
            ok: true,
            variant,
            head: JSON.stringify(out).slice(0, 40),
            instanceId: this.instanceId,
          });
        } finally {
          if (timer) clearTimeout(timer);
          await client2.close().catch(() => undefined);
        }
      }
      const client = new MultiServerMCPClient({
        ...top,
        mcpServers: { firecrawl: server },
      } as ConstructorParameters<typeof MultiServerMCPClient>[0]);
      let head = '';
      try {
        const tools = await client.getTools();
        const scrape = tools.find(
          (t) => t.name === 'firecrawl__firecrawl_scrape',
        );
        if (!scrape) throw new Error('no scrape tool');
        const out = await scrape.invoke({
          url: 'https://example.com',
          formats: ['markdown'],
          onlyMainContent: true,
        });
        head = JSON.stringify(out).slice(0, 40);
      } finally {
        await client.close().catch(() => undefined);
      }
      return Response.json({
        ok: true,
        variant,
        head,
        instanceId: this.instanceId,
      });
    }
    if (url.pathname === '/mcp-raw') {
      const post = async (body: unknown, sessionId?: string) => {
        const res = await fetch(FIRECRAWL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          },
          body: JSON.stringify(body),
        });
        const sid = res.headers.get('mcp-session-id') ?? sessionId;
        const text = await res.text(); // consume (and thereby close) the body
        return {
          status: res.status,
          sid,
          head: text.slice(0, 120),
          ctype: res.headers.get('content-type'),
        };
      };
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'probe', version: '0' },
        },
      });
      await post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        init.sid,
      );
      const list = await post(
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        init.sid,
      );
      if (init.sid)
        await fetch(FIRECRAWL, {
          method: 'DELETE',
          headers: { 'mcp-session-id': init.sid },
        }).catch(() => undefined);
      return Response.json({
        ok: true,
        init: init.status,
        initCtype: init.ctype,
        list: list.status,
        listHead: list.head,
        instanceId: this.instanceId,
      });
    }
    return Response.json({
      instanceId: this.instanceId,
      uptimeMs: Date.now() - this.bootedAt,
    });
  }
}
export default {
  async fetch(
    request: Request,
    env: { PROBE: DurableObjectNamespace<HibProbe> },
  ): Promise<Response> {
    return env.PROBE.get(env.PROBE.idFromName('one')).fetch(request);
  },
};
