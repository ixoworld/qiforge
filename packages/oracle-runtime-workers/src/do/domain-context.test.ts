import { env, runInDurableObject } from 'cloudflare:test';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { StructuredTool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import {
  DOMAIN_CONTEXT_CLOSE,
  DOMAIN_CONTEXT_OPEN,
  DOMAIN_CONTEXT_PRECEDENCE,
  DomainContextResolver,
  PINNED_ANCHOR_SOURCE,
  type DomainContextOptions,
  type DomainContextPins,
} from '../core/domain-context';
import {
  FINDINGS_TRUNCATED,
  MAX_FINDINGS,
} from '../core/domain-context/findings';
import {
  domainFor,
  hostileIndex,
  linkedDocument,
  withFrontmatter,
  type LinkedDocument,
} from '../core/domain-context/fixtures/setup';
import { cidOf } from '../core/domain-context/integrity';
import { domainValidator } from '../core/domain-context/validator';
import {
  makeEnv,
  makeManifest,
  makePlugin,
  makeSubAgent,
} from '../core/test-fixtures';
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
import type { DomainContextRouterUpdate, TurnRequest } from './contracts';
import { DomainContextStore } from './domain-context-store';
import { RunCoordinator } from './run-coordinator';
import type { RunFrame } from './run-buffer';
import { RunStore } from './run-store';
import { storedRunRequest, type StoredRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

/**
 * Observe-only domain context through a real `UserOracleDO` turn: a real
 * wa-sqlite working copy, the real run coordinator and agent build, a
 * scripted model, and Blocksync plus a document host behind a stubbed
 * `fetch`. The gateway and the owner store are in-memory fakes.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
    }
  }
}

const USER_DID = 'did:ixo:domain-context-user';
/** `ORACLE_ENTITY_DID` of `makeEnv()`. */
const ORACLE_DID = 'did:ixo:entity:oracle1';
const SUBJECT_DID = 'did:ixo:entity:subject1';
const BLOCKSYNC = 'https://blocksync.example/graphql';
const DOCS_ORIGIN = 'https://docs.example';
const OBSERVE: DomainContextOptions = {
  mode: 'observe',
  allowedOrigins: [DOCS_ORIGIN],
};
const DOMAIN_TOOLS = ['read_domain_document', 'refresh_domain_context'];
const SUB_AGENT_TOOL = 'call_research_agent';

// ── Blocksync + document host ───────────────────────────────────────────────

interface Published {
  anchors: Map<string, { cid: string; uri: string }>;
  files: Map<string, Uint8Array>;
  calls: string[];
}

/**
 * `did`'s fixture domain with its two pass-1 documents (the description and
 * the changelog the profile requires) served from `documents`, verified now.
 */
function domainServing(
  did: string,
  documents: { description: LinkedDocument; changelog: LinkedDocument },
): string {
  const verifiedOn = new Date().toISOString().slice(0, 10);
  return withFrontmatter((front) => {
    const index: unknown = front.documents;
    const list: unknown =
      typeof index === 'object' && index !== null
        ? Reflect.get(index, 'entries')
        : undefined;
    if (!Array.isArray(list)) throw new Error('fixture has no document index');
    for (const entry of list) {
      const role: unknown = Reflect.get(entry, 'role');
      const linked =
        role === 'description' ? documents.description : documents.changelog;
      Object.assign(entry, {
        uri: linked.uri,
        cid: linked.cid,
        freshness: { last_verified: verifiedOn, max_age: 'P180D' },
      });
    }
  }, domainFor(did));
}

/** The oracle's and the subject's domains, each with two pass-1 documents. */
async function publishDomains(): Promise<Published> {
  const published: Published = {
    anchors: new Map(),
    files: new Map(),
    calls: [],
  };
  for (const [did, label] of [
    [ORACLE_DID, 'oracle-charter'],
    [SUBJECT_DID, 'subject-overview'],
  ] as const) {
    const description = await linkedDocument(label, `${label} text`);
    const changelog = await linkedDocument(
      `${label}-changelog`,
      `${label} changelog`,
    );
    for (const linked of [description, changelog])
      published.files.set(linked.uri, new TextEncoder().encode(linked.text));
    const index = new TextEncoder().encode(
      domainServing(did, { description, changelog }),
    );
    const uri = `${DOCS_ORIGIN}/${encodeURIComponent(did)}/domain.md`;
    published.files.set(uri, index);
    published.anchors.set(did, { cid: await cidOf(index), uri });
  }
  return published;
}

function urlOf(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : input;
}

async function bodyText(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<string> {
  if (input instanceof Request) return input.text();
  return typeof init?.body === 'string' ? init.body : '';
}

function stubNetwork(published: Published): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      published.calls.push(url);
      if (url === BLOCKSYNC) {
        const request: unknown = JSON.parse(await bodyText(input, init));
        const variables: unknown =
          typeof request === 'object' && request !== null
            ? Reflect.get(request, 'variables')
            : undefined;
        const did: unknown =
          typeof variables === 'object' && variables !== null
            ? Reflect.get(variables, 'id')
            : undefined;
        const anchor =
          typeof did === 'string' ? published.anchors.get(did) : undefined;
        return Response.json({
          data: {
            iids: {
              nodes: [
                {
                  id: did,
                  linkedResource: anchor
                    ? [
                        {
                          id: `${String(did)}#dom`,
                          type: 'domain',
                          proof: anchor.cid,
                          serviceEndpoint: anchor.uri,
                        },
                      ]
                    : [],
                },
              ],
            },
          },
        });
      }
      const file = published.files.get(url);
      if (file) return new Response(file);
      return new Response('not stubbed', { status: 404 });
    }),
  );
}

