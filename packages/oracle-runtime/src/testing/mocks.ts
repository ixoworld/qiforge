import { vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { fakeModel } from 'langchain';
import type {
  BlobStoreAdapter,
  EmitAdapter,
  LlmAdapter,
  MatrixAdapter,
  SecretsAdapter,
  UcanAdapter,
} from '../runtime-context/ambient.js';
import type {
  Logger,
  MatrixEvent,
  RoomStateSnapshot,
} from '../plugin-api/types.js';
import {
  buildDomainContext,
  type DomainContext,
  type DomainEnforcement,
} from '../constitution/domain-context.js';
import { parseDomainMdSubset } from '../constitution/parse.js';
import {
  SUPPORTED_SCHEMA_URI,
  SUPPORTED_SPEC_VERSION,
} from '../constitution/schema.js';

/** Minimal `Response`-like envelope returned from `mockResponse`. */
export interface MockResponseLike {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

/** Init options accepted by `mockResponse`. */
export interface MockResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Build a minimal `Response`-shaped object suitable for `mocks.fetch`
 * handlers. Plugins typically call `response.json()` or `response.text()` —
 * both are covered. Non-2xx statuses set `ok: false`.
 */
export function mockResponse(
  body: unknown,
  init: MockResponseInit = {},
): MockResponseLike {
  const status = init.status ?? 200;
  const headers = init.headers ?? {};
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => text,
  };
}

/** Overrides accepted by `mockMatrix`. Any unspecified method gets a no-op stub. */
export type MockMatrixOverrides = Partial<MatrixAdapter>;

/**
 * Build a `MatrixAdapter` whose default methods are `vi.fn()` stubs.
 * Overrides shadow defaults; the rest keep recorded-no-op behaviour so tests
 * can `expect(matrix.postToRoom).toHaveBeenCalled()`.
 */
export function mockMatrix(overrides: MockMatrixOverrides = {}): MatrixAdapter {
  const defaults: MatrixAdapter = {
    postToRoom: vi.fn(async () => 'mock-event-id'),
    getRoomState: vi.fn(
      async (roomId: string): Promise<RoomStateSnapshot> => ({
        roomId,
        state: [],
      }),
    ),
    getEventById: vi.fn(
      async (_roomId: string, eventId: string): Promise<MatrixEvent> => ({
        eventId,
        type: 'm.room.message',
        content: {},
      }),
    ),
  };
  return { ...defaults, ...overrides };
}

/** Options accepted by `mockLlm`. */
export interface MockLlmOptions {
  /** A single string or list of strings the fake model returns in order. */
  respondWith?: string | string[];
}

/**
 * Build an `LlmAdapter` backed by LangChain's official `fakeModel()` helper.
 * The fake model exposes `.calls` and `.callCount` so plugin authors can
 * assert on the message trajectory, plus `.respondWithTools(...)` to script
 * tool-call sequences when needed.
 *
 * Docs: https://docs.langchain.com/oss/javascript/langchain/test/unit-testing
 */
export function mockLlm(opts: MockLlmOptions = {}): LlmAdapter {
  const responses =
    opts.respondWith === undefined
      ? ['ok']
      : Array.isArray(opts.respondWith)
        ? opts.respondWith
        : [opts.respondWith];
  return {
    get: () => {
      const m = fakeModel();
      for (const r of responses) m.respond(new AIMessage(r));
      return m;
    },
  };
}

/**
 * Build a `SecretsAdapter` whose `getValues` returns the supplied record
 * (filtered to the requested keys). `getIndex` reflects the same record as
 * `{ key: { key } }` entries.
 */
export function mockSecrets(
  record: Record<string, string> = {},
): SecretsAdapter {
  return {
    getIndex: async () => {
      const out: Record<string, { key: string }> = {};
      for (const k of Object.keys(record)) out[k] = { key: k };
      return out;
    },
    getValues: async (_roomId: string, keys: string[]) => {
      const out: Record<string, string> = {};
      for (const k of keys) {
        if (k in record) out[k] = record[k]!;
      }
      return out;
    },
  };
}

/** A no-op event sink that swallows every emit (record-only via `vi.fn`). */
export function mockEmit(): EmitAdapter {
  return { emit: vi.fn() };
}

/**
 * Build a `BlobStoreAdapter` backed by an in-memory Map. The same
 * user-DID-namespaced behaviour as `BlobStoreService` — cross-user reads
 * miss, malformed ids are rejected — without touching `cache-manager`.
 */
export function mockBlobStore(): BlobStoreAdapter {
  const ID_PATTERN = /^blob_[0-9a-f]{16}$/;
  const store = new Map<string, { name: string; value: string }>();
  let counter = 0;
  return {
    put: vi.fn(async ({ userDid, name, value }) => {
      if (!userDid) throw new Error('BlobStore.put: userDid is required');
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('BlobStore.put: value must be a non-empty string');
      }
      const id = `blob_${(counter++).toString(16).padStart(16, '0')}`;
      store.set(`blob:${userDid}:${id}`, { name, value });
      return id;
    }),
    get: vi.fn(async ({ userDid, blobId }) => {
      if (!userDid) return null;
      if (typeof blobId !== 'string' || !ID_PATTERN.test(blobId)) return null;
      return store.get(`blob:${userDid}:${blobId}`) ?? null;
    }),
    isValidBlobId: (value): value is string =>
      typeof value === 'string' && ID_PATTERN.test(value),
  };
}

