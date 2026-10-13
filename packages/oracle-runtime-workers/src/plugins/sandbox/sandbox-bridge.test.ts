import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import { McpCallTimeoutError } from '../mcp-call-timeout';
import {
  defaultSandboxMcpClientFactory,
  getSandboxBridge,
  hasShellUnsafeChars,
  MAX_SANDBOX_TRANSFER_BYTES,
  readSandboxFile,
  SANDBOX_MCP_TIMEOUT_MS,
  SANDBOX_NO_FILE_SENTINEL,
  SANDBOX_TOO_LARGE_SENTINEL,
  sandboxReadCommand,
} from './sandbox-bridge';
import type { SandboxMcpClientFactory, SandboxMcpTool } from './sandbox.plugin';

const upstreamCalls: unknown[][] = [];

vi.mock('@langchain/mcp-adapters', () => {
  class MultiServerMCPClient {
    async getTools() {
      return [
        {
          name: 'sandbox_run',
          description: 'run code',
          schema: { type: 'object', properties: {} },
          invoke: async (...args: unknown[]) => {
            upstreamCalls.push(args);
            return 'ok';
          },
        },
      ];
    }
    async close(): Promise<void> {}
  }
  return { MultiServerMCPClient };
});

describe('defaultSandboxMcpClientFactory', () => {
  it('gives every upstream call the sandbox timeout as its MCP request timeout', async () => {
    upstreamCalls.length = 0;
    const client = defaultSandboxMcpClientFactory({ mcpServers: {} });
    const [run] = await client.getTools();

    expect(await run?.invoke({ code: 'sleep 90' })).toBe('ok');
    // Without it the MCP SDK ends the call at its 60 s default.
    expect(upstreamCalls).toEqual([
      [
        { code: 'sleep 90' },
        { metadata: { timeoutMs: SANDBOX_MCP_TIMEOUT_MS } },
      ],
    ]);
  });
});

function makeCtx(): RuntimeContext {
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    resolveServiceDid: async () => 'did:web:sandbox.example',
    mintInvocation: async () => 'sandbox-token',
  };
  return makeRuntimeContext({}, { ambient: { ucan } });
}

function tool(
  name: string,
  invoke: (input: unknown) => Promise<unknown>,
): SandboxMcpTool {
  return { name, description: '', schema: z.object({}), invoke };
}

/** A bridge whose `sandbox_run` answers with `stdout`. */
function runReturning(stdout: string): Pick<SandboxMcpTool, 'invoke'> & {
  codes: string[];
} {
  const codes: string[] = [];
  return {
    codes,
    invoke: async (input: unknown) => {
      codes.push(z.object({ code: z.string() }).parse(input).code);
      return JSON.stringify({ success: true, exitCode: 0, output: stdout });
    },
  };
}

