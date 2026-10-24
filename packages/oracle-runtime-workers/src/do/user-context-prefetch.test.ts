import { contentDigest, retainedMemory } from '../memory/retained-context';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { StructuredTool } from '@langchain/core/tools';
import {
  createDelegation,
  generateKeypair,
  serializeDelegation,
} from '@ixo/ucan';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRuntimeCore } from '../core';
import { CONTEXT_SECTION_LABELS } from '../core/prompt-composer';
import { makeEnv } from '../core/test-fixtures';
import {
  USER_CONTEXT_SLOTS,
  type UserContextSlot,
} from '../memory/user-context-fetcher';
import {
  bytesOfStream,
  streamOfBytes,
  type FileSnapshot,
  type OwnerCopy,
  type OwnerStore,
} from '../owner-store/types';
import { MemoryPlugin } from '../plugins/memory/memory.plugin';
import { MEMORY_ADD_MCP_NAME } from '../plugins/memory/memory-tools';
import { DoSqliteDatabase } from '../sqlite/database';
import { SessionsStore } from '../sqlite/sessions-store';
import { SqliteSaver } from '../sqlite/sqlite-saver';
import type { SqliteTestDO } from '../sqlite/test-do';
import { TASK_SESSION_PREFIX } from '../tasks/scheduler';
import type { TurnRequest, UserOracleObject } from './contracts';
import { RunCoordinator } from './run-coordinator';
import type { RunFrame } from './run-buffer';
import { storedRunRequest, type StoredRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

/**
 * The first-turn user-context prefetch through a real `UserOracleDO` turn: a
 * real wa-sqlite working copy, the real run coordinator, agent build and
 * UCAN minting (a real user delegation to the oracle's signing key), a
 * scripted model, and the memory engine behind a stubbed `fetch`. The
 * gateway and the owner store are in-memory fakes; the memory plugin's MCP
 * surface is one stub tool under the upstream `add_memory` name, so a
 * scripted memory write runs through the real tool middlewares.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
    }
  }
}

const USER_DID = 'did:ixo:user-context-user';
const ORACLE_DID = 'did:ixo:entity:testoracle0000000000000001';
// Deterministic BIP39 test vector — never a real account.
const ORACLE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ENGINE = 'https://memory-engine.example';
const ENGINE_DID = 'did:web:memory-engine.example';
const ROOM = '!oracle-room:example.org';
const GROUP_ROOM = '!group-room:example.org';
const BATCH_PATH = '/agent/search-batch';
const CONTEXT_HEADING = '## What you know about the user';
const PROGRESS_STEP = 'Recalling your memories…';

const FAVOURITE_SEA = 'The user’s favourite sea is the Aegean.';
const WORKS_AT = 'The user works at a marine research institute.';
const LEARNING = 'The user is learning to sail.';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The `[user-context] first contact` warn lines logged for `sessionId`. */
const firstContacts = (warnCalls: unknown[][], sessionId: string): string[] =>
  warnCalls
    .map(([line]) => line)
    .filter(
      (line): line is string =>
        typeof line === 'string' &&
        line.startsWith(
          `[user-context] first contact room=${ROOM} session=${sessionId} `,
        ),
    );

// ── The memory engine ───────────────────────────────────────────────────────

interface EngineRequest {
  pathname: string;
  authorization: string | null;
  authType: string | null;
  roomId: string | null;
  queries: number;
}

type EngineMode =
  | { kind: 'answer'; delayMs?: number }
  | { kind: 'status'; status: number }
  /** Hold every batch until `release()`. */
  | { kind: 'hang' };

/** Six `/search-enhanced` answers in query order, one fact per given slot. */
async function batchResults(facts: Partial<Record<UserContextSlot, string>>) {
  const scope = {
    userDid: USER_DID,
    oracleDid: ORACLE_DID,
    knowledgeScope: 'personal',
  };
  return Promise.all(
    USER_CONTEXT_SLOTS.map(async (slot) => {
      const text = facts[slot];
      return {
        representation: 1,
        scope,
        observedAt: new Date().toISOString(),
        facts: text
          ? [
              {
                reference: `memory:fact:personal:${slot}`,
                revision: await contentDigest(text),
                text,
                scope,
              },
            ]
          : [],
      };
    }),
  );
}

class FakeEngine {
  readonly requests: EngineRequest[] = [];
  mode: EngineMode = { kind: 'answer' };
  facts: Partial<Record<UserContextSlot, string>> = {
    identity: FAVOURITE_SEA,
    work: WORKS_AT,
  };
  private held: Array<() => void> = [];

  get batches(): EngineRequest[] {
    return this.requests.filter((r) => r.pathname === BATCH_PATH);
  }

  /** Answer every held batch with the facts set now. */
  release(): void {
    for (const answer of this.held.splice(0)) answer();
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let queries = 0;
    if (url.pathname === BATCH_PATH) {
      const body: unknown = await request.json();
      const list: unknown =
        typeof body === 'object' && body !== null
          ? Reflect.get(body, 'queries')
          : undefined;
      queries = Array.isArray(list) ? list.length : -1;
    }
    this.requests.push({
      pathname: url.pathname,
      authorization: request.headers.get('authorization'),
      authType: request.headers.get('x-auth-type'),
      roomId: request.headers.get('x-room-id'),
      queries,
    });
    if (url.pathname === '/.well-known/did.json')
      return Response.json({ id: ENGINE_DID });
    // Session-history upload (the history indexer).
    if (url.pathname === '/messages') return Response.json({ ok: true });
    if (this.mode.kind === 'status')
      return new Response('engine failure', { status: this.mode.status });
    if (url.pathname === '/agent/references/check') {
      const parsed = z
        .object({
          references: z.array(
            z.object({ reference: z.string(), revision: z.string() }),
          ),
        })
        .parse(await request.json());
      const current = (await batchResults(this.facts)).flatMap(
        (result) => result.facts,
      );
      return Response.json({
        representation: 1,
        scope: {
          userDid: USER_DID,
          oracleDid: ORACLE_DID,
          knowledgeScope: 'personal',
        },
        observedAt: new Date().toISOString(),
        valid: parsed.references.every((ref) =>
          current.some(
            (fact) =>
              fact.reference === ref.reference &&
              fact.revision === ref.revision,
          ),
        ),
      });
    }
    if (url.pathname !== BATCH_PATH)
      return new Response('not stubbed', { status: 404 });
    const mode = this.mode;
    if (mode.kind === 'hang')
      await new Promise<void>((resolve) => this.held.push(resolve));
    else if (mode.delayMs) await sleep(mode.delayMs);
    return Response.json({
      representation: 1,
      results: await batchResults(this.facts),
    });
  }
}

function stubEngine(engine: FakeEngine): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith(ENGINE)) return engine.handle(request);
      return new Response('not stubbed', { status: 404 });
    }),
  );
}

