import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type ContentBlock,
} from '@langchain/core/messages';
import { MCPAdapter } from '@langchain/mcp-adapters';
import { ChatOpenAICompletions } from '@langchain/openai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  adaptMcpClientTools,
  mcpAdapterConfig,
  type AdaptedMcpTool,
} from '../plugins/mcp-tool-adapter';
import {
  serveTestMcp,
  type TestMcpServer,
  type TestMcpTool,
} from '../plugins/mcp-test-server';

const payload = { nodes: [{ uuid: 'u1', name: 'Alice' }], total: 1 };
const text = JSON.stringify(payload);

const MCP_URL = 'https://mcp.example/mcp';

/** A 1×1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type OutputSchema = NonNullable<TestMcpTool['definition']['outputSchema']>;

/** A tool's result as a `ToolMessage`'s content, as the agent builds it. */
function toolMessageContent(value: unknown): string | ContentBlock[] {
  if (typeof value === 'string') return value;
  return z.array(z.object({ type: z.string() }).loose()).parse(value);
}

const nodesSchema: OutputSchema = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { uuid: { type: 'string' }, name: { type: 'string' } },
        required: ['uuid', 'name'],
      },
    },
    total: { type: 'integer' },
  },
  required: ['nodes', 'total'],
};

function testTool(
  name: string,
  answer: TestMcpTool['call'],
  outputSchema?: OutputSchema,
): TestMcpTool {
  return {
    definition: {
      name,
      description: `upstream ${name}`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      ...(outputSchema ? { outputSchema } : {}),
    },
    call: answer,
  };
}

const UPSTREAM_TOOLS: TestMcpTool[] = [
  testTool('text_only', async () => ({
    content: [{ type: 'text', text: 'plain' }],
  })),
  testTool(
    'text_copy',
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      _meta: { requestId: 'r1' },
    }),
    nodesSchema,
  ),
  testTool(
    'text_summary',
    async () => ({
      content: [{ type: 'text', text: 'Found 1 node' }],
      structuredContent: payload,
    }),
    nodesSchema,
  ),
  testTool(
    'structured_only',
    async () => ({ content: [], structuredContent: payload }),
    nodesSchema,
  ),
  testTool('several_blocks', async () => ({
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
    structuredContent: { result: ['a', 'b'] },
  })),
  testTool(
    'breaks_its_schema',
    async () => ({
      content: [{ type: 'text', text: '{"total":"one"}' }],
      structuredContent: { total: 'one' },
    }),
    nodesSchema,
  ),
  testTool('fails', async () => ({
    content: [{ type: 'text', text: 'no such node' }],
    isError: true,
  })),
  testTool('image', async () => ({
    content: [
      { type: 'text', text: 'Chart attached' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ],
  })),
  testTool('audio_only', async () => ({
    content: [
      { type: 'audio', data: 'UklGRgAAAABXQVZF', mimeType: 'audio/wav' },
    ],
  })),
  testTool('resource_link', async () => ({
    content: [
      { type: 'text', text: 'Report ready' },
      {
        type: 'resource_link',
        uri: 'https://files.example/report.pdf',
        name: 'report.pdf',
        mimeType: 'application/pdf',
      },
    ],
  })),
];

/**
 * Real `MCPAdapter` (legacy protocol, `@modelcontextprotocol/client` 2.x)
 * against an SDK 1.x server, inside workerd: what a plugin's call to an MCP
 * tool returns is what the model reads.
 */
