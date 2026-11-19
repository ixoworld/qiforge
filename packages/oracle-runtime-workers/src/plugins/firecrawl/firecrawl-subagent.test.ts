import { type BaseMessage, ToolMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoopAmbient } from '../../core/runtime-context';
import { createSubagentAsTool } from '../../core/subagent-as-tool';
import { makeRunConfig } from '../../core/test-fixtures';
import { wrapPluginTool } from '../../core/wrap-plugin-tool';
import {
  serveTestMcp,
  type TestMcpServer,
  type TestMcpTool,
} from '../mcp-test-server';
import { createFirecrawlSubAgent } from './firecrawl-agent';
import {
  createDefaultFirecrawlMcpFactory,
  createFirecrawlTools,
} from './firecrawl-tools';

const URL_ = 'https://firecrawl.example/mcp';
const BLOCKED =
  'https://www.tripadvisor.com/Restaurant_Review-g294195-d21313011-Reviews-Asado_Steakhouse-Tbilisi.html';

const servers: TestMcpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers.length = 0;
  vi.unstubAllGlobals();
});

/**
 * The Firecrawl MCP server's two tools over the real MCP transport: the
 * search answers, the scrape of a bot-blocked page answers `isError` (what
 * Firecrawl returns for a site's 403), which `@langchain/mcp-adapters`
 * throws as a `ToolException` when called without a tool-call id. The
 * plugin connects once per call, and a test server holds one session, so
 * each connection gets its own server.
 */
function serveFirecrawl(): void {
  const tools: TestMcpTool[] = [
    {
      definition: {
        name: 'firecrawl_search',
        description: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
        },
      },
      call: async () => ({
        content: [
          {
            type: 'text',
            text: 'Asado Steakhouse Tbilisi: 4.5 stars. Alternatives: Barbarestan, Shavi Lomi.',
          },
        ],
      }),
    },
    {
      definition: {
        name: 'firecrawl_scrape',
        description: 'scrape',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
        },
      },
      call: async () => ({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Failed to scrape URL. Status code: 403. Error: This website is blocking automated access.',
          },
        ],
      }),
    },
  ];
  const bySession = new Map<string, TestMcpServer>();
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const session = request.headers.get('mcp-session-id');
      const known = session ? bySession.get(session) : undefined;
      if (known) return known.fetch(request);
      const fresh = await serveTestMcp(URL_, tools);
      servers.push(fresh);
      const response = await fresh.fetch(request);
      const opened = response.headers.get('mcp-session-id');
      if (opened) bySession.set(opened, fresh);
      return response;
    },
  );
}

describe('Firecrawl Agent with a page that refuses the scrape', () => {
  it('gets the failed scrape as its result and still answers from the search', async () => {
    serveFirecrawl();
    const subAgent = createFirecrawlSubAgent(
      createFirecrawlTools(createDefaultFirecrawlMcpFactory(URL_)),
    );
    const pluginTools = Array.isArray(subAgent.tools) ? subAgent.tools : [];
    const fallbackContext = makeRunConfig().context;
    const tools = pluginTools.map((t) =>
      wrapPluginTool(t, {
        ambient: createNoopAmbient(),
        state: { messages: [] },
        pluginName: 'firecrawl',
        fallbackContext,
      }),
    );
    const model = new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: 'firecrawl_search',
            args: { query: 'Asado Steakhouse Tbilisi alternatives' },
            id: 's1',
          },
        ],
        [{ name: 'firecrawl_scrape', args: { url: BLOCKED }, id: 'p1' }],
        [],
      ],
    });
    let seen: BaseMessage[] = [];
    const callFirecrawl = createSubagentAsTool(
      {
        name: subAgent.name,
        description: subAgent.description,
        ...(subAgent.failureHint ? { failureHint: subAgent.failureHint } : {}),
        systemPrompt: 'You search.',
        model,
        tools,
        userDid: 'did:ixo:user1',
        sessionId: 'session-1',
      },
      {
        onComplete: (messages) => {
          seen = messages;
        },
      },
    );

    const result = String(
      await callFirecrawl.invoke({ task: 'Read the review page and search.' }),
    );

    expect(result).not.toMatch(/^Error running/);
    expect(result).not.toContain('Web search is unavailable');
    expect(result).toContain('Barbarestan');
    const results = seen.filter((m): m is ToolMessage =>
      ToolMessage.isInstance(m),
    );
    expect(results.map((m) => [m.name, m.status])).toEqual([
      ['firecrawl_search', 'success'],
      ['firecrawl_scrape', 'error'],
    ]);
    expect(String(results[1]?.content)).toContain(
      "firecrawl_scrape failed: MCP tool 'firecrawl_scrape' on server 'firecrawl' returned an error: Failed to scrape URL. Status code: 403.",
    );
  });
});