function domainCalls(published: Published): string[] {
  return published.calls.filter(
    (url) => url === BLOCKSYNC || url.startsWith(DOCS_ORIGIN),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── A scripted model that records what each call was given ──────────────────

interface ModelCall {
  system: string;
  tools: string[];
}

type ScriptedCall = Array<{
  name: string;
  args: Record<string, unknown>;
  id: string;
}>;

/** A message's text, whether a string or text blocks (the cached system prompt). */
function textOf(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) =>
      block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .join('');
}

class RecordingModel extends FakeToolCallingModel {
  constructor(
    private readonly script: ScriptedCall[],
    readonly calls: ModelCall[] = [],
    private readonly boundTools: string[] = [],
  ) {
    super({});
  }

  override bindTools(tools: StructuredTool[]): RecordingModel {
    return new RecordingModel(
      this.script,
      this.calls,
      tools.map((t) => t.name),
    );
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const system = messages.find((m) => m.type === 'system');
    this.calls.push({
      system: system ? textOf(system.content) : '',
      tools: this.boundTools,
    });
    // Only agent calls (a model with bound tools) follow the script; the
    // session-title call answers plainly.
    const toolCalls = this.boundTools.length ? (this.script.shift() ?? []) : [];
    const message = new AIMessage({
      content: toolCalls.length ? '' : 'Done.',
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((call) => ({
              ...call,
              type: 'tool_call' as const,
            })),
          }
        : {}),
    });
    return {
      generations: [{ text: String(message.content), message }],
    };
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

interface ObjectOptions {
  domainContext?: DomainContextOptions;
  script?: ScriptedCall[];
}

async function userObject(state: DurableObjectState, opts: ObjectOptions) {
  const core = createRuntimeCore({
    config: { name: 'Test' },
    env: makeEnv(),
    plugins: [
      makePlugin({
        name: 'research',
        manifest: makeManifest({ visibility: 'always' }),
        getSubAgents: () => [makeSubAgent('research')],
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
  const Oracle = createUserOracleDO({
    core: () => core,
    ...(opts.domainContext ? { domainContext: opts.domainContext } : {}),
  });
  const host: object = Reflect.construct(Oracle, [
    state,
    makeEnv({ BLOCKSYNC_GRAPHQL_URL: '', ORACLE_SIGNING_MNEMONIC: '' }),
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
  const model = new RecordingModel(opts.script ?? []);
  const ambient = field('ambient');
  if (typeof ambient !== 'object' || ambient === null)
    throw new Error('not booted');
  Reflect.set(host, 'ambient', { ...ambient, llm: { get: () => model } });

  const taps: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const events = field('events');
  const tap: unknown =
    typeof events === 'object' && events !== null
      ? Reflect.get(events, 'tap')
      : undefined;
  if (typeof tap !== 'function') throw new Error('no event router');
  Reflect.apply(tap, events, [
    {
      emit: (event: string, payload: Record<string, unknown>) =>
        taps.push({ event, payload }),
    },
  ]);

  const sessions = (): SessionsStore => {
    const value = field('sessions');
    if (!(value instanceof SessionsStore)) throw new Error('not booted');
    return value;
  };
  const runStore = (): RunStore => {
    const value = field('runStore');
    if (!(value instanceof RunStore)) throw new Error('not booted');
    return value;
  };
  const db = (): DoSqliteDatabase => {
    const value = field('db');
    if (!(value instanceof DoSqliteDatabase)) throw new Error('not booted');
    return value;
  };

  /** One portal turn, run as a durable run to its end. */
  const turn = async (
    sessionId: string,
    requestId: string,
    extra: {
      metadata?: Record<string, unknown>;
      pins?: DomainContextPins;
      /** Defaults to `run-<requestId>`; another id runs the request again. */
      runId?: string;
    },
  ) => {
    if (!(await sessions().getSession(sessionId)))
      await sessions().createSession({
        sessionId,
        oracleName: 'Test',
        oracleDid: 'did:ixo:oracle1',
        oracleEntityDid: ORACLE_DID,
      });
    const runs = field('runs');
    if (!(runs instanceof RunCoordinator)) throw new Error('not booted');
    const request: TurnRequest = {
      identity: { userDid: USER_DID, timezone: 'UTC' },
      sessionId,
      message: 'What applies here?',
      client: 'portal',
      requestId,
      ...(extra.metadata ? { metadata: JSON.stringify(extra.metadata) } : {}),
    };
    const stored: StoredRunRequest = {
      ...storedRunRequest(request, { stream: true }),
      disposition: { kind: 'agent' },
      ...(extra.pins ? { domainPins: extra.pins } : {}),
    };
    const frames: RunFrame[] = [];
    const { live } = await runs.begin({
      runId: extra.runId ?? `run-${requestId}`,
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
    const record = await runStore().get(live.runId);
    const storedAfter: StoredRunRequest = JSON.parse(record?.request ?? '{}');
    return { outcome, frames, stored: storedAfter };
  };

  return {
    model,
    taps,
    call,
    field,
    db,
    turn,
    async close(): Promise<void> {
      await Promise.allSettled(background.splice(0));
      await db().close();
    },
  };
}

type UserObject = Awaited<ReturnType<typeof userObject>>;

async function withObject(
  name: string,
  opts: ObjectOptions,
  body: (o: UserObject) => Promise<void>,
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const o = await userObject(state, opts);
    try {
      await body(o);
    } finally {
      await o.close();
    }
  });
}

function isDomainUpdate(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & DomainContextRouterUpdate {
  return Array.isArray(payload.domainContext);
}

function domainStore(o: UserObject): DomainContextStore {
  const store = o.field('domainContextStore');
  if (!(store instanceof DomainContextStore)) throw new Error('no store');
  return store;
}

const dispatchResearch: ScriptedCall = [
  { name: SUB_AGENT_TOOL, args: { task: 'Check the domain.' }, id: 'call-1' },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('domain context in a user-object turn', () => {
  it('gives the main agent and its sub-agents the verified block and tools, reports and pins it', async () => {
    const published = await publishDomains();
    stubNetwork(published);
    await withObject(
      'domain-context-observe',
      { domainContext: OBSERVE, script: [dispatchResearch] },
      async (o) => {
        const { outcome, frames, stored } = await o.turn('s1', 'r1', {
          metadata: { currentEntityDid: SUBJECT_DID },
        });
        expect(outcome.status).toBe('finished');

        // Main agent: the block closes the system prompt, oracle brief first.
        const [main, sub] = o.model.calls;
        if (!main || !sub) throw new Error('expected two model calls');
        expect(main.system).toContain(
          `${DOMAIN_CONTEXT_OPEN}\n${DOMAIN_CONTEXT_PRECEDENCE}`,
        );
        expect(main.system.trimEnd().endsWith(DOMAIN_CONTEXT_CLOSE)).toBe(true);
        const oracleAt = main.system.indexOf('"role":"oracle-constitution"');
        const subjectAt = main.system.indexOf('"role":"subject-domain"');
        expect(oracleAt).toBeGreaterThan(-1);
        expect(subjectAt).toBeGreaterThan(oracleAt);
        expect(main.system).toContain('oracle-charter text');
        expect(main.system).toContain('subject-overview text');
        expect(main.tools).toEqual(expect.arrayContaining(DOMAIN_TOOLS));

        // The sub-agent the main agent dispatched sees the same block and tools.
        expect(sub.system).toContain('you are a test sub-agent');
        expect(sub.system).toContain(DOMAIN_CONTEXT_OPEN);
        expect(sub.system).toContain('"role":"subject-domain"');
        expect(sub.tools).toEqual(expect.arrayContaining(DOMAIN_TOOLS));

        // Provenance: on the run's stream and the session's sockets ...
        const streamed = frames.find(
          (frame) =>
            frame.event === 'router.update' &&
            typeof frame.data === 'object' &&
            frame.data !== null &&
            'domainContext' in frame.data,
        );
        expect(streamed).toBeDefined();
        const tapped = o.taps
          .map((t) => t.payload)
          .filter((payload) => isDomainUpdate(payload));
        expect(tapped).toHaveLength(1);
        const update = tapped[0];
        if (!update) throw new Error('no domain update');
        expect(update.sessionId).toBe('s1');
        expect(update.requestId).toBe('r1');
        expect(
          update.domainContext.map((p) => [p.did, p.status, p.assurance]),
        ).toEqual([
          [ORACLE_DID, 'verified', 'integrity-and-static-validation-only'],
          [SUBJECT_DID, 'verified', 'integrity-and-static-validation-only'],
        ]);
        expect(update.domainContext[0]?.cid).toBe(
          published.anchors.get(ORACLE_DID)?.cid,
        );

        // ... and in the user's SQLite.
        const rows = await domainStore(o).listForSession('s1');
        expect(rows.map((row) => row.requestId)).toEqual(['r1']);
        expect(rows[0]?.provenance).toEqual(update.domainContext);

        // The run is pinned to the revisions it read.
        expect(stored.domainPins).toEqual({
          [ORACLE_DID]: {
            cid: published.anchors.get(ORACLE_DID)?.cid,
            uri: published.anchors.get(ORACLE_DID)?.uri,
            private: false,
          },
          [SUBJECT_DID]: {
            cid: published.anchors.get(SUBJECT_DID)?.cid,
            uri: published.anchors.get(SUBJECT_DID)?.uri,
            private: false,
          },
        });

        // Deleting the session deletes its provenance.
        expect(await o.call('deleteSession', { userDid: USER_DID }, 's1')).toBe(
          true,
        );
        expect(await domainStore(o).listForSession('s1')).toEqual([]);
      },
    );
  });

  it("shares the object's resolver across sessions, and refresh_domain_context invalidates that one", async () => {
    const published = await publishDomains();
    stubNetwork(published);
    await withObject(
      'domain-context-shared-resolver',
      {
        domainContext: OBSERVE,
        // Turn 2 asks for a refresh of the oracle domain; every other call answers.
        script: [
          [],
          [
            {
              name: 'refresh_domain_context',
              args: { domain: ORACLE_DID },
              id: 'refresh-1',
            },
          ],
        ],
      },
      async (o) => {
        expect(o.field('domainResolver')).toBeInstanceOf(DomainContextResolver);
        const lookups = () =>
          published.calls.filter((url) => url === BLOCKSYNC).length;

        await o.turn('s1', 'r1', {});
        expect(lookups()).toBe(1);
        // Another session within the anchor TTL: no lookup, no document read.
        const before = published.calls.length;
        await o.turn('s2', 'r2', {});
        expect(lookups()).toBe(1);
        expect(published.calls.slice(before)).toEqual(
          published.calls
            .slice(before)
            .filter((url) => url !== BLOCKSYNC && !url.startsWith(DOCS_ORIGIN)),
        );
        // The refresh in turn 2 reached the object's cache: turn 3 looks up again.
        await o.turn('s1', 'r3', {});
        expect(lookups()).toBe(2);
      },
    );
  });

  it('records a document read mid-turn: another router_update and the row updated', async () => {
    const published = await publishDomains();
    stubNetwork(published);
    await withObject(
      'domain-context-mid-turn-read',
      {
        // Pass 1 reads the description only; the model reads the changelog.
        domainContext: { ...OBSERVE, pass1: { maxDocuments: 1 } },
        script: [
          [
            {
              name: 'read_domain_document',
              args: { domain: ORACLE_DID, documentId: 'changelog' },
              id: 'read-1',
            },
          ],
        ],
      },
      async (o) => {
        await o.turn('s1', 'r1', {});
        const updates = o.taps
          .map((t) => t.payload)
          .filter((payload) => isDomainUpdate(payload));
        expect(updates).toHaveLength(2);
        const ids = (update: (typeof updates)[number]) =>
          (update.domainContext[0]?.documentsRead ?? []).map((r) => r.id);
        const [first, second] = updates;
        if (!first || !second) throw new Error('expected two updates');
        expect(ids(first)).toEqual(['description']);
        expect(ids(second)).toEqual(['description', 'changelog']);
        const rows = await domainStore(o).listForSession('s1');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.provenance).toEqual(second.domainContext);
      },
    );
  });

  it('a resumed run reads the anchors pinned on it, not the current ones', async () => {
    const published = await publishDomains();
    const original = published.anchors.get(ORACLE_DID);
    if (!original) throw new Error('no oracle anchor');
    stubNetwork(published);
    await withObject(
      'domain-context-pins',
      { domainContext: OBSERVE },
      async (o) => {
        // First attempt: resolves through Blocksync and pins what it read.
        const first = await o.turn('s1', 'r1', {});
        expect(first.stored.domainPins?.[ORACLE_DID]).toEqual({
          ...original,
          private: false,
        });

        // The IID moves on: new bytes under a new CID, and the object's
        // anchor cache forgets the old one, so only the pin can name it.
        const updated = new TextEncoder().encode(
          new TextDecoder()
            .decode(published.files.get(original.uri))
            .replace('Initial passive rc.3 example.', 'Second release.'),
        );
        const updatedUri = `${DOCS_ORIGIN}/oracle-v2/domain.md`;
        published.files.set(updatedUri, updated);
        published.anchors.set(ORACLE_DID, {
          cid: await cidOf(updated),
          uri: updatedUri,
        });
        const resolver = o.field('domainResolver');
        if (!(resolver instanceof DomainContextResolver))
          throw new Error('no resolver');
        resolver.invalidate(ORACLE_DID);

        // The resumed attempt runs from the stored request, pins included.
        const callsBefore = published.calls.length;
        const tapsBefore = o.taps.length;
        await o.turn('s1', 'r1', {
          runId: 'run-r1-resumed',
          ...(first.stored.domainPins ? { pins: first.stored.domainPins } : {}),
        });
        const resumedCalls = published.calls.slice(callsBefore);
        expect(resumedCalls).not.toContain(BLOCKSYNC);
        expect(resumedCalls).not.toContain(updatedUri);
        const update = o.taps
          .slice(tapsBefore)
          .map((t) => t.payload)
          .find((payload) => isDomainUpdate(payload));
        if (!update || !isDomainUpdate(update))
          throw new Error('no domain update');
        expect(update.domainContext[0]).toMatchObject({
          did: ORACLE_DID,
          status: 'verified',
          cid: original.cid,
          source: PINNED_ANCHOR_SOURCE,
        });
        // The resumed attempt's row replaced the first one.
        const rows = await domainStore(o).listForSession('s1');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.provenance[0]?.cid).toBe(original.cid);
      },
    );
  });

  it('keeps the prompt block, the stream and the stored row small for a hostile index', async () => {
    const published = await publishDomains();
    const hostile = new TextEncoder().encode(hostileIndex(ORACLE_DID, 62));
    const uri = `${DOCS_ORIGIN}/hostile/domain.md`;
    published.files.set(uri, hostile);
    published.anchors.set(ORACLE_DID, { cid: await cidOf(hostile), uri });
    stubNetwork(published);
    const lint = domainValidator.lint.bind(domainValidator);
    // More distinct codes than the bound, on top of the real findings of 62 malformed entries.
    vi.spyOn(domainValidator, 'lint').mockImplementation(async (...args) => {
      const report = await lint(...args);
      return {
        ...report,
        findings: [
          ...report.findings,
          ...Array.from({ length: 64 }, (_, i) => ({
            severity: 'error' as const,
            code: `synthetic-${i}`,
            message: 'synthetic',
            path: '/',
            location: { line: 1, column: 1 },
          })),
        ],
      };
    });
    await withObject(
      'domain-context-hostile',
      { domainContext: OBSERVE },
      async (o) => {
        await o.turn('s1', 'r1', {});
        const [main] = o.model.calls;
        if (!main) throw new Error('no model call');
        const block = main.system.slice(
          main.system.indexOf(DOMAIN_CONTEXT_OPEN),
        );
        expect(block.length).toBeLessThan(16_384);
        expect(block).toContain(FINDINGS_TRUNCATED);

        const update = o.taps
          .map((t) => t.payload)
          .find((payload) => isDomainUpdate(payload));
        if (!update || !isDomainUpdate(update))
          throw new Error('no domain update');
        const oracle = update.domainContext[0];
        expect(oracle?.status).toBe('invalid');
        expect(oracle?.findings).toHaveLength(MAX_FINDINGS);
        expect(oracle?.findings.at(-1)).toBe(FINDINGS_TRUNCATED);
        expect(JSON.stringify(update.domainContext).length).toBeLessThan(4096);

        const [row] = await o.db().exec<{
          provenance: string;
        }>('SELECT provenance FROM domain_context_runs WHERE session_id = ?', ['s1']);
        expect(row?.provenance.length).toBeLessThan(4096);
        expect(row?.provenance).toContain(FINDINGS_TRUNCATED);
      },
    );
  });

  it('changes nothing by default: no lookups, no block, no tools, no rows', async () => {
    const published = await publishDomains();
    stubNetwork(published);
    await withObject('domain-context-off', {}, async (o) => {
      const { outcome, frames, stored } = await o.turn('s1', 'r1', {
        metadata: { currentEntityDid: SUBJECT_DID },
      });
      expect(outcome.status).toBe('finished');
      expect(domainCalls(published)).toEqual([]);
      const [main] = o.model.calls;
      if (!main) throw new Error('no model call');
      expect(main.system).not.toContain(DOMAIN_CONTEXT_OPEN);
      expect(main.system).not.toContain(DOMAIN_CONTEXT_PRECEDENCE);
      for (const name of DOMAIN_TOOLS) expect(main.tools).not.toContain(name);
      expect(
        frames.some(
          (frame) =>
            typeof frame.data === 'object' &&
            frame.data !== null &&
            'domainContext' in frame.data,
        ),
      ).toBe(false);
      expect(o.taps.some((t) => isDomainUpdate(t.payload))).toBe(false);
      expect(stored.domainPins).toBeUndefined();
      const domainTables = () =>
        o.db().exec<{
          name: string;
        }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_context_runs'");
      expect(await domainTables()).toEqual([]);
      // Deleting a session does not create the table either.
      expect(await o.call('deleteSession', { userDid: USER_DID }, 's1')).toBe(
        true,
      );
      expect(await domainTables()).toEqual([]);
    });
  });
});
