/** Fakes shared by the asks tests. Not imported by the Worker. */
import type { RuntimeContext } from '../../plugin-api';
import { AsksConnection, type ConnectionStorage } from './connection';

export const MCP_URL = 'https://dev.asks.world/v1/mcp';
export const PUBLIC_URL = 'https://companion.devnet.ixo.earth';
export const TOKEN_KEY = 'test-key-0123456789abcdefghijklmnopqrstuvwxyz';
export const PERSON_ADDRESS = `ixo1${'q'.repeat(38)}`;
export const PERSON_DID = `did:ixo:${PERSON_ADDRESS}`;
export const OTHER_ADDRESS = `ixo1${'z'.repeat(38)}`;

export class MemoryStorage implements ConnectionStorage {
  readonly map = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.map.get(key) as T | undefined);
  }

  put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
}

export interface Call {
  url: string;
  init?: RequestInit;
  form?: URLSearchParams;
}

/** A fetch that records each call and answers with `answer`. */
export function recordingFetch(
  answer: (call: Call) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), init };
    if (typeof init?.body === 'string' && init.body.includes('='))
      call.form = new URLSearchParams(init.body);
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetcher };
}

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const tokenAnswer = (n: number, expiresIn = 1800) =>
  json({
    access_token: `asks_at_${n}`,
    refresh_token: `asks_rt_${n}`,
    token_type: 'Bearer',
    expires_in: expiresIn,
  });

/** The connector's `initialize` answer for a token signed in as `address`. */
export const accountAnswer = (address = PERSON_ADDRESS) =>
  json({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      instructions: `Signed in as ${address}: my_status, read_ask act as this person.`,
    },
  });

/**
 * A connection whose OAuth calls go to `fetcher`; its account checks (an MCP
 * `initialize` on MCP_URL) go to `account`, recorded in `probes`.
 */
export function connectionWith(
  fetcher: typeof fetch,
  clock: { now: number },
  storage = new MemoryStorage(),
  account: (call: Call) => Response | Promise<Response> = () => accountAnswer(),
) {
  const probes: Call[] = [];
  const routed = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === MCP_URL) {
      const call: Call = { url: MCP_URL, init };
      probes.push(call);
      return Promise.resolve(account(call));
    }
    return fetcher(input, init);
  }) as typeof fetch;
  const connection = new AsksConnection({
    storage,
    config: { mcpUrl: MCP_URL, publicUrl: PUBLIC_URL, tokenKey: TOKEN_KEY },
    fetch: routed,
    now: () => clock.now,
  });
  return { connection, storage, probes };
}

export class MemoryKv {
  readonly map = new Map<string, unknown>();

  get(namespace: string, key: string): Promise<unknown> {
    return Promise.resolve(this.map.get(`${namespace}/${key}`));
  }

  set(namespace: string, key: string, value: unknown): Promise<void> {
    this.map.set(`${namespace}/${key}`, structuredClone(value));
    return Promise.resolve();
  }

  update(): Promise<unknown> {
    return Promise.reject(new Error('not used'));
  }

  delete(namespace: string, key: string): Promise<void> {
    this.map.delete(`${namespace}/${key}`);
    return Promise.resolve();
  }
}

export function fakeContext(
  extra: Record<string, unknown> = {},
): RuntimeContext {
  return {
    user: { did: PERSON_DID },
    session: { id: 's1', client: 'portal', requestId: 'r1' },
    config: { NETWORK: 'devnet' },
    loadedPlugins: new Set<string>(),
    kv: new MemoryKv(),
    logger: {
      warn: () => undefined,
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    ...extra,
  } as unknown as RuntimeContext;
}
