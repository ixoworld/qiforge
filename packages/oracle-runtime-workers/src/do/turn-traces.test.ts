import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { DEFAULT_MODEL_ID } from '../core/llm';
import { makeEnv } from '../core/test-fixtures';
import type { ModelCallReport } from '../llm/model-call';
import {
  bytesOfStream,
  streamOfBytes,
  type FileSnapshot,
  type OwnerCopy,
  type OwnerStore,
} from '../owner-store/types';
import { makePlugin, makeSubAgent, makeTool } from '../core/test-fixtures';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import { DoSqliteDatabase } from '../sqlite/database';
import { SessionsStore } from '../sqlite/sessions-store';
import type { SqliteTestDO } from '../sqlite/test-do';
import { TurnSchema, TurnStartSchema } from '../traces/fixtures/turn-schema';
import { RUNTIME_VERSION } from '../traces/runtime-version';
import type { TurnRequest } from './contracts';
import { RunCoordinator } from './run-coordinator';
import { storedRunRequest, type StoredRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

/**
 * IXO Traces from a real `UserOracleDO` turn in workerd: the platform model
 * (`ChatOpenAI` → OpenRouter) answers from a stubbed `fetch`, and so does the
 * traces ingest, which decodes each request and checks it against the
 * service's own schema. Proves the wiring: the tracer is on exactly when the
 * env configures it, the turn's reply never waits for the send, and what
 * arrives is one well-formed turn whose usage is the turn's `onModelCall`
 * reports.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
    }
  }
}

const USER_DID = 'did:ixo:ixo1tracesuser';
const COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';
const TRACES = 'https://traces.test';
const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sse(model: string): ReadableStream<Uint8Array> {
  const chunk = (body: Record<string, unknown>) =>
    encoder.encode(
      `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 1, model, ...body })}\n\n`,
    );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        chunk({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Hel' },
              finish_reason: null,
            },
          ],
        }),
      );
      controller.enqueue(
        chunk({
          choices: [
            { index: 0, delta: { content: 'lo.' }, finish_reason: 'stop' },
          ],
        }),
      );
      controller.enqueue(
        chunk({
          provider: 'OpenAI',
          choices: [],
          usage: {
            prompt_tokens: 1234,
            completion_tokens: 7,
            total_tokens: 1241,
            prompt_tokens_details: { cached_tokens: 1000 },
            cost: 0.00042,
          },
        }),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

interface Received {
  path: string;
  apiKey: string | null;
  body: unknown;
}

async function gunzipText(bytes: ArrayBuffer): Promise<string> {
  return new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
}

/**
 * OpenRouter and the traces ingest behind a stubbed `fetch`. `holdTurns`
 * keeps the turn request unanswered until `release()`.
 */
function stubServices(
  opts: { servedModel?: string; holdTurns?: boolean } = {},
) {
  const received: Received[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith(TRACES)) {
        const path = new URL(request.url).pathname;
        const raw = await request.arrayBuffer();
        const text =
          request.headers.get('content-encoding') === 'gzip'
            ? await gunzipText(raw)
            : new TextDecoder().decode(raw);
        received.push({
          path,
          apiKey: request.headers.get('x-api-key'),
          body: JSON.parse(text),
        });
        if (path === '/v1/ingest/turns' && opts.holdTurns) await held;
        return new Response(null, { status: 201 });
      }
      if (request.url !== COMPLETIONS)
        return new Response('not stubbed', { status: 404 });
      const body: unknown = await request.json();
      const stream =
        typeof body === 'object' &&
        body !== null &&
        Reflect.get(body, 'stream') === true;
      if (!stream)
        return Response.json({
          id: 'gen-2',
          object: 'chat.completion',
          created: 1,
          model: 'helper',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'A title' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        });
      return new Response(sse(opts.servedModel ?? DEFAULT_MODEL_ID), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return {
    received,
    release,
    turns: () => received.filter((r) => r.path === '/v1/ingest/turns'),
    starts: () => received.filter((r) => r.path === '/v1/ingest/turns/start'),
  };
}

function fakeOwnerStore(): OwnerStore {
  let file: Uint8Array | null = null;
  return {
    kind: 'vfs',
    load: async (): Promise<OwnerCopy | null> =>
      file ? { stream: streamOfBytes(file), etag: 'e' } : null,
    head: async () => (file ? { etag: 'e' } : null),
    save: async (snapshot: FileSnapshot) => {
      file = await bytesOfStream(snapshot.open());
      return { etag: 'e', bytes: file.byteLength };
    },
    remove: async () => {
      file = null;
    },
  };
}

function fakeGateway() {
  return {
    ensureStarted: async () => ({}),
    getOracleSigningMnemonic: async () => null,
    getOracleSecretsKey: async () => null,
    resolveUserRoom: async () => null,
    getRoomStateEvent: async () => null,
    sendText: async () => '$event',
    sendEvent: async () => '$event',
  };
}

function storageWithMemoryAlarm(storage: DurableObjectStorage) {
  let alarm: number | null = null;
  const alarms = {
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (at: number | Date): Promise<void> => {
      alarm = typeof at === 'number' ? at : at.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    },
  };
  return new Proxy(storage, {
    get(target, property) {
      if (property in alarms) return Reflect.get(alarms, property);
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function userObject(
  state: DurableObjectState,
  workerEnv: Record<string, unknown>,
  plugins: OraclePlugin[] = [],
) {
  const reports: ModelCallReport[] = [];
  const core = createRuntimeCore({
    config: { name: 'Test' },
    env: makeEnv(workerEnv),
    plugins: [
      makePlugin({
        name: 'meter',
        onModelCall: (call) => void reports.push(call),
      }),
      ...plugins,
    ],
    logger: console,
  });
  const background: Promise<unknown>[] = [];
  const ctx = {
    id: state.id,
    storage: storageWithMemoryAlarm(state.storage),
    getWebSockets: () => [],
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
    abort: (reason?: string) => state.abort(reason),
  };
  const Oracle = createUserOracleDO({ core: () => core });
  const host: object = Reflect.construct(Oracle, [
    state,
    makeEnv({
      ...workerEnv,
      BLOCKSYNC_GRAPHQL_URL: '',
      ORACLE_SIGNING_MNEMONIC: '',
    }),
  ]);
  const gateway = fakeGateway();
  Object.defineProperty(host, 'ctx', { value: ctx });
  Object.defineProperty(host, 'gateway', { get: () => gateway });
  const ownerStore = fakeOwnerStore();
  Object.assign(host, { createOwnerStore: async () => ownerStore });
  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const method: unknown = Reflect.get(host, name);
    if (typeof method !== 'function')
      throw new Error(`Missing host method ${name}`);
    return Reflect.apply(method, host, args);
  };
  const field = (name: string): unknown => Reflect.get(host, name);
  await call('ready', { userDid: USER_DID });
  Reflect.set(host, 'contextWindows', {
    resolve: async (model: string) => ({
      model,
      tokens: 100_000,
      origin: 'default',
    }),
    learnFromError: () => undefined,
  });
  Reflect.set(host, 'capabilityRouter', undefined);
  const sessions = (): SessionsStore => {
    const value = field('sessions');
    if (!(value instanceof SessionsStore)) throw new Error('not booted');
    return value;
  };
  const db = (): DoSqliteDatabase => {
    const value = field('db');
    if (!(value instanceof DoSqliteDatabase)) throw new Error('not booted');
    return value;
  };
  /** One portal turn; returns when the run's outcome is in (background still running). */
  const turn = async (
    sessionId: string,
    requestId: string,
    message = 'Say hello.',
  ) => {
    await sessions().createSession({
      sessionId,
      oracleName: 'Test',
      oracleDid: 'did:ixo:oracle1',
      oracleEntityDid: 'did:ixo:entity:oracle1',
    });
    const runs = field('runs');
    if (!(runs instanceof RunCoordinator)) throw new Error('not booted');
    const request: TurnRequest = {
      identity: { userDid: USER_DID, timezone: 'UTC' },
      sessionId,
      message,
      client: 'portal',
      requestId,
    };
    const stored: StoredRunRequest = {
      ...storedRunRequest(request, { stream: true }),
      disposition: { kind: 'agent' },
    };
    const { live } = await runs.begin({
      runId: `run-${requestId}`,
      sessionId,
      requestId,
      client: 'portal',
      request: JSON.stringify(stored),
      multitask: 'interrupt',
    });
    return live.done;
  };
  const drain = async (): Promise<void> => {
    while (background.length > 0)
      await Promise.allSettled(background.splice(0));
  };
  return {
    turn,
    drain,
    reports,
    async close(): Promise<void> {
      await drain();
      await db().close();
    },
  };
}

async function withObject(
  name: string,
  workerEnv: Record<string, unknown>,
  body: (o: Awaited<ReturnType<typeof userObject>>) => Promise<void>,
  plugins: OraclePlugin[] = [],
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const o = await userObject(state, workerEnv, plugins);
    try {
      await body(o);
    } finally {
      await o.close();
    }
  });
}

const TRACES_ENV = {
  TRACES_API_KEY: 'ixt_w_testtest_secret',
  TRACES_ENDPOINT: TRACES,
};

describe('IXO Traces from a user object turn', () => {
  it('sends one well-formed turn after the reply, never holding the reply', async () => {
    const services = stubServices({ holdTurns: true });
    await withObject('traces-turn', TRACES_ENV, async (o) => {
      const outcome = await o.turn('$session-1', 'req-1');
      // The run is finished while the traces ingest has not answered yet.
      expect(outcome).toMatchObject({ status: 'finished', text: 'Hello.' });
      for (let i = 0; i < 100 && services.turns().length === 0; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(services.turns()).toHaveLength(1);
      services.release();
      await o.drain();

      expect(services.received.map((r) => r.path)).toEqual([
        '/v1/ingest/turns/start',
        '/v1/ingest/turns',
      ]);
      expect(
        services.received.every((r) => r.apiKey === 'ixt_w_testtest_secret'),
      ).toBe(true);
      const start = TurnStartSchema.parse(services.starts()[0]!.body);
      const turn = TurnSchema.parse(services.turns()[0]!.body);
      expect(start).toMatchObject({
        trace_id: turn.trace_id,
        start_time: turn.start_time,
        thread_id: '$session-1',
      });
      expect(turn).toMatchObject({
        status: 'success',
        thread_id: '$session-1',
        user_id: USER_DID,
        user_text: 'Say hello.',
        reply_text: 'Hello.',
        metadata: {
          oracle_did: 'did:ixo:oracle1',
          network: 'devnet',
          channel: 'portal',
          runtime_version: RUNTIME_VERSION,
          request_id: 'req-1',
          served_model: DEFAULT_MODEL_ID,
          fallback: 'false',
          user_did: USER_DID,
          thread_id: '$session-1',
        },
      });
      // The usage is what the turn reported to onModelCall for its calls.
      const turnCalls = o.reports.filter((r) => r.purpose === 'reply');
      expect(turnCalls.length).toBeGreaterThan(0);
      expect(turn.usage).toEqual({
        input_tokens: turnCalls.reduce((s, r) => s + (r.promptTokens ?? 0), 0),
        cached_tokens: turnCalls.reduce((s, r) => s + (r.cachedTokens ?? 0), 0),
        output_tokens: turnCalls.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
        cost_usd: turnCalls.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      });
      const llm = turn.runs.filter((r) => r.run_type === 'llm');
      expect(llm.length).toBe(turnCalls.length);
      expect(llm[0]).toMatchObject({
        total_cost: 0.00042,
        prompt_tokens: 1234,
      });
      expect(llm[0]!.events?.map((e) => e.name)).not.toContain('new_token');
    });
  });

  it('flags a turn the fallback model answered', async () => {
    const services = stubServices({
      servedModel: 'anthropic/claude-sonnet-4.6',
    });
    await withObject('traces-fallback', TRACES_ENV, async (o) => {
      await o.turn('$session-2', 'req-2');
      await o.drain();
      const turn = TurnSchema.parse(services.turns()[0]!.body);
      expect(turn.metadata).toMatchObject({
        served_model: 'anthropic/claude-sonnet-4.6',
        fallback: 'true',
      });
    });
  });

  it('sends nothing when the traces env is not configured', async () => {
    const services = stubServices();
    await withObject('traces-off', { TRACES_ENDPOINT: TRACES }, async (o) => {
      const outcome = await o.turn('$session-3', 'req-3');
      expect(outcome).toMatchObject({ status: 'finished' });
      await o.drain();
      expect(services.received).toEqual([]);
    });
  });

  it('keeps the turn whole when the traces service is down', async () => {
    vi.spyOn(console, 'warn');
    const services = stubServices();
    const failing = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new Request(input, init).url;
        if (url.startsWith(TRACES)) throw new TypeError('connection refused');
        return fetchStub(input, init);
      },
    );
    const fetchStub = vi.mocked(globalThis.fetch);
    vi.stubGlobal('fetch', failing);
    await withObject('traces-down', TRACES_ENV, async (o) => {
      const outcome = await o.turn('$session-4', 'req-4');
      expect(outcome).toMatchObject({ status: 'finished', text: 'Hello.' });
      await o.drain();
      expect(services.received).toEqual([]);
    });
  });
});

const SUB_PROMPT = 'You research for the trace test.';

function completionChunks(
  model: string,
  reply: { text: string } | { tool: string; args: Record<string, unknown> },
  usage: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const delta =
    'text' in reply
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call_${reply.tool}`,
              type: 'function',
              function: {
                name: reply.tool,
                arguments: JSON.stringify(reply.args),
              },
            },
          ],
        };
  const base = {
    id: `gen-${model}`,
    object: 'chat.completion.chunk',
    created: 1,
    model,
  };
  return [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'text' in reply ? 'stop' : 'tool_calls',
        },
      ],
    },
    { ...base, provider: 'OpenAI', choices: [], usage },
  ];
}

/**
 * OpenRouter for a turn that calls a sub-agent: the main model asks the
 * sub-agent, the sub-agent calls its tool and answers, the main model
 * replies. The traces ingest as in `stubServices`.
 */
function stubSubAgentServices() {
  const received: Received[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith(TRACES)) {
        const raw = await request.arrayBuffer();
        const text =
          request.headers.get('content-encoding') === 'gzip'
            ? await gunzipText(raw)
            : new TextDecoder().decode(raw);
        received.push({
          path: new URL(request.url).pathname,
          apiKey: request.headers.get('x-api-key'),
          body: JSON.parse(text),
        });
        return new Response(null, { status: 201 });
      }
      if (request.url !== COMPLETIONS)
        return new Response('not stubbed', { status: 404 });
      const body = JSON.stringify(await request.json());
      const parsed: unknown = JSON.parse(body);
      const stream =
        typeof parsed === 'object' &&
        parsed !== null &&
        Reflect.get(parsed, 'stream') === true;
      const sub = body.includes(SUB_PROMPT);
      const hasToolResult = body.includes('"role":"tool"');
      const reply = body.includes('word title')
        ? { text: 'A title' }
        : sub
          ? hasToolResult
            ? { text: 'x is 42' }
            : { tool: 'lookup', args: {} }
          : hasToolResult
            ? { text: 'Here is x.' }
            : { tool: 'call_research_agent', args: { task: 'find x' } };
      const usage = sub
        ? {
            prompt_tokens: 300,
            completion_tokens: 9,
            total_tokens: 309,
            cost: 0.0001,
          }
        : {
            prompt_tokens: 1234,
            completion_tokens: 7,
            total_tokens: 1241,
            cost: 0.00042,
          };
      const model = sub ? 'openai/sub-model' : DEFAULT_MODEL_ID;
      const chunks = completionChunks(model, reply, usage);
      if (!stream) {
        const message =
          'text' in reply
            ? { role: 'assistant', content: reply.text }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call_${reply.tool}`,
                    type: 'function',
                    function: {
                      name: reply.tool,
                      arguments: JSON.stringify(reply.args),
                    },
                  },
                ],
              };
        return Response.json({
          id: `gen-${model}`,
          object: 'chat.completion',
          created: 1,
          model,
          provider: 'OpenAI',
          choices: [
            {
              index: 0,
              message,
              finish_reason: 'text' in reply ? 'stop' : 'tool_calls',
            },
          ],
          usage,
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks)
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
              );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  return {
    received,
    turns: () => received.filter((r) => r.path === '/v1/ingest/turns'),
  };
}