/** A permissive UCAN adapter — every check passes; mintInvocation returns a stub cid. */
export function mockUcan(): UcanAdapter {
  return {
    hasCapability: vi.fn(() => true),
    requireCapability: vi.fn(),
    mintInvocation: vi.fn(async () => 'mock-invocation-cid'),
    resolveServiceDid: vi.fn(async () => 'did:web:example.com'),
    hasSigningKey: vi.fn(() => true),
    createInvocationFromDelegation: vi.fn(async () => ({
      invocation: 'mock-invocation-car',
    })),
    mintSelfSignedInvocation: vi.fn(async () => ({
      invocation: 'mock-invocation-car',
    })),
    getServiceDelegation: vi.fn(async () => ({
      error: 'no-delegation' as const,
    })),
  };
}

/** A no-op logger suitable for tests. */
export function mockLogger(): Logger {
  return {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

/** Public type re-export so authors can type their fetch handlers. */
export type FetchHandler = (
  url: string,
  init?: RequestInit,
) => unknown | Promise<unknown>;

/**
 * Overrides for `mockDomain`. Each maps onto the corresponding part of the
 * document rather than onto the built context, so a test cannot construct a
 * constitution the parser would have rejected.
 */
export interface MockDomainOptions {
  subject?: string;
  /** Mode ceiling. Defaults to the most permissive, so unrelated suites are unaffected. */
  mode?: 'read_only' | 'propose_only' | 'bounded_evaluate' | 'bounded_execute';
  /** Action classes that always need an explicit grant. Defaults to none. */
  baseline?: string[];
  /** Rights entries, verbatim as the document would carry them. */
  grants?: Array<Record<string, unknown>>;
  humanReviewRequiredFor?: string[];
  criticalDoNot?: string[];
  enforcement?: DomainEnforcement;
}

/**
 * A constitution for tests.
 *
 * Built by running a real document through the real parser rather than by
 * hand-assembling a `DomainContext`: a mock that skipped validation could
 * hold a shape no actual `domain.md` can produce, and every test resting on
 * it would be testing a fiction.
 *
 * The defaults are deliberately permissive — top mode ceiling, empty
 * baseline, no grants needed — so suites that have nothing to do with
 * authorization are not quietly rewritten into authorization tests. A test
 * that cares about the gate states what it needs.
 */
export function mockDomain(options: MockDomainOptions = {}): DomainContext {
  const subject = options.subject ?? 'did:ixo:entity:test-oracle';
  const frontmatter = {
    version: SUPPORTED_SPEC_VERSION,
    kind: 'domain.md',
    conformance: {
      spec_version: SUPPORTED_SPEC_VERSION,
      schema: SUPPORTED_SCHEMA_URI,
      profile: 'authoring_draft',
    },
    document_revision: '0.0.0-test',
    domain: {
      id: subject,
      iid: null,
      type: 'oracle',
      status: 'active',
      purpose: 'Test double.',
      operating_boundary: 'Tests only.',
    },
    constitution: {
      status: 'in_force',
      reason: null,
      subject,
      type: 'con:OracleConstitution',
    },
    agent_default_mode: {
      mode: options.mode ?? 'bounded_execute',
      overrides: {},
      human_review_required_for: options.humanReviewRequiredFor ?? [],
    },
    rights: {
      agent_baseline: { require_explicit_grant_for: options.baseline ?? [] },
      entries: options.grants ?? [],
    },
    critical_do_not: options.criticalDoNot ?? [],
  };

  return buildDomainContext({
    parsed: parseDomainMdSubset(
      `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# domain.md (test)\n`,
    ),
    enforcement: options.enforcement ?? 'permissive',
    source: '<mockDomain>',
  });
}