// ── A scripted model that records the system prompt of each call ────────────

/** A message's text, whether a string or text blocks (the cached system prompt). */
function textOf(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) =>
      block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .join('');
}

/** A tool call the model makes on its next agent call. */
interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
}

class RecordingModel extends FakeToolCallingModel {
  constructor(
    readonly calls: Array<{ system: string; agent: boolean }> = [],
    /** Tool calls for the next agent calls, one per call, in order. */
    readonly script: ScriptedCall[] = [],
    private readonly boundTools: string[] = [],
  ) {
    super({});
  }

  override bindTools(tools: StructuredTool[]): RecordingModel {
    return new RecordingModel(
      this.calls,
      this.script,
      tools.map((t) => t.name),
    );
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const system = messages.find((m) => m.type === 'system');
    const agent = this.boundTools.length > 0;
    this.calls.push({ system: system ? textOf(system.content) : '', agent });
    const next = agent ? this.script.shift() : undefined;
    const message = next
      ? new AIMessage({
          content: '',
          tool_calls: [
            {
              id: `call-${this.calls.length}`,
              name: next.name,
              args: next.args,
              type: 'tool_call',
            },
          ],
        })
      : new AIMessage({ content: 'Done.' });
    return { generations: [{ text: next ? '' : 'Done.', message }] };
  }
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
    resolveUserRoom: async () => ({ roomId: ROOM }),
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

/** A real serialized delegation from the user to the oracle, granting `grant`. */
async function delegationTo(
  grant: 'memory' | 'sandbox' = 'memory',
): Promise<string> {
  const user = await generateKeypair();
  return serializeDelegation(
    await createDelegation({
      issuer: user.signer,
      audience: ORACLE_DID,
      capabilities: [
        grant === 'memory'
          ? { can: 'memory/*', with: 'ixo:memory' }
          : { can: 'sandbox/*', with: 'ixo:sandbox' },
      ],
      expiration: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
}

interface ObjectOptions {
  /** Extra env (the `USER_CONTEXT_*` knobs). */
  env?: Record<string, unknown>;
  delegation?: string;
}

async function userObject(
  state: DurableObjectState,
  engine: FakeEngine,
  opts: ObjectOptions,
) {
  const objectEnv = {
    ORACLE_DID,
    ORACLE_SIGNING_MNEMONIC: ORACLE_MNEMONIC,
    MEMORY_ENGINE_URL: ENGINE,
    MEMORY_MCP_URL: `${ENGINE}/mcp`,
    ...opts.env,
  };
  let memoryWrites = 0;
  const core = createRuntimeCore({
    config: { name: 'Test' },
    env: makeEnv(objectEnv),
    // The memory plugin declares MEMORY_ENGINE_URL; its MCP surface is one
    // stub write tool under the upstream name.
    plugins: [
      new MemoryPlugin({
        mcpFactory: () => async () => [
          {
            name: MEMORY_ADD_MCP_NAME,
            description: 'Store a memory about the user.',
            schema: z.object({ content: z.string() }),
            invoke: async () => {
              memoryWrites += 1;
              return 'Memory stored.';
            },
          },
        ],
      }),
    ],
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
    makeEnv({ ...objectEnv, BLOCKSYNC_GRAPHQL_URL: '' }),
  ]);
  if (!(host instanceof Oracle)) throw new Error('invalid user object');
  const attachmentRpc: Pick<
    UserOracleObject,
    'attachmentInventory' | 'attachmentReceiptCurrent'
  > = host;
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

  const delegation = opts.delegation ?? (await delegationTo());
  const identity = { userDid: USER_DID, ucanDelegation: delegation };
  await call('ready', identity);
  // Offline model lookups, no capability router, the scripted model.
  Reflect.set(host, 'contextWindows', {
    resolve: async (model: string) => ({
      model,
      tokens: 100_000,
      origin: 'default',
    }),
    learnFromError: () => undefined,
  });
  Reflect.set(host, 'capabilityRouter', undefined);
  const model = new RecordingModel();
  const ambient = field('ambient');
  if (typeof ambient !== 'object' || ambient === null)
    throw new Error('not booted');
  Reflect.set(host, 'ambient', { ...ambient, llm: { get: () => model } });

  const sessions = (): SessionsStore => {
    const value = field('sessions');
    if (!(value instanceof SessionsStore)) throw new Error('not booted');
    return value;
  };
  const saver = (): SqliteSaver => {
    const value = field('saver');
    if (!(value instanceof SqliteSaver)) throw new Error('not booted');
    return value;
  };
  const db = (): DoSqliteDatabase => {
    const value = field('db');
    if (!(value instanceof DoSqliteDatabase)) throw new Error('not booted');
    return value;
  };

  /** Settle every background job (gathers, indexing) handed to `waitUntil`. */
  const drain = async (): Promise<void> => {
    while (background.length > 0)
      await Promise.allSettled(background.splice(0));
  };

  /**
   * One turn (a Portal turn unless `options` say otherwise), run as a
   * durable run to its end. Background work is NOT awaited: a refresh may
   * still be running when this returns.
   */
  const turn = async (
    sessionId: string,
    requestId: string,
    options: {
      /** A Matrix turn in `roomKind`'s room (`ROOM`, or `GROUP_ROOM` for a group). */
      matrix?: 'direct' | 'group';
      executionProfile?: TurnRequest['executionProfile'];
      /** Abort the run this long after it starts; the agent may never run. */
      abortAfterMs?: number;
      attachments?: TurnRequest['attachments'];
    } = {},
  ) => {
    const roomId = options.matrix === 'group' ? GROUP_ROOM : ROOM;
    if (!(await sessions().getSession(sessionId)))
      await sessions().createSession({
        sessionId,
        roomId,
        oracleName: 'Test',
        oracleDid: ORACLE_DID,
        oracleEntityDid: 'did:ixo:entity:oracle1',
      });
    const runs = field('runs');
    if (!(runs instanceof RunCoordinator)) throw new Error('not booted');
    const client = options.matrix ? 'matrix' : 'portal';
    const request: TurnRequest = {
      identity: { ...identity, timezone: 'UTC' },
      sessionId,
      message: 'What do you know about me?',
      ...(options.attachments ? { attachments: options.attachments } : {}),
      client,
      requestId,
      ...(options.matrix ? { roomId, roomKind: options.matrix } : {}),
      ...(options.executionProfile
        ? { executionProfile: options.executionProfile }
        : {}),
    };
    const stored: StoredRunRequest = {
      ...storedRunRequest(request, { stream: true }),
      disposition: { kind: 'agent' },
    };
    const frames: RunFrame[] = [];
    const callsBefore = model.calls.length;
    const startedAt = Date.now();
    const { live } = await runs.begin({
      runId: `run-${requestId}`,
      sessionId,
      requestId,
      client,
      request: JSON.stringify(stored),
      multitask: 'interrupt',
    });
    live.buffer.subscribe((frame) => frames.push(frame));
    const abortTimer =
      options.abortAfterMs !== undefined
        ? setTimeout(() => live.abort.abort(), options.abortAfterMs)
        : undefined;
    const outcome = await live.done;
    clearTimeout(abortTimer);
    const elapsedMs = Date.now() - startedAt;
    const turnCalls = model.calls.slice(callsBefore);
    // A supplied-context turn binds no tools: its first call is the agent's.
    const agentCall = options.executionProfile
      ? turnCalls[0]
      : turnCalls.find((c) => c.agent);
    if (!agentCall && options.abortAfterMs === undefined)
      throw new Error('the agent was never called');
    const steps = frames
      .filter((f) => f.event === 'router.update')
      .map((f) =>
        typeof f.data === 'object' && f.data !== null
          ? Reflect.get(f.data, 'step')
          : undefined,
      );
    return { outcome, elapsedMs, system: agentCall?.system ?? '', steps };
  };

  /** The `userContext` channel of the session's latest checkpoint. */
  const checkpointedContext = async (sessionId: string): Promise<unknown> => {
    const tuple = await saver().getTupleWithoutMessages({
      configurable: { thread_id: sessionId },
    });
    return tuple?.checkpoint.channel_values.userContext;
  };

  /** `GET /debug/context` → `userContext`, as the route returns it. */
  const status = async (
    sessionId?: string,
  ): Promise<Record<string, unknown>> => {
    const result = await call(
      'contextStatus',
      { userDid: USER_DID },
      undefined,
      undefined,
      sessionId,
    );
    if (typeof result !== 'object' || result === null)
      throw new Error('no context status');
    const userContext: unknown = JSON.parse(
      JSON.stringify(Reflect.get(result, 'userContext')),
    );
    if (typeof userContext !== 'object' || userContext === null)
      throw new Error('no userContext in the context status');
    return Object.fromEntries(Object.entries(userContext));
  };

  return {
    engine,
    turn,
    drain,
    status,
    checkpointedContext,
    model,
    memoryWrites: () => memoryWrites,
    revoke: () => call('clearDelegation', USER_DID),
    inventory: (sessionId: string) =>
      attachmentRpc.attachmentInventory({ userDid: USER_DID }, sessionId),
    prepareResume: async (sessionId: string, group = false) => {
      const prepared = await call(
        'prepareTurn',
        {
          identity,
          sessionId,
          requestId: 'resume',
          client: group ? 'matrix' : 'portal',
          ...(group ? { roomKind: 'group', roomId: ROOM } : {}),
          message: 'resume',
        },
        { message: 'resume' },
        {
          runId: 'resume',
          abortController: new AbortController(),
          resumed: true,
          continuation: null,
        },
      );
      if (typeof prepared !== 'object' || prepared === null)
        throw new Error('no prepared turn');
      const agent: unknown = Reflect.get(prepared, 'agent');
      const config: unknown = Reflect.get(prepared, 'config');
      if (typeof agent !== 'object' || agent === null)
        throw new Error('no agent');
      if (typeof config !== 'object' || config === null)
        throw new Error('no graph config');
      const update: unknown = Reflect.get(agent, 'updateState');
      const invoke: unknown = Reflect.get(agent, 'invoke');
      if (typeof update !== 'function' || typeof invoke !== 'function')
        throw new Error('no resumable graph');
      await Reflect.apply(update, agent, [
        config,
        { messages: [new HumanMessage('continue')] },
        '__start__',
      ]);
      return async () => {
        const before = model.calls.length;
        await Reflect.apply(invoke, agent, [null, config]);
        return (
          model.calls.slice(before).find((entry) => entry.agent)?.system ?? ''
        );
      };
    },
    advance: () => call('advanceMemoryGeneration'),
    seedLegacy: async (sessionId: string) => {
      const tuple = await saver().getTuple({
        configurable: { thread_id: sessionId },
      });
      if (!tuple) throw new Error('no checkpoint');
      const legacy = new SqliteSaver(db());
      await legacy.put(
        tuple.config,
        {
          ...tuple.checkpoint,
          channel_values: {
            ...tuple.checkpoint.channel_values,
            userContext: {
              identity: { facts: [{ fact: 'UNCITED_LEGACY_SECRET' }] },
            },
          },
        },
        tuple.metadata ?? { source: 'update', step: 0, parents: {} },
      );
    },
    /** Hand the session's transcript to the history indexer. */
    indexHistory: (sessionId: string) =>
      call('scheduleHistoryIndexing', sessionId),
    /** Let a supplied-context profile through (no persisted task needed). */
    allowSuppliedContext: () =>
      Reflect.set(host, 'taskScheduler', {
        assertTurnProfile: async () => undefined,
        isRestrictedSession: async () => true,
      }),
    async close(): Promise<void> {
      engine.release();
      await drain();
      await db().close();
    },
  };
}

type UserObject = Awaited<ReturnType<typeof userObject>>;

async function withObject(
  name: string,
  opts: ObjectOptions,
  body: (o: UserObject) => Promise<void>,
  engine = new FakeEngine(),
): Promise<void> {
  stubEngine(engine);
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const o = await userObject(state, engine, opts);
    try {
      await body(o);
    } finally {
      await o.close();
    }
  });
}

const factLine = (fact: string) => `- ${fact}`;
const label = (slot: UserContextSlot) => `**${CONTEXT_SECTION_LABELS[slot]}**`;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('user-context prefetch in a user-object turn', () => {
  it('waits on a first turn and puts what the engine knows in the prompt and the checkpoint', async () => {
    await withObject('user-context-first-turn', {}, async (o) => {
      const warn = vi.spyOn(console, 'warn');
      const first = await o.turn('s1', 'r1');
      expect(first.outcome.status).toBe('finished');
      const [contact, ...more] = firstContacts(warn.mock.calls, 's1');
      expect(more).toEqual([]);
      expect(contact).toMatch(/ outcome=fresh waited=\d+ms$/);

      // One batch, authenticated with a UCAN minted from the delegation.
      expect(o.engine.batches).toHaveLength(1);
      const [batch] = o.engine.batches;
      expect(batch?.queries).toBe(USER_CONTEXT_SLOTS.length);
      expect(batch?.authType).toBe('ucan');
      expect(batch?.roomId).toBe(ROOM);
      expect(batch?.authorization).toMatch(/^Bearer \S{100,}$/);

      expect(first.system).toContain(CONTEXT_HEADING);
      expect(first.system).toContain(
        `${label('identity')}\n_Facts:_\n${factLine(FAVOURITE_SEA)}`,
      );
      expect(first.system).toContain(
        `${label('work')}\n_Facts:_\n${factLine(WORKS_AT)}`,
      );
      // A fast engine never shows the progress step.
      expect(first.steps).not.toContain(PROGRESS_STEP);

      const retained = retainedMemory(await o.checkpointedContext('s1'));
      expect(retained?.facts.map((fact) => fact.text)).toEqual([
        FAVOURITE_SEA,
        WORKS_AT,
      ]);
      expect(retained?.stamp.userDid).toBe(USER_DID);
      expect(retained?.stamp.generation).toBeGreaterThan(0);

      const status = await o.status('s1');
      expect(status).toMatchObject({
        enabled: true,
        room: ROOM,
        cached: true,
        inFlight: false,
        lastOutcome: 'fresh',
      });
      expect(status.lastSlots).toEqual({
        identity: 'f1/e0/p0/c0',
        work: 'f1/e0/p0/c0',
        goals: 'f0/e0/p0/c0',
        interests: 'f0/e0/p0/c0',
        relationships: 'f0/e0/p0/c0',
        recent: 'f0/e0/p0/c0',
      });
      expect(status.lastMs).toEqual(expect.any(Number));
      expect(Date.parse(String(status.lastAt))).not.toBeNaN();
      // Without a session: the user's room, the same cache.
      expect(await o.status()).toMatchObject({ room: ROOM, cached: true });
    });
  });

  it.each(['deletion', 'refinement'])(
    'suppresses old facts in the next composed prompt and checkpoint after external %s',
    async (change) => {
      await withObject(`user-context-external-${change}`, {}, async (o) => {
        await o.turn('s1', 'r1');
        o.engine.facts =
          change === 'deletion'
            ? {}
            : { identity: 'The user now prefers the Baltic.' };
        const next = await o.turn('s1', 'r2');
        expect(next.system).not.toContain(FAVOURITE_SEA);
        expect(next.system).not.toContain(WORKS_AT);
        expect(await o.checkpointedContext('s1')).toEqual({});
        expect(
          o.engine.requests.some(
            (request) => request.pathname === '/agent/references/check',
          ),
        ).toBe(true);
      });
    },
  );

  it('goes ahead at the cap on a slow first turn and serves the late answer from the cache next time', async () => {
    const engine = new FakeEngine();
    engine.mode = { kind: 'answer', delayMs: 5000 };
    await withObject(
      'user-context-slow-engine',
      { env: { USER_CONTEXT_PREFETCH_CAP_MS: 800 } },
      async (o) => {
        const warn = vi.spyOn(console, 'warn');
        const first = await o.turn('s1', 'r1');
        expect(first.outcome.status).toBe('finished');
        expect(first.elapsedMs).toBeGreaterThanOrEqual(800);
        expect(first.elapsedMs).toBeLessThan(5000);
        const [contact, ...more] = firstContacts(warn.mock.calls, 's1');
        expect(more).toEqual([]);
        const waited = Number(
          /^.* outcome=timeout waited=(\d+)ms$/.exec(contact ?? '')?.[1],
        );
        expect(waited).toBeGreaterThanOrEqual(800);
        expect(waited).toBeLessThan(5000);
        expect(first.system).not.toContain(CONTEXT_HEADING);
        // Waiting past the grace is reported to the Portal.
        expect(first.steps).toContain(PROGRESS_STEP);
        expect(await o.status('s1')).toMatchObject({
          lastOutcome: 'timeout',
          inFlight: true,
        });

        await o.drain(); // the late answer lands in the cache
        expect(await o.status('s1')).toMatchObject({
          cached: true,
          lastOutcome: 'fresh',
        });

        // A new session's first turn: served from the cache, no request.
        const next = await o.turn('s2', 'r2');
        expect(o.engine.batches).toHaveLength(1);
        expect(next.system).toContain(factLine(FAVOURITE_SEA));
        expect(next.steps).not.toContain(PROGRESS_STEP);
        expect(await o.status('s2')).toMatchObject({ lastOutcome: 'cached' });
        expect(firstContacts(warn.mock.calls, 's2')).toEqual([
          expect.stringMatching(/ outcome=cached waited=\d+ms$/),
        ]);
        expect(firstContacts(warn.mock.calls, 's1')).toHaveLength(1);
      },
      engine,
    );
  });

  it('runs a turn without the block when the engine fails, and does not ask again within the failure window', async () => {
    const engine = new FakeEngine();
    engine.mode = { kind: 'status', status: 500 };
    await withObject(
      'user-context-engine-failure',
      {},
      async (o) => {
        const first = await o.turn('s1', 'r1');
        expect(first.outcome.status).toBe('finished');
        expect(first.system).not.toContain(CONTEXT_HEADING);
        expect(o.engine.batches).toHaveLength(1);
        expect(await o.status('s1')).toMatchObject({
          cached: false,
          lastOutcome: 'failed',
        });
        // Nothing was checkpointed: the next turn is still a first contact.
        expect(await o.checkpointedContext('s1')).toEqual({});

        await o.drain();
        const second = await o.turn('s1', 'r2');
        expect(second.outcome.status).toBe('finished');
        expect(o.engine.batches).toHaveLength(1);
        expect(await o.status('s1')).toMatchObject({
          lastOutcome: 'skipped',
          lastReason: 'recently-failed',
        });
      },
      engine,
    );
  });

  it('asks nothing without a memory grant in the delegation', async () => {
    const delegation = await delegationTo('sandbox');
    await withObject('user-context-no-grant', { delegation }, async (o) => {
      const warn = vi.spyOn(console, 'warn');
      const first = await o.turn('s1', 'r1');
      expect(first.outcome.status).toBe('finished');
      // Neither the batch nor the did.json look-up that would precede it.
      expect(o.engine.requests).toEqual([]);
      expect(first.system).not.toContain(CONTEXT_HEADING);
      // Skipped before any request, but still one first-contact line.
      expect(firstContacts(warn.mock.calls, 's1')).toHaveLength(1);
      expect(firstContacts(warn.mock.calls, 's1')[0]).toMatch(
        / outcome=skipped reason=no-memory-grant waited=0ms$/,
      );
      const status = await o.status('s1');
      expect(status).toMatchObject({ enabled: true, cached: false });
      expect(status.lastOutcome).toBeUndefined();
    });
  });

  it('asks nothing when USER_CONTEXT_PREFETCH is off', async () => {
    await withObject(
      'user-context-off',
      { env: { USER_CONTEXT_PREFETCH: 'off' } },
      async (o) => {
        const first = await o.turn('s1', 'r1');
        expect(first.outcome.status).toBe('finished');
        expect(o.engine.batches).toEqual([]);
        expect(first.system).not.toContain(CONTEXT_HEADING);
        expect(await o.status('s1')).toMatchObject({
          enabled: false,
          cached: false,
        });
      },
    );
  });

  it('asks nothing for a task-run session', async () => {
    await withObject('user-context-task-session', {}, async (o) => {
      const sessionId = `${TASK_SESSION_PREFIX}task_prefetch_0000001`;
      const first = await o.turn(sessionId, 'r1');
      expect(first.outcome.status).toBe('finished');
      expect(o.engine.batches).toEqual([]);
      expect(first.system).not.toContain(CONTEXT_HEADING);
    });
  });

  it('asks nothing for a supplied-context turn and renders no block', async () => {
    await withObject('user-context-supplied', {}, async (o) => {
      o.allowSuppliedContext();
      const first = await o.turn('s-supplied', 'r1', {
        executionProfile: 'supplied-context-markdown',
      });
      expect(first.outcome.status).toBe('finished');
      expect(o.engine.requests).toEqual([]);
      expect(first.system).toContain('Produce a Markdown deliverable');
      expect(first.system).not.toContain(CONTEXT_HEADING);
    });
  });

  it('asks nothing in a Matrix group room: the reply is posted to every member', async () => {
    await withObject('user-context-group-room', {}, async (o) => {
      const warn = vi.spyOn(console, 'warn');
      const first = await o.turn('s-group', 'r1', { matrix: 'group' });
      expect(first.outcome.status).toBe('finished');
      expect(o.engine.batches).toEqual([]);
      expect(first.system).not.toContain(CONTEXT_HEADING);
      // The skipped first contact still prints the one first-contact line
      // (`firstContacts` keys on the direct room, so filter by hand here).
      expect(
        warn.mock.calls
          .map(([line]) => line)
          .filter(
            (line): line is string =>
              typeof line === 'string' &&
              line.startsWith('[user-context] first contact '),
          ),
      ).toEqual([
        `[user-context] first contact room=${GROUP_ROOM} session=s-group outcome=skipped reason=group-room waited=0ms`,
      ]);
      expect(await o.status('s-group')).toMatchObject({
        room: GROUP_ROOM,
        cached: false,
      });
    });
  });

  it('prefetches for a Matrix direct turn without the Portal progress step', async () => {
    const engine = new FakeEngine();
    engine.mode = { kind: 'answer', delayMs: 1500 };
    await withObject(
      'user-context-matrix-direct',
      { env: { USER_CONTEXT_PREFETCH_CAP_MS: 1000 } },
      async (o) => {
        const first = await o.turn('s-direct', 'r1', { matrix: 'direct' });
        expect(first.outcome.status).toBe('finished');
        expect(o.engine.batches).toHaveLength(1);
        // It waited past the grace, but only the Portal gets the step.
        expect(first.elapsedMs).toBeGreaterThanOrEqual(1000);
        expect(first.steps).not.toContain(PROGRESS_STEP);
        expect(await o.status('s-direct')).toMatchObject({
          lastOutcome: 'timeout',
        });
      },
      engine,
    );
  });

  it('stops waiting as soon as the turn is aborted', async () => {
    const engine = new FakeEngine();
    engine.mode = { kind: 'hang' };
    await withObject(
      'user-context-abort',
      { env: { USER_CONTEXT_PREFETCH_CAP_MS: 10_000 } },
      async (o) => {
        const first = await o.turn('s1', 'r1', { abortAfterMs: 500 });
        expect(first.outcome.status).not.toBe('finished');
        // Well short of the 10 s cap.
        expect(first.elapsedMs).toBeLessThan(5000);
        expect(o.engine.batches).toHaveLength(1);
        // The gather keeps running in the background.
        expect(await o.status('s1')).toMatchObject({ inFlight: true });
        expect(await o.checkpointedContext('s1')).toBeUndefined();
      },
      engine,
    );
  });

  it('a memory write in a turn drops the room cache, so the next session gathers again', async () => {
    await withObject('user-context-invalidate-write', {}, async (o) => {
      await o.turn('s1', 'r1');
      expect(o.engine.batches).toHaveLength(1);
      await o.drain();
      expect(await o.status('s1')).toMatchObject({ cached: true });

      o.engine.facts = { goals: LEARNING };
      o.model.script.push({
        name: MEMORY_ADD_MCP_NAME,
        args: { content: 'The user is learning to sail.' },
      });
      const second = await o.turn('s1', 'r2');
      expect(second.outcome.status).toBe('finished');
      expect(o.memoryWrites()).toBe(1);
      expect(await o.status('s1')).toMatchObject({ cached: false });
      expect(await o.checkpointedContext('s1')).toEqual({});
      await o.drain();

      const next = await o.turn('s2', 'r3');
      expect(o.engine.batches).toHaveLength(2);
      expect(next.system).toContain(factLine(LEARNING));
      expect(await o.status('s2')).toMatchObject({ lastOutcome: 'fresh' });
    });
  });

  it('rejects legacy uncited retained checkpoint text', async () => {
    await withObject('user-context-legacy-checkpoint', {}, async (o) => {
      await o.turn('s1', 'r1');
      await o.seedLegacy('s1');
      const next = await o.turn('s1', 'r2');
      expect(next.system).not.toContain('UNCITED_LEGACY_SECRET');
      expect(JSON.stringify(await o.checkpointedContext('s1'))).not.toContain(
        'UNCITED_LEGACY_SECRET',
      );
    });
  });

  it('invalidates a detached late fetch before it can reach a prompt or checkpoint', async () => {
    const engine = new FakeEngine();
    engine.mode = { kind: 'hang' };
    await withObject(
      'user-context-late-generation',
      { env: { USER_CONTEXT_PREFETCH_CAP_MS: 30 } },
      async (o) => {
        const first = await o.turn('s1', 'r1');
        expect(first.system).not.toContain(FAVOURITE_SEA);
        await o.advance();
        engine.release();
        await o.drain();
        expect(await o.status('s1')).toMatchObject({ cached: false });
        expect(await o.checkpointedContext('s1')).toEqual({});
      },
      engine,
    );
  });

  it.each(['deleted', 'revoked'])(
    'suppresses retained memory when a checkpoint resumes after %s',
    async (cause) => {
      await withObject(`user-context-resume-${cause}`, {}, async (o) => {
        await o.turn('s1', 'r1');
        const resume = await o.prepareResume('s1');
        expect(JSON.stringify(await o.checkpointedContext('s1'))).toContain(
          FAVOURITE_SEA,
        );
        if (cause === 'deleted') o.engine.facts = {};
        else o.engine.mode = { kind: 'status', status: 403 };
        expect(JSON.stringify(await o.checkpointedContext('s1'))).toContain(
          FAVOURITE_SEA,
        );
        const system = await resume();
        expect(system).toContain('You are');
        expect(system).not.toContain(FAVOURITE_SEA);
        expect(system).not.toContain(WORKS_AT);
        expect(await o.checkpointedContext('s1')).toEqual({});
      });
    },
  );

  it('does not reintroduce a direct-room profile when its checkpoint resumes in a group', async () => {
    await withObject('user-context-group-resume', {}, async (o) => {
      await o.turn('s1', 'r1');
      const resume = await o.prepareResume('s1', true);
      expect(JSON.stringify(await o.checkpointedContext('s1'))).toContain(
        FAVOURITE_SEA,
      );
      const system = await resume();
      expect(system).toContain('You are');
      expect(system).not.toContain(FAVOURITE_SEA);
    });
  });

  it.each(['portal', 'matrix'])(
    'persists a trusted receipt with the inbound %s human message',
    async (surface) => {
      await withObject(`user-attachment-receipt-${surface}`, {}, async (o) => {
        const before = Date.now();
        await o.turn('s1', 'r1', {
          ...(surface === 'matrix' ? { matrix: 'direct' } : {}),
          attachments: [
            {
              filename: 'archive.bin',
              mimetype: 'application/octet-stream',
              mxcUri: 'mxc://example/file',
            },
          ],
        });
        const inventory = z
          .object({
            complete: z.boolean(),
            receipts: z.array(
              z.object({
                name: z.string(),
                userDid: z.string(),
                sessionId: z.string(),
                messageId: z.string(),
                revision: z.string(),
                receivedAt: z.string(),
              }),
            ),
          })
          .parse(await o.inventory('s1'));
        expect(inventory.complete).toBe(true);
        expect(inventory.receipts).toHaveLength(1);
        expect(inventory.receipts[0]).toMatchObject({
          name: 'archive.bin',
          userDid: USER_DID,
          sessionId: 's1',
          revision: expect.stringMatching(/^sha256:/),
        });
        expect(
          Date.parse(inventory.receipts[0]?.receivedAt ?? ''),
        ).toBeGreaterThanOrEqual(before);
      });
    },
  );

  it('indexing session history drops the room cache', async () => {
    await withObject('user-context-invalidate-history', {}, async (o) => {
      await o.turn('s1', 'r1');
      await o.drain();
      expect(await o.status('s1')).toMatchObject({ cached: true });

      await o.indexHistory('s1');
      await o.drain();
      expect(
        o.engine.requests.filter((r) => r.pathname === '/messages'),
      ).toHaveLength(1);
      expect(await o.status('s1')).toMatchObject({ cached: false });
    });
  });
});