describe('IXO Traces of a user object turn with a sub-agent', () => {
  it('nests the sub-agent’s runs under its tool call, counts them once, and keeps them off the reply stream', async () => {
    const services = stubSubAgentServices();
    const research = makePlugin({
      name: 'research',
      getSubAgents: () => [
        makeSubAgent('Research Agent', {
          systemPrompt: SUB_PROMPT,
          tools: [makeTool('lookup', { handler: async () => 'found x' })],
        }),
      ],
    });
    await withObject(
      'traces-subagent',
      TRACES_ENV,
      async (o) => {
        const outcome = await o.turn('$session-sub', 'req-sub', 'Find x.');
        expect(outcome).toMatchObject({
          status: 'finished',
          text: 'Here is x.',
        });
        await o.drain();
        const turn = TurnSchema.parse(services.turns()[0]!.body);
        const byId = new Map(turn.runs.map((r) => [r.id, r]));
        const above = (id: string | null): string[] => {
          const names: string[] = [];
          for (
            let r = id ? byId.get(id) : undefined;
            r;
            r = r.parent_run_id ? byId.get(r.parent_run_id) : undefined
          )
            names.push(r.name);
          return names;
        };
        const llm = turn.runs.filter((r) => r.run_type === 'llm');
        const subCalls = llm.filter((r) => r.total_cost === 0.0001);
        // Both sub-agent model calls are in the trace, under the tool call.
        expect(subCalls).toHaveLength(2);
        for (const r of subCalls)
          expect(above(r.parent_run_id)).toContain('call_research_agent');
        expect(
          above(turn.runs.find((r) => r.name === 'lookup')!.parent_run_id),
        ).toContain('call_research_agent');
        // The usage is the turn's calls to onModelCall (the title after the
        // reply aside), each once: the main agent's two and the sub-agent's two.
        const turnCalls = o.reports.filter((r) => r.purpose !== 'title');
        expect(turnCalls).toHaveLength(4);
        expect(turn.usage.input_tokens).toBe(
          turnCalls.reduce((s, r) => s + (r.promptTokens ?? 0), 0),
        );
        expect(turn.usage.input_tokens).toBe(2 * 1234 + 2 * 300);
        expect(turn.usage.cost_usd).toBeCloseTo(2 * 0.00042 + 2 * 0.0001, 10);
        expect(llm).toHaveLength(4);
        expect(turn.runs.some((r) => r.tags?.includes('outside_graph'))).toBe(
          false,
        );
        // The person's stream saw only the main agent: its reply and its one tool call.
        expect(
          (
            outcome as { toolCalls?: Array<{ toolName?: string }> }
          ).toolCalls?.map((c) => c.toolName) ?? [],
        ).not.toContain('lookup');
      },
      [research],
    );
  });
});
