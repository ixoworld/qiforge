import { DynamicStructuredTool } from '@langchain/core/tools';
import { MCPAdapter, MCPClientError } from '@langchain/mcp-adapters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NOOP_LOGGER } from '../core/utils';
import type { Logger } from '../plugin-api/types';
import { McpCallTimeoutError, withCallTimeout } from './mcp-call-timeout';
import {
  adaptMcpClientTools,
  mcpAdapterConfig,
  mcpToolZodSchema,
  withoutUnconvertibleKeywords,
  type AdaptedMcpTool,
} from './mcp-tool-adapter';
import { serveTestMcp } from './mcp-test-server';

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    warn: (msg: string) => {
      warnings.push(msg);
    },
  };
}

describe('mcpToolZodSchema', () => {
  it('converts a JSON Schema so required fields and enums are enforced', () => {
    const schema = mcpToolZodSchema(
      {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['a', 'b'] } },
        required: ['mode'],
      },
      't',
    );
    expect(schema.safeParse({ mode: 'a' }).success).toBe(true);
    expect(schema.safeParse({ mode: 'c' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('passes a Zod schema through as the same object', () => {
    const zod = z.object({ x: z.number() });
    expect(mcpToolZodSchema(zod, 't')).toBe(zod);
  });

  it('falls back to a permissive record, loudly, when the JSON Schema cannot be converted', () => {
    const logger = recordingLogger();
    const schema = mcpToolZodSchema({ type: 'no-such-type' }, 'broken', logger);
    expect(schema.safeParse({ anything: 1 }).success).toBe(true);
    expect(logger.warnings.join('\n')).toContain('"broken"');
  });

  // `z.fromJSONSchema` throws on these keywords, at any depth; the model must
  // still see the tool's properties.
  it.each([
    ['not', { not: { required: ['other'] } }],
    ['unevaluatedProperties', { unevaluatedProperties: false }],
    [
      'if/then/else',
      {
        if: { properties: { mode: { const: 'a' } } },
        then: { required: ['note'] },
        else: { properties: { limit: { type: 'number' } } },
      },
    ],
  ])('keeps the properties of a schema using `%s`', (_keyword, extra) => {
    const logger = recordingLogger();
    const properties = {
      mode: { type: 'string', enum: ['a', 'b'] },
      note: { type: 'string' },
      nested: {
        type: 'object',
        properties: { x: { type: 'string' } },
        ...extra,
      },
      list: { type: 'array', items: { type: 'object', ...extra } },
    };
    const schema = mcpToolZodSchema(
      { type: 'object', properties, required: ['mode'], ...extra },
      't',
      logger,
    );
    expect(logger.warnings).toEqual([]);
    const shown = z.toJSONSchema(schema);
    expect(Object.keys(shown.properties ?? {})).toEqual(
      expect.arrayContaining(Object.keys(properties)),
    );
    expect(shown.required).toEqual(['mode']);
    expect(schema.safeParse({ mode: 'c' }).success).toBe(false);
    expect(schema.safeParse({ mode: 'a' }).success).toBe(true);
  });

  it("adds a then/else branch's properties as optional ones, the schema's own first", () => {
    const schema = mcpToolZodSchema(
      {
        type: 'object',
        properties: { mode: { type: 'string' } },
        if: { properties: { mode: { const: 'a' } } },
        then: {
          properties: { mode: { const: 'a' }, note: { type: 'string' } },
          required: ['note'],
        },
        else: { properties: { limit: { type: 'number' } } },
      },
      't',
    );
    const shown = z.toJSONSchema(schema);
    expect(shown.properties).toEqual({
      mode: { type: 'string' },
      note: { type: 'string' },
      limit: { type: 'number' },
    });
    expect(shown.required).toBeUndefined();
  });

  it('keeps a property named like a dropped keyword', () => {
    expect(
      withoutUnconvertibleKeywords({
        type: 'object',
        properties: { not: { type: 'string' }, if: { type: 'boolean' } },
        not: { required: ['if'] },
      }),
    ).toEqual({
      type: 'object',
      properties: { not: { type: 'string' }, if: { type: 'boolean' } },
    });
  });

  it.each([undefined, 'string', 42, null, ['array']])(
    'falls back to a permissive record for a non-object schema %j',
    (raw) => {
      const logger = recordingLogger();
      const schema = mcpToolZodSchema(raw, 't', logger);
      expect(schema.safeParse({ a: 'b' }).success).toBe(true);
      expect(logger.warnings).toHaveLength(1);
    },
  );
});

describe('adaptMcpClientTools', () => {
  it('keeps name and description verbatim and forwards invoke unchanged', async () => {
    const seen: unknown[] = [];
    const [adapted] = adaptMcpClientTools([
      {
        name: 'Upstream_Tool',
        description: '  exact upstream text  ',
        schema: { type: 'object', properties: {} },
        invoke: async (input) => {
          seen.push(input);
          return { big: 'x'.repeat(1_000_000) };
        },
      },
    ]);
    expect(adapted?.name).toBe('Upstream_Tool');
    expect(adapted?.description).toBe('  exact upstream text  ');
    // Results pass through untouched; size is bounded by the runtime's
    // result-cap middleware, not by the adapter.
    const out = await adapted?.invoke({ q: 1 });
    expect(seen).toEqual([{ q: 1 }]);
    expect(out).toEqual({ big: 'x'.repeat(1_000_000) });
  });

  it('propagates an upstream invoke rejection', async () => {
    const [adapted] = adaptMcpClientTools([
      {
        name: 't',
        description: '',
        invoke: async () => {
          throw new Error('upstream 500');
        },
      },
    ]);
    await expect(adapted?.invoke({})).rejects.toThrow('upstream 500');
  });
});

/**
 * A tool built the way `@langchain/mcp-adapters` builds one: its `func`
 * receives the call's config, from which the adapter takes
 * `metadata.timeoutMs` as the MCP request's timeout.
 */
function configRecordingTool(
  seen: Array<{ timeoutMs: unknown; signal: AbortSignal | undefined }>,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'slow_tool',
    description: '',
    schema: z.object({}),
    func: async (_args, _runManager, config) => {
      seen.push({
        timeoutMs: config?.metadata?.timeoutMs,
        signal: config?.signal,
      });
      return 'ok';
    },
  });
}

describe('adaptMcpClientTools request timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the request timeout to the MCP call without arming a timer of its own', async () => {
    vi.useFakeTimers();
    const seen: Array<{ timeoutMs: unknown; signal: AbortSignal | undefined }> =
      [];
    const [adapted] = adaptMcpClientTools(
      [configRecordingTool(seen)],
      NOOP_LOGGER,
      { requestTimeoutMs: 180_000 },
    );

    expect(await adapted?.invoke({})).toBe('ok');
    // No `signal`: a numeric `timeout` would become `AbortSignal.timeout`,
    // whose timer is never cleared.
    expect(seen).toEqual([{ timeoutMs: 180_000, signal: undefined }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes no timeout when none is configured', async () => {
    const seen: Array<{ timeoutMs: unknown; signal: AbortSignal | undefined }> =
      [];
    const [adapted] = adaptMcpClientTools([configRecordingTool(seen)]);
    await adapted?.invoke({});
    expect(seen).toEqual([{ timeoutMs: undefined, signal: undefined }]);
  });
});

describe('withCallTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result and clears its timer', async () => {
    vi.useFakeTimers();
    expect(await withCallTimeout(async () => 7, 1000, 'x')).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the call rejects', async () => {
    vi.useFakeTimers();
    await expect(
      withCallTimeout(
        async () => {
          throw new Error('nope');
        },
        1000,
        'x',
      ),
    ).rejects.toThrow('nope');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with McpCallTimeoutError and runs onTimeout when the call hangs', async () => {
    vi.useFakeTimers();
    let torn = 0;
    const settled = withCallTimeout(
      () => new Promise<never>(() => undefined),
      5000,
      'memory search',
      () => {
        torn += 1;
      },
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await settled;
    expect(err).toBeInstanceOf(McpCallTimeoutError);
    expect(String(err)).toContain('memory search did not complete within 5 s');
    expect(torn).toBe(1);
  });

  it('still rejects with the timeout when onTimeout itself throws', async () => {
    vi.useFakeTimers();
    const settled = withCallTimeout(
      () => new Promise<never>(() => undefined),
      100,
      'x',
      async () => {
        throw new Error('close failed');
      },
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await settled).toBeInstanceOf(McpCallTimeoutError);
  });
});

