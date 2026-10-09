import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { DEFAULT_MODEL_ID } from '../core/llm';
import { makeEnv } from '../core/test-fixtures';
import {
  bytesOfStream,
  streamOfBytes,
  type FileSnapshot,
  type OwnerCopy,
  type OwnerStore,
} from '../owner-store/types';
import { DoSqliteDatabase } from '../sqlite/database';
import { SessionsStore } from '../sqlite/sessions-store';
import type { SqliteTestDO } from '../sqlite/test-do';
import type { TurnRequest } from './contracts';
import type { RunFrame } from './run-buffer';
import { RunCoordinator } from './run-coordinator';
import { storedRunRequest, type StoredRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

/**
 * Model-call liveness through a real `UserOracleDO` turn on the real
 * platform adapter (`ChatOpenAI` → OpenRouter): the provider's HTTP endpoint
 * is a stubbed `fetch` that can answer and then go silent. With a short
 * idle budget the turn fails in seconds — not at the turn deadline — with
 * a `timeout` error frame, or recovers through one retry when the stall
 * came before the first byte.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
    }
  }
}

const USER_DID = 'did:ixo:llm-liveness-user';
const COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';
/** The idle budget the turns run with (ms). */
const IDLE_MS = 1_000;
const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── The provider ────────────────────────────────────────────────────────────

type Reply = 'complete' | 'silent-after-headers' | 'silent-mid-reply';

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: DEFAULT_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** An SSE body; `silent` ones never close (the stream stays open, quiet). */
function sseBody(reply: Reply): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (reply === 'silent-after-headers') return;
      controller.enqueue(
        encoder.encode(chunk({ role: 'assistant', content: 'Hel' }, null)),
      );
      if (reply === 'silent-mid-reply') return;
      controller.enqueue(encoder.encode(chunk({ content: 'lo.' }, 'stop')));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function jsonCompletion(): Response {
  return Response.json({
    id: 'chatcmpl-2',
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
}

async function requestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const text =
    input instanceof Request
      ? await input.text()
      : typeof init?.body === 'string'
        ? init.body
        : '{}';
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : {};
}

/**
 * OpenRouter behind a stubbed `fetch`: calls for the main model get the
 * scripted replies in order (the last one repeats); helper models (the
 * session title) answer normally.
 */
function stubProvider(script: Reply[]): { mainCalls: () => number } {
  let mainCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      if (url !== COMPLETIONS)
        return new Response('not stubbed', { status: 404 });
      const body = await requestBody(input, init);
      if (body.model !== DEFAULT_MODEL_ID) {
        if (body.stream !== true) return jsonCompletion();
        return new Response(sseBody('complete'), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const reply =
        script[Math.min(mainCalls, script.length - 1)] ?? 'complete';
      mainCalls += 1;
      return new Response(sseBody(reply), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return { mainCalls: () => mainCalls };
}

// ── The user object ─────────────────────────────────────────────────────────

function fakeOwnerStore(): OwnerStore {
  let file: Uint8Array | null = null;
  let etag = 'etag-0';
  return {
    kind: 'vfs',
    load: async (): Promise<OwnerCopy | null> =>
      file ? { stream: streamOfBytes(file), etag } : null,
    head: async () => (file ? { etag } : null),
    save: async (snapshot: FileSnapshot) => {
      file = await bytesOfStream(snapshot.open());
      etag = `etag-${Date.now()}`;
      return { etag, bytes: file.byteLength };
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

/** The alarm stays in memory: the host test object has no alarm handler. */
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

/** The liveness budgets every turn here runs with (validated like any env). */
const LIVENESS_ENV = {
  LLM_HEADERS_TIMEOUT_MS: String(IDLE_MS),
  LLM_STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS),
  LLM_STREAM_RETRIES: '1',
};

async function userObject(state: DurableObjectState) {
  const core = createRuntimeCore({
    config: { name: 'Test' },
    env: makeEnv(LIVENESS_ENV),
    plugins: [],
    // As `createOracleWorker` builds it: the platform adapter logs here.
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
      ...LIVENESS_ENV,
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
  // Offline context-window lookups and no capability router; the model is
  // the real platform adapter (`core.llm`), talking to the stubbed fetch.
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

  /** One portal turn, run as a durable run to its end. */
  const turn = async (sessionId: string, requestId: string) => {
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
      message: 'Say hello.',
      client: 'portal',
      requestId,
    };
    const stored: StoredRunRequest = {
      ...storedRunRequest(request, { stream: true }),
      disposition: { kind: 'agent' },
    };
    const frames: RunFrame[] = [];
    const { live } = await runs.begin({
      runId: `run-${requestId}`,
      sessionId,
      requestId,
      client: 'portal',
      request: JSON.stringify(stored),
      multitask: 'interrupt',
    });
    live.buffer.subscribe((frame) => frames.push(frame));
    const outcome = await live.done;
    while (background.length > 0)
      await Promise.allSettled(background.splice(0));
    return { outcome, frames };
  };

  return {
    turn,
    async close(): Promise<void> {
      await Promise.allSettled(background.splice(0));
      await db().close();
    },
  };
}

async function withObject(
  name: string,
  body: (o: Awaited<ReturnType<typeof userObject>>) => Promise<void>,
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const o = await userObject(state);
    try {
      await body(o);
    } finally {
      await o.close();
    }
  });
}

function errorFrames(frames: RunFrame[]): Record<string, unknown>[] {
  return frames
    .filter((frame) => frame.event === 'error')
    .map((frame) =>
      typeof frame.data === 'object' && frame.data !== null
        ? Object.fromEntries(Object.entries(frame.data))
        : {},
    );
}

describe('model-call liveness in a turn', () => {
  it('fails a turn whose provider sends headers and then nothing, in seconds', async () => {
    const provider = stubProvider(['silent-after-headers']);
    await withObject('liveness-silent-after-headers', async (o) => {
      const started = Date.now();
      const { outcome, frames } = await o.turn('s1', 'r1');
      const elapsed = Date.now() - started;

      expect(outcome.status).toBe('failed');
      // One retry by the guard, none on top of it by LangChain: two waits.
      expect(provider.mainCalls()).toBe(2);
      expect(elapsed).toBeLessThan(15_000);
      expect(errorFrames(frames)).toEqual([
        expect.objectContaining({
          kind: 'timeout',
          retryable: true,
          error: 'The model did not start responding. Please try again.',
        }),
      ]);
    });
  });

  it('fails a turn whose provider goes silent mid-reply at once, without a retry', async () => {
    const provider = stubProvider(['silent-mid-reply']);
    await withObject('liveness-silent-mid-reply', async (o) => {
      const started = Date.now();
      const { outcome, frames } = await o.turn('s1', 'r1');

      expect(outcome.status).toBe('failed');
      expect(provider.mainCalls()).toBe(1);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(errorFrames(frames)).toEqual([
        expect.objectContaining({
          kind: 'timeout',
          retryable: true,
          error: 'The model stopped responding mid-reply. Please try again.',
        }),
      ]);
    });
  });

  it('recovers a turn whose first attempt stalled before its first byte', async () => {
    const provider = stubProvider(['silent-after-headers', 'complete']);
    const warn = vi.spyOn(console, 'warn');
    const debug = vi.spyOn(console, 'debug');
    await withObject('liveness-retry', async (o) => {
      const { outcome, frames } = await o.turn('s1', 'r1');

      expect(outcome.status).toBe('finished');
      expect(outcome.text).toContain('Hello.');
      expect(errorFrames(frames)).toEqual([]);
      expect(provider.mainCalls()).toBe(2);
      const retries = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => /^\[llm\] .*retrying \(attempt 2\)$/.test(line));
      expect(retries).toEqual([
        `[llm] openrouter main ${DEFAULT_MODEL_ID}: no bytes for 1 s, retrying (attempt 2)`,
      ]);
      // The call trace names the role, through the model `bindTools` rebuilt.
      const trace = debug.mock.calls.map((args) => String(args[0]));
      expect(trace).toContain(
        `[llm] start role=main model=${DEFAULT_MODEL_ID} tags=-`,
      );
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^\\[llm\\] end role=main model=${DEFAULT_MODEL_ID} in \\d+ ms$`,
            ),
          ),
        ]),
      );
    });
  });
});
