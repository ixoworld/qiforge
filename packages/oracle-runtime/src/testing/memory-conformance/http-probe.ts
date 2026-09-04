/**
 * `MemoryEngineProbe` over the real wire: MCP for the tool surface, plain HTTP
 * for the REST surface. This is what runs against a live engine.
 *
 * MCP calls go through `@langchain/mcp-adapters`' `MultiServerMCPClient` —
 * deliberately the same client the runtime itself uses (`plugins/memory/
 * memory-tools.ts`), so conformance exercises the production code path rather
 * than a hand-rolled JSON-RPC approximation.
 *
 * Spec: `specs/memory-engine-contract-v1.md` §2.
 */
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type {
  BatchQuery,
  BatchSlot,
  IngestMessage,
  MemoryEngineProbe,
  ProbeAuth,
  ProbeOutcome,
  ProbeToolDescriptor,
} from './types.js';

/** The server name the runtime registers. Tool names come back prefixed. */
const SERVER_NAME = 'memory-engine';
const PREFIX = `${SERVER_NAME}__`;

export interface HttpMemoryEngineProbeOptions {
  /** `MEMORY_MCP_URL`. */
  mcpUrl: string;
  /** `MEMORY_ENGINE_URL`. Omit for a Core-only run. */
  restUrl?: string;
  /** Per-call timeout. Defaults to 60s — the caller's own hard cap (§9). */
  timeoutMs?: number;
}

/**
 * Pull an HTTP status out of a transport error. The MCP client wraps failures
 * in `Error`, so the status only survives as text — there is no structured
 * field to read. Checks that assert 401-vs-403 depend on this, hence the
 * explicit extraction rather than a blanket `status: null`.
 */
function extractStatus(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /\b(4\d{2}|5\d{2})\b/.exec(message);
  return match ? Number(match[1]) : null;
}

function errorOutcome<T>(err: unknown): ProbeOutcome<T> {
  return {
    ok: false,
    status: extractStatus(err),
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Build the header set of §3.1/§3.3, omitting whatever the auth says to omit. */
function buildHeaders(auth: ProbeAuth): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (auth.invocation !== null) {
    headers.Authorization = `Bearer ${auth.invocation}`;
    headers['X-Auth-Type'] = 'ucan';
  }
  if (auth.roomId !== null) {
    headers['x-room-id'] = auth.roomId;
  }
  return headers;
}

interface McpToolLike {
  name: string;
  description: string;
  invoke: (input: unknown) => Promise<unknown>;
}

export class HttpMemoryEngineProbe implements MemoryEngineProbe {
  private readonly mcpUrl: string;

  private readonly restUrl?: string;

  private readonly timeoutMs: number;

  constructor(opts: HttpMemoryEngineProbeOptions) {
    this.mcpUrl = opts.mcpUrl;
    this.restUrl = opts.restUrl;
    this.timeoutMs = opts.timeoutMs ?? 60_000;

    // Only wire the REST methods when a REST URL exists. Their absence is what
    // signals a Core-only run to the Full-level checks, so they must be
    // genuinely undefined rather than present-and-throwing.
    if (!this.restUrl) {
      this.searchBatch = undefined;
      this.postMessages = undefined;
    }
  }

  /**
   * A fresh client per call. Connection is where auth is enforced, so reusing a
   * client across calls would let an authenticated connection serve a request
   * the check intends to be unauthenticated — silently turning MEC-04 into a
   * false pass.
   */
  private async withTools<T>(
    auth: ProbeAuth,
    fn: (tools: McpToolLike[]) => Promise<T>,
  ): Promise<ProbeOutcome<T>> {
    const client = new MultiServerMCPClient({
      useStandardContentBlocks: true,
      prefixToolNameWithServerName: true,
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          transport: 'http',
          url: this.mcpUrl,
          headers: buildHeaders(auth),
          reconnect: { enabled: false, maxAttempts: 0, delayMs: 0 },
          defaultToolTimeout: this.timeoutMs,
        },
      },
    });

    try {
      const tools = (await client.getTools()) as unknown as McpToolLike[];
      return { ok: true, value: await fn(tools) };
    } catch (err) {
      return errorOutcome(err);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async listTools(
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<ProbeToolDescriptor[]>> {
    return this.withTools(auth, async (tools) =>
      tools.map((t) => ({
        // Strip the server prefix — the contract specifies wire names.
        name: t.name.startsWith(PREFIX) ? t.name.slice(PREFIX.length) : t.name,
        description: t.description ?? '',
      })),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<unknown>> {
    const outcome = await this.withTools(auth, async (tools) => {
      const tool = tools.find(
        (t) => t.name === `${PREFIX}${name}` || t.name === name,
      );
      if (!tool) throw new Error(`tool "${name}" not exposed by the engine`);
      return tool.invoke(args);
    });

    if (!outcome.ok) return outcome;

    // An engine may report a tool failure inside a success envelope. §8 forbids
    // it, but the checks must still read it as a failure or a non-conformant
    // engine would score better than a conformant one.
    const value: unknown = outcome.value;
    if (
      typeof value === 'object' &&
      value !== null &&
      'isError' in value &&
      (value as { isError?: unknown }).isError === true
    ) {
      return {
        ok: false,
        status: null,
        error: `tool reported isError: ${JSON.stringify(value)}`,
      };
    }

    return outcome;
  }

  async fetchJson<T>(
    path: string,
    body: unknown,
    auth: ProbeAuth,
  ): Promise<ProbeOutcome<T>> {
    if (!this.restUrl) {
      return { ok: false, status: null, error: 'no restUrl configured' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.restUrl}${path}`, {
        method: 'POST',
        headers: buildHeaders(auth),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: (await response.text()).slice(0, 500),
        };
      }
      return { ok: true, value: (await response.json()) as T };
    } catch (err) {
      return errorOutcome(err);
    } finally {
      clearTimeout(timer);
    }
  }

  searchBatch?: (
    queries: BatchQuery[],
    auth: ProbeAuth,
  ) => Promise<ProbeOutcome<{ results: BatchSlot[] }>> = async (
    queries,
    auth,
  ) =>
    this.fetchJson<{ results: BatchSlot[] }>(
      '/search-enhanced-batch',
      { queries },
      auth,
    );

  postMessages?: (
    messages: IngestMessage[],
    auth: ProbeAuth,
  ) => Promise<ProbeOutcome<unknown>> = async (messages, auth) =>
    this.fetchJson<unknown>('/messages', { messages }, auth);
}