/**
 * A real `MCPAdapter` connected over Streamable HTTP to an MCP server with
 * one tool whose handler answers after `delayMs`.
 */
async function connectSlowServer(delayMs: number) {
  const url = 'https://slow.example/mcp';
  const server = await serveTestMcp(url, [
    {
      definition: {
        name: 'slow',
        description: 'answers late',
        inputSchema: { type: 'object', properties: {} },
      },
      call: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { content: [{ type: 'text', text: 'done' }] };
      },
    },
  ]);
  vi.stubGlobal('fetch', server.fetch);
  const adapter = new MCPAdapter(
    mcpAdapterConfig('slow-server', { url, toolNames: 'bare' }),
  );
  const tools = await adapter.listTools();
  return {
    tools,
    close: async () => {
      await adapter.close();
      await server.close();
      vi.unstubAllGlobals();
    },
  };
}

/**
 * Invoke the adapted tool, check it is still pending 1 s before `ms` of fake
 * time, then advance to `ms`; resolves to the outcome.
 */
async function invokeAfter(
  tool: AdaptedMcpTool | undefined,
  ms: number,
): Promise<{ value: unknown } | { error: unknown }> {
  if (!tool) throw new Error('tool missing');
  let done = false;
  const settled = tool.invoke({}).then(
    (value: unknown) => ({ value }),
    (error: unknown) => ({ error }),
  );
  void settled.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(ms - 1_000);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  return settled;
}

