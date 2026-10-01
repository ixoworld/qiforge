import { MatrixError } from '@ixo/matrix';
import type { BaseMessage } from '@langchain/core/messages';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { z } from 'zod';
import type {
  CommerceContext,
  CommerceEngagement,
  MatrixEvent,
  RuntimeContext,
} from '../../../plugin-api/types.js';
import { makeRuntimeContext } from '../../../registries/test-fixtures.js';
import type {
  SandboxMcpClientFactory,
  SandboxMcpTool,
} from '../../sandbox/sandbox.plugin.js';
import { AgentCardService } from '../agent-card.service.js';
import { ContractRecordService } from '../contract-record.service.js';
import {
  EngagementService,
  type EngagementStateStore,
} from '../engagement.service.js';
import type { ContractRecord } from '../types.js';

export const ORACLE_ENTITY_DID = 'did:ixo:entity:oracle-1';

/**
 * Absolute path to the on-disk local agent-card fixture. Its JSON mirrors
 * {@link makeCardDocument} — the `local-card` tests assert they stay in sync.
 */
export const LOCAL_CARD_PATH = fileURLToPath(
  new URL('./agent-card.local.json', import.meta.url),
);
export const ORACLE_DID = 'did:ixo:ixo1oracleaddr';
export const USER_DID = 'did:ixo:ixo1useraddr';
export const ADMIN_ADDRESS = 'ixo1admincollectionadmin';
export const COLLECTION_ID = '42';
export const CARD_ENDPOINT = 'https://cellnode.example/card.json';

/** A well-formed Agent Card document as returned from a `serviceEndpoint`. */
export function makeCardDocument(entityDid: string = ORACLE_ENTITY_DID): {
  credentialSubject: Record<string, unknown>;
} {
  return {
    credentialSubject: {
      id: entityDid,
      name: 'Tax Oracle',
      description: 'Files tax reports',
      services: [
        {
          id: 'tax-report',
          name: 'Tax report',
          description: 'A full tax report for the year',
          price: { amount: 20, currency: 'PAY' },
          deliverables: 'A PDF tax report',
          doneMeans: ['All income sources are accounted for'],
          tags: ['tax', 'finance'],
          examples: ['File my 2025 taxes'],
        },
        {
          id: 'quick-estimate',
          name: 'Quick estimate',
          price: { amount: 5 },
          deliverables: 'A one-line estimate',
        },
      ],
    },
  };
}

/** The entity doc shape (Blocksync `getEntityById`) anchoring an `#acard`. */
export function makeEntityDoc(serviceEndpoint: string = CARD_ENDPOINT): {
  linkedResource: Array<Record<string, unknown>>;
} {
  return {
    linkedResource: [
      { type: 'settings', id: `${ORACLE_ENTITY_DID}#orz` },
      {
        type: 'agentCard',
        id: `${ORACLE_ENTITY_DID}#acard`,
        serviceEndpoint,
        proof: 'card-proof-v1',
      },
    ],
  };
}

/**
 * An `AgentCardService` whose Blocksync + card fetch are stubbed to return the
 * canned card, so nothing touches the network.
 */
export function makeCardService(): AgentCardService {
  return new AgentCardService({
    getEntity: async () => makeEntityDoc(),
    fetchCard: async () => makeCardDocument(),
  });
}

/** A canned engine contract record for `USER_DID` on `COLLECTION_ID`. */
export function makeContractRecord(
  overrides: Partial<ContractRecord> = {},
): ContractRecord {
  return {
    collectionId: COLLECTION_ID,
    adminAddress: ADMIN_ADDRESS,
    serviceIds: ['tax-report'],
    rubricId: 'rubric-1',
    cardProof: 'card-proof-v1',
    status: 'active',
    authz: {
      granted: true,
      agentQuotaRemaining: 3,
      maxAmount: { amount: '20000000', denom: 'upay' },
      intentDurationNs: '604800000000000',
    },
    ...overrides,
  };
}

/**
 * A `ContractRecordService` wired to a stub fetch returning `record` (or a 404
 * when `record` is null), plus a token provider that always yields a token.
 * Pass `fetchImpl` to model an engine that fails instead of answering — the
 * lookup then reports an error rather than "no contract".
 */
export function makeContractRecordService(
  record: ContractRecord | null,
  fetchImpl?: typeof fetch,
): {
  service: ContractRecordService;
  fetchCalls: string[];
} {
  const fetchCalls: string[] = [];
  const service = new ContractRecordService({
    tokenProvider: async () => 'engine-token',
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push(String(input));
      if (fetchImpl) return fetchImpl(input, init);
      if (record === null) {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify(record), { status: 200 });
    },
  });
  return { service, fetchCalls };
}

export const ROOM_ID = '!room:ixo.world';
export const THREAD_ID = '$thread-root:ixo.world';

/** One `ctx.matrix.postEvent` call, captured for assertions. */
export interface PostedEvent {
  roomId: string;
  eventType: string;
  content: unknown;
}

export interface CommerceCtxOptions {
  /** Sink that collects everything the tools post. */
  posted?: PostedEvent[];
  commerce?: CommerceContext;
  /** Merged into the default commerce config. */
  config?: Record<string, unknown>;
  user?: Partial<RuntimeContext['user']>;
  /** Thread history the extractor reads. */
  messages?: BaseMessage[];
  abortSignal?: AbortSignal;
  getEventById?: (roomId: string, eventId: string) => Promise<MatrixEvent>;
}