describe('an MCP tool result through MCPAdapter, inside workerd', () => {
  let server: TestMcpServer;
  let adapter: MCPAdapter;
  let byName: Map<string, AdaptedMcpTool>;

  const call = (name: string): Promise<unknown> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`tool ${name} missing`);
    return tool.invoke({ q: 'alice' });
  };

  beforeAll(async () => {
    server = await serveTestMcp(MCP_URL, UPSTREAM_TOOLS);
    vi.stubGlobal('fetch', server.fetch);
    adapter = new MCPAdapter(
      mcpAdapterConfig('probe', { url: MCP_URL, toolNames: 'bare' }),
    );
    const tools = adaptMcpClientTools(await adapter.listTools());
    byName = new Map(tools.map((t) => [t.name, t]));
  });

  afterAll(async () => {
    await adapter.close();
    await server.close();
    vi.unstubAllGlobals();
  });

  it('connects with the legacy protocol, no discovery probe, and offers no elicitation', () => {
    expect(server.methods[0]).toBe('initialize');
    expect(server.methods).not.toContain('server/discover');
    expect(server.clientCapabilities()?.elicitation).toBeUndefined();
  });

  it('keeps the upstream tool names and descriptions', () => {
    expect([...byName.keys()]).toEqual(
      UPSTREAM_TOOLS.map((t) => t.definition.name),
    );
    expect(byName.get('fails')?.description).toBe('upstream fails');
  });

  it('gives a text result as its text', async () => {
    expect(await call('text_only')).toBe('plain');
  });

  it('gives a text that copies the structured value once, without `_meta`', async () => {
    expect(await call('text_copy')).toBe(JSON.stringify(payload, null, 2));
  });

  it('adds the structured value beside a text that says something else', async () => {
    expect(await call('text_summary')).toEqual([
      { type: 'text', text: 'Found 1 node' },
      { type: 'text', text },
    ]);
  });

  it('gives a result with only a structured value as its JSON', async () => {
    expect(await call('structured_only')).toBe(text);
  });

  it('leaves a result of several blocks as it is', async () => {
    expect(await call('several_blocks')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('names an image in text instead of passing its data on', async () => {
    expect(await call('image')).toEqual([
      { type: 'text', text: 'Chart attached' },
      {
        type: 'text',
        text: "[Left out: the tool's image (image/png). A tool result reaches the model as text only.]",
      },
    ]);
  });

  it('gives a result that is only audio as the text naming it', async () => {
    expect(await call('audio_only')).toBe(
      "[Left out: the tool's audio (audio/wav). A tool result reaches the model as text only.]",
    );
  });

  it('gives a resource link as text with its address', async () => {
    expect(await call('resource_link')).toEqual([
      { type: 'text', text: 'Report ready' },
      {
        type: 'text',
        text: '[Linked file "report.pdf" (application/pdf): https://files.example/report.pdf]',
      },
    ]);
  });

  // The Chat Completions API takes only text parts in a tool message, and a
  // tool message stays in the thread, so an invalid part would fail this turn
  // and every later one.
  it.each(['image', 'audio_only', 'resource_link'])(
    'a %s result reaches the provider as a valid tool message of text parts',
    async (name) => {
      const sent: unknown[] = [];
      const model = new ChatOpenAICompletions({
        model: 'test-model',
        apiKey: 'test-key',
        maxRetries: 0,
        configuration: {
          baseURL: 'https://llm.example/v1',
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)));
            return Response.json({
              id: 'c1',
              object: 'chat.completion',
              created: 0,
              model: 'test-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'seen' },
                  finish_reason: 'stop',
                },
              ],
            });
          },
        },
      });
      await model.invoke([
        new HumanMessage('run it'),
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_1', name, args: {} }],
        }),
        new ToolMessage({
          tool_call_id: 'call_1',
          content: toolMessageContent(await call(name)),
        }),
      ]);
      expect(sent).toHaveLength(1);
      const body = z
        .object({
          messages: z.array(
            z.object({ role: z.string(), content: z.unknown() }).loose(),
          ),
        })
        .parse(sent[0]);
      const toolMessage = body.messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      const content = toolMessage?.content;
      const parts = typeof content === 'string' ? [content] : content;
      expect(Array.isArray(parts)).toBe(true);
      for (const part of Array.isArray(parts) ? parts : []) {
        if (typeof part === 'string') continue;
        expect(Object.keys(part).sort()).toEqual(['text', 'type']);
        expect(part).toMatchObject({ type: 'text', text: expect.any(String) });
      }
      expect(JSON.stringify(body)).not.toContain(PNG_BASE64);
      expect(JSON.stringify(body)).not.toContain('UklGRgAAAABXQVZF');
    },
  );

  // Workers refuse code generation from strings, which the SDK's Ajv
  // validator needs; this pool allows it (vitest evaluates with it), so the
  // check is which validator answered: cfworker's errors name the instance
  // location (`#/total: ...`), Ajv's say `data/total must be ...`. Under
  // plain Node the SDK picks Ajv, so the check only applies inside workerd.
  it.skipIf(navigator.userAgent !== 'Cloudflare-Workers')(
    'validates structured output against its outputSchema with the cfworker validator',
    async () => {
      await expect(call('breaks_its_schema')).rejects.toThrow(
        /does not match the tool's output schema: .*#\/total: Instance type "string" is invalid/,
      );
    },
  );

  it('throws a server-reported failure with its text', async () => {
    await expect(call('fails')).rejects.toThrow(
      "MCP tool 'fails' on server 'probe' returned an error: no such node",
    );
  });
});

describe('MCP tool names', () => {
  it('prefix the server name with `__` for a prefixed server', async () => {
    const server = await serveTestMcp(MCP_URL, UPSTREAM_TOOLS.slice(0, 1));
    vi.stubGlobal('fetch', server.fetch);
    const adapter = new MCPAdapter(
      mcpAdapterConfig('memory-engine', {
        url: MCP_URL,
        toolNames: 'prefixed',
      }),
    );
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      expect(names).toEqual(['memory-engine__text_only']);
    } finally {
      await adapter.close();
      await server.close();
      vi.unstubAllGlobals();
    }
  });
});