describe('MCP request timeout over a real client and server', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 90 s call succeeds when the 180 s request timeout is passed', async () => {
    const mcp = await connectSlowServer(90_000);
    vi.useFakeTimers();
    const [slow] = adaptMcpClientTools(mcp.tools, NOOP_LOGGER, {
      requestTimeoutMs: 180_000,
    });

    expect(await invokeAfter(slow, 90_000)).toEqual({ value: 'done' });
    vi.useRealTimers();
    await mcp.close();
  });

  it('the same call is cut at the MCP SDK default of 60 s when no timeout is passed', async () => {
    const mcp = await connectSlowServer(90_000);
    vi.useFakeTimers();
    const [slow] = adaptMcpClientTools(mcp.tools, NOOP_LOGGER);

    const outcome = await invokeAfter(slow, 60_000);
    expect(outcome).toHaveProperty('error');
    expect(String('error' in outcome ? outcome.error : '')).toMatch(
      /timed out/i,
    );
    vi.useRealTimers();
    await mcp.close();
  });

  it('a call slower than the configured timeout fails at that timeout', async () => {
    const mcp = await connectSlowServer(90_000);
    vi.useFakeTimers();
    const [slow] = adaptMcpClientTools(mcp.tools, NOOP_LOGGER, {
      requestTimeoutMs: 30_000,
    });

    const outcome = await invokeAfter(slow, 30_000);
    expect(outcome).toHaveProperty('error');
    expect(String('error' in outcome ? outcome.error : '')).toMatch(
      /timed out/i,
    );
    vi.useRealTimers();
    await mcp.close();
  });
});

describe('a Streamable HTTP server that refuses the token at connect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails after one request, with no SSE retries, keeping the 401 as the cause', async () => {
    const url = 'https://refusing.example/mcp';
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response('invalid_token', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
        });
      },
    );
    const adapter = new MCPAdapter(
      mcpAdapterConfig('asks', {
        url,
        headers: { authorization: 'Bearer ended' },
        toolNames: 'prefixed',
      }),
    );
    try {
      const error = await adapter.listTools().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(MCPClientError.isInstance(error)).toBe(true);
      expect(String(error)).toContain(
        'Authentication failed for HTTP server "asks"',
      );
      expect(error).toHaveProperty('cause.status', 401);
      expect(requests).toEqual(['POST /mcp']);
    } finally {
      await adapter.close();
    }
  });
});