/**
 * A Matrix `RuntimeContext` for the commerce surface: thread-rooted session,
 * a recording `postEvent`, and the config keys the payments tools read.
 */
export function makeCommerceCtx(
  options: CommerceCtxOptions = {},
): RuntimeContext {
  const posted = options.posted ?? [];
  const messages = options.messages ?? [];
  return makeRuntimeContext({
    config: {
      ORACLE_ENTITY_DID,
      ORACLE_DID,
      EVAL_ENGINE_URL: 'https://engine.example',
      ...options.config,
    },
    session: {
      id: THREAD_ID,
      client: 'matrix',
      requestId: 'req-9',
      roomId: ROOM_ID,
    },
    user: {
      did: USER_DID,
      matrixUserId: '@did-ixo-ixo1useraddr:ixo.world',
      ucanDelegation: { raw: 'ucan' },
      ...options.user,
    },
    history: {
      messages,
      recent: (n: number) => messages.slice(Math.max(0, messages.length - n)),
      userContext: {},
      state: { messages },
    },
    toolCallId: 'call-1',
    ...(options.commerce !== undefined && { commerce: options.commerce }),
    ...(options.abortSignal !== undefined && {
      abortSignal: options.abortSignal,
    }),
    matrix: {
      postToRoom: vi.fn(async () => 'evt'),
      postEvent: vi.fn(async (roomId: string, eventType: string, content) => {
        posted.push({ roomId, eventType, content });
        return 'component-event-id';
      }),
      getRoomState: vi.fn(async (roomId: string) => ({ roomId, state: [] })),
      getEventById: vi.fn(
        options.getEventById ??
          (async (_roomId: string, eventId: string): Promise<MatrixEvent> => ({
            eventId,
            type: 'm.room.message',
            content: {},
          })),
      ),
    },
  });
}

/**
 * The engagement as the plugin persists it: the shared shape plus the granted
 * denom stamped at start (uPay spec §5 R1), which the shared type predates.
 */
export type StampedEngagement = CommerceEngagement & { denom?: string };

/** An active work engagement for `tax-report`, as the router would start it. */
export function makeEngagement(
  overrides: Partial<StampedEngagement> = {},
): StampedEngagement {
  return {
    status: 'active',
    serviceId: 'tax-report',
    serviceName: 'Tax report',
    priceUsd: 20,
    denom: 'upay',
    collectionId: COLLECTION_ID,
    adminAddress: ADMIN_ADDRESS,
    startedAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

const ComponentContentSchema = z.object({
  component: z.string(),
  props: z.record(z.string(), z.unknown()),
  body: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  toolCallId: z.string().optional(),
  'm.relates_to': z
    .object({ rel_type: z.string(), event_id: z.string() })
    .optional(),
});

/** Validate a captured post as an `ixo.oracle.component` envelope. */
export function componentContent(
  posted: PostedEvent,
): z.infer<typeof ComponentContentSchema> {
  return ComponentContentSchema.parse(posted.content);
}

/**
 * An in-memory stand-in for the Matrix room-state store: per-room state, a
 * missing key throws `M_NOT_FOUND`. Shared across two `EngagementService`
 * instances it models a restart — the process caches are gone, the state is
 * not.
 */
export function makeEngagementStore(): EngagementStateStore {
  const stored = new Map<string, unknown>();
  const key = (roomId: string, stateKey: string) => `${roomId}|${stateKey}`;
  return {
    getState: async (roomId, stateKey) => {
      if (!stored.has(key(roomId, stateKey))) {
        throw new MatrixError(
          { errcode: 'M_NOT_FOUND', error: 'Not found' },
          404,
        );
      }
      return stored.get(key(roomId, stateKey));
    },
    setState: async (payload) => {
      stored.set(key(payload.roomId, payload.stateKey), payload.data);
    },
  };
}

/**
 * An `EngagementService` over {@link makeEngagementStore} with a frozen clock.
 * `claimIndexRoomId` arms the pending-claim index the claim watcher reads.
 */
export function makeEngagementService(
  now = '2026-07-22T12:00:00.000Z',
  claimIndexRoomId?: string,
  store: EngagementStateStore = makeEngagementStore(),
): EngagementService {
  return new EngagementService({
    stateStore: () => store,
    clock: () => new Date(now),
    ...(claimIndexRoomId !== undefined && { claimIndexRoomId }),
  });
}

/** Handlers backing the two sandbox MCP tools the bridge resolves. */
export interface SandboxStubHandlers {
  run?: (input: unknown) => Promise<unknown>;
  writeFile?: (input: unknown) => Promise<unknown>;
}

/**
 * A sandbox MCP client factory that never opens a connection: it hands the
 * bridge two in-memory tools driven by `handlers`.
 */
export function makeSandboxFactory(
  handlers: SandboxStubHandlers = {},
): SandboxMcpClientFactory {
  const makeTool = (
    name: string,
    invoke: (input: unknown) => Promise<unknown>,
  ): SandboxMcpTool => ({
    name,
    description: name,
    schema: z.unknown(),
    invoke,
  });
  return () => ({
    getTools: async () => [
      makeTool('sandbox_run', handlers.run ?? (async () => '')),
      makeTool(
        'sandbox_write_file',
        handlers.writeFile ?? (async () => JSON.stringify({ success: true })),
      ),
    ],
    close: async () => undefined,
  });
}