describe('getSandboxBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never hands the MCP client a tool timeout', async () => {
    const configs: unknown[] = [];
    const factory: SandboxMcpClientFactory = (config) => {
      configs.push(config);
      return {
        getTools: async () => [
          tool('sandbox_run', async () => ''),
          tool('sandbox_write_file', async () => ''),
        ],
        close: async () => undefined,
      };
    };
    const bridge = await getSandboxBridge(
      makeCtx(),
      'https://sandbox.example/mcp',
      factory,
    );
    expect('error' in bridge).toBe(false);
    expect(configs).toHaveLength(1);
    expect(configs[0]).not.toHaveProperty('defaultToolTimeout');
  });

  it('bounds each invocation with its own timer and closes the client on timeout', async () => {
    vi.useFakeTimers();
    let closes = 0;
    const factory: SandboxMcpClientFactory = () => ({
      getTools: async () => [
        tool('sandbox_run', () => new Promise(() => undefined)),
        tool('sandbox_write_file', async () => ''),
      ],
      close: async () => {
        closes += 1;
      },
    });
    const bridge = await getSandboxBridge(
      makeCtx(),
      'https://sandbox.example/mcp',
      factory,
    );
    if ('error' in bridge) throw new Error(bridge.error);
    const pending = bridge.run.invoke({ code: 'sleep 999' });
    const settled = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SANDBOX_MCP_TIMEOUT_MS);
    expect(await settled).toBeInstanceOf(McpCallTimeoutError);
    expect(closes).toBe(1);
  });

  it('leaves no timer behind after an invocation that completes', async () => {
    vi.useFakeTimers();
    const factory: SandboxMcpClientFactory = () => ({
      getTools: async () => [
        tool('sandbox_run', async () => 'ok'),
        tool('sandbox_write_file', async () => ''),
      ],
      close: async () => undefined,
    });
    const bridge = await getSandboxBridge(
      makeCtx(),
      'https://sandbox.example/mcp',
      factory,
    );
    if ('error' in bridge) throw new Error(bridge.error);
    expect(await bridge.run.invoke({ code: 'true' })).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readSandboxFile', () => {
  it('refuses an oversized file from the in-sandbox size check', async () => {
    const run = runReturning(`${SANDBOX_TOO_LARGE_SENTINEL}:52428800`);
    const out = await readSandboxFile(
      { run: tool('sandbox_run', run.invoke) },
      '/workspace/data/x.bin',
    );
    expect(out).toEqual({
      error: `\`/workspace/data/x.bin\` is 52428800 bytes; files moved out of the sandbox are limited to ${MAX_SANDBOX_TRANSFER_BYTES} bytes.`,
    });
  });

  it('refuses base64 output that would decode past the cap even if the sandbox skipped the check', async () => {
    const run = runReturning(
      'A'.repeat(Math.ceil(MAX_SANDBOX_TRANSFER_BYTES / 3) * 4 + 4),
    );
    const out = await readSandboxFile(
      { run: tool('sandbox_run', run.invoke) },
      '/workspace/data/x.bin',
    );
    expect(out).toHaveProperty('error');
    expect(JSON.stringify(out)).toContain('larger than the');
  });

  it('reports a missing file', async () => {
    const run = runReturning(SANDBOX_NO_FILE_SENTINEL);
    expect(
      await readSandboxFile(
        { run: tool('sandbox_run', run.invoke) },
        '/workspace/data/none',
      ),
    ).toEqual({ error: 'No file at `/workspace/data/none` in the sandbox.' });
  });

  it('decodes the base64 payload to the exact bytes', async () => {
    const run = runReturning(btoa(String.fromCharCode(0, 255, 10, 233)));
    const out = await readSandboxFile(
      { run: tool('sandbox_run', run.invoke) },
      '/workspace/data/b',
    );
    if ('error' in out) throw new Error(out.error);
    expect([...out.bytes]).toEqual([0, 255, 10, 233]);
  });

  it('never builds a command for a path that cannot be single-quoted', async () => {
    const run = runReturning('');
    const out = await readSandboxFile(
      { run: tool('sandbox_run', run.invoke) },
      "/workspace/data/x'; rm -rf /; '",
    );
    expect(out).toHaveProperty('error');
    expect(run.codes).toEqual([]);
  });
});

describe('sandbox path quoting', () => {
  it.each(["/a/it's", '/a/b\nc', '/a/b\0c'])('flags %j as unsafe', (p) => {
    expect(hasShellUnsafeChars(p)).toBe(true);
  });

  it.each(['/a/$(whoami)', '/a/`id`', '/a/b c', '/a/"q"', '/a/;rm'])(
    'keeps %j literal inside single quotes',
    (p) => {
      expect(hasShellUnsafeChars(p)).toBe(false);
      // Every occurrence of the path in the command is wrapped in one pair of
      // single quotes, where the shell expands nothing.
      const cmd = sandboxReadCommand(p);
      const quoted = `'${p}'`;
      expect(cmd.split(quoted).length - 1).toBe(3);
      expect(cmd.replaceAll(quoted, '')).not.toContain(p);
    },
  );
});
