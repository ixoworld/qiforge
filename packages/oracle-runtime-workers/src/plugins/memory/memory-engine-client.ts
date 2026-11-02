import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';
import { MEMORY_CAPABILITY } from '../delegated-capabilities';
import { mintInvocationSafely, resolveServiceDidSafely } from '../ucan-failure';
import { memoryEntityDid } from './memory-entity';

export type KnowledgeSpaceType = 'public' | 'private';

export interface MemoryEngineClientDeps {
  fetchImpl?: typeof fetch;
  /** Per-request timeout (default 30 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

let warnedMissingEntityDid = false;

/** Forget that the missing-entity warning was logged (tests only). */
export function resetMemoryEngineWarningsForTests(): void {
  warnedMissingEntityDid = false;
}

/**
 * The DID sent as `x-oracle-entity-did`: the configured `ORACLE_ENTITY_DID`
 * when it is a well-formed domain entity DID, never the `ORACLE_DID` fallback
 * (see the memory engine contract in docs/configuration.md). Logs once per
 * isolate when there is none.
 */
export function entityDidOrWarn(ctx: RuntimeContext): string | undefined {
  const did = memoryEntityDid(ctx.config.ORACLE_ENTITY_DID);
  if (did === undefined && !warnedMissingEntityDid) {
    warnedMissingEntityDid = true;
    ctx.logger.warn(
      "[memory] documents unavailable: set ORACLE_ENTITY_DID to the oracle's domain entity DID (did:ixo:entity:<32 hex digits>)",
    );
  }
  return did;
}

/**
 * An answer the Memory Engine refused (or a transport failure, `status` 0).
 * `message` never carries the response body or the bearer; the engine's own
 * `detail` is kept on the error so a tool can show it to the person, and is
 * never logged.
 */
export class MemoryEngineError extends Error {
  readonly status: number;

  readonly code?: string;

  readonly detail?: string;

  readonly retryable: boolean;

  readonly retryAfterSeconds?: number;

  /** Parts the engine had queued before it failed (`PARTIAL_QUEUE`). */
  readonly queued?: number;

  constructor(init: {
    status: number;
    code?: string;
    detail?: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    queued?: number;
  }) {
    super(
      `memory engine answered ${init.status}${init.code ? ` ${init.code}` : ''}`,
    );
    this.name = 'MemoryEngineError';
    this.status = init.status;
    if (init.code !== undefined) this.code = init.code;
    if (init.detail !== undefined) this.detail = init.detail;
    this.retryable = init.retryable ?? false;
    if (init.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = init.retryAfterSeconds;
    }
    if (init.queued !== undefined) this.queued = init.queued;
  }
}

export interface DocumentChunkInput {
  label?: string;
  content: string;
}

export interface AddDocumentRequest {
  knowledge_space_type: KnowledgeSpaceType;
  confirmed_insertion_from_user: true;
  /** Present for a grouped document, absent for loose knowledge. */
  document?: { id?: string; title: string; source_description?: string };
  if_exists?: 'replace' | 'fail';
  chunks: DocumentChunkInput[];
}

const documentStatusSchema = z.enum([
  'ingesting',
  'ready',
  'partial',
  'deleting',
  'delete_failed',
]);

const addDocumentResponseSchema = z.object({
  success: z.boolean().optional(),
  queued: z.number(),
  document: z
    .object({
      id: z.string(),
      generation: z.number(),
      chunk_count: z.number(),
      status: documentStatusSchema,
      replaced: z.boolean(),
      /** Chunks of the replaced generation still being removed. */
      retiring_chunks: z.number().optional(),
    })
    .optional(),
  chunk_ids: z.array(z.string()).optional(),
});
export type AddDocumentResponse = z.infer<typeof addDocumentResponseSchema>;

const documentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  source_description: z.string().nullable().optional(),
  generation: z.number(),
  chunk_count: z.number(),
  chunks_indexed: z.number(),
  retiring_chunks: z.number().optional(),
  status: documentStatusSchema,
  /** Why the last deletion failed (status `delete_failed`). */
  delete_error: z.string().nullable().optional(),
  created_by: z.string().nullable().optional(),
  updated_by: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

const listDocumentsResponseSchema = z.object({
  documents: z.array(documentSummarySchema),
});
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;

const documentViewSchema = documentSummarySchema.extend({
  chunks: z.array(z.unknown()).optional(),
});
export type DocumentView = z.infer<typeof documentViewSchema>;

const deleteDocumentResponseSchema = z.object({
  success: z.boolean().optional(),
  document: z.object({
    id: z.string(),
    status: documentStatusSchema,
    chunks: z.number(),
  }),
});
export type DeleteDocumentResponse = z.infer<
  typeof deleteDocumentResponseSchema
>;

export interface MemoryEngineClient {
  addDocument(body: AddDocumentRequest): Promise<AddDocumentResponse>;
  listDocuments(space: KnowledgeSpaceType): Promise<ListDocumentsResponse>;
  getDocument(id: string, space: KnowledgeSpaceType): Promise<DocumentView>;
  /** Deletion runs in the background; the answer says it was scheduled. */
  deleteDocument(
    id: string,
    space: KnowledgeSpaceType,
  ): Promise<DeleteDocumentResponse['document']>;
}

const configSchema = z.object({
  MEMORY_ENGINE_URL: z.string().url(),
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function detailText(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail.slice(0, 500);
  if (detail === undefined || detail === null) return undefined;
  try {
    return JSON.stringify(detail).slice(0, 500);
  } catch {
    return undefined;
  }
}

const errorBodySchema = z.object({
  code: z.string().optional(),
  detail: z.unknown().optional(),
  retryable: z.boolean().optional(),
  queued: z.number().optional(),
});

async function toEngineError(res: Response): Promise<MemoryEngineError> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    raw = undefined;
  }
  const body = errorBodySchema.safeParse(raw);
  const parsed = body.success ? body.data : {};
  const detail = detailText(parsed.detail);
  const retryAfterSeconds = parseRetryAfter(res);
  return new MemoryEngineError({
    status: res.status,
    ...(parsed.code !== undefined ? { code: parsed.code } : {}),
    ...(detail !== undefined ? { detail } : {}),
    retryable: parsed.retryable === true,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(parsed.queued !== undefined ? { queued: parsed.queued } : {}),
  });
}

/**
 * A client for the Memory Engine's document routes, authenticated as the
 * current user (UCAN invocation minted once per client) and as the oracle's
 * entity (`x-oracle-entity-did`). Returns `null`, after logging why, when the
 * engine URL, the entity DID or an invocation is unavailable; a tool then tells
 * the model the engine is not reachable.
 */
export async function createMemoryEngineClient(
  ctx: RuntimeContext,
  deps: MemoryEngineClientDeps = {},
): Promise<MemoryEngineClient | null> {
  const config = configSchema.safeParse(ctx.config);
  if (!config.success) {
    ctx.logger.warn(
      '[memory] documents unavailable: MEMORY_ENGINE_URL missing',
    );
    return null;
  }
  const engineUrl = config.data.MEMORY_ENGINE_URL.replace(/\/+$/, '');
  const entityDid = entityDidOrWarn(ctx);
  if (!entityDid) return null;

  const serviceDid = await resolveServiceDidSafely(ctx, engineUrl, 'memory');
  if (!serviceDid) return null;
  const invocation = await mintInvocationSafely(
    ctx,
    { did: serviceDid, capability: MEMORY_CAPABILITY.resource },
    'memory',
    { can: MEMORY_CAPABILITY.action },
  );
  if (!invocation) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${invocation}`,
    'X-Auth-Type': 'ucan',
    'x-oracle-entity-did': entityDid,
  };
  if (ctx.session.roomId) headers['x-room-id'] = ctx.session.roomId;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${engineUrl}${path}`, {
        method,
        headers:
          body === undefined
            ? headers
            : { ...headers, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          ctx.abortSignal,
          AbortSignal.timeout(timeoutMs),
        ]),
      });
    } catch (error) {
      // A cancelled turn is not an engine failure.
      if (ctx.abortSignal.aborted) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new MemoryEngineError({
        status: 0,
        code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        detail: timedOut
          ? `no answer within ${timeoutMs} ms`
          : describe(error).slice(0, 200),
        retryable: true,
      });
    }
    if (!res.ok) throw await toEngineError(res);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new MemoryEngineError({
        status: res.status,
        code: 'MALFORMED_RESPONSE',
        detail: 'the answer was not valid JSON',
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new MemoryEngineError({
        status: res.status,
        code: 'MALFORMED_RESPONSE',
        detail: 'the answer did not have the expected shape',
      });
    }
    return parsed.data;
  }

  const spaceQuery = (space: KnowledgeSpaceType): string =>
    `knowledge_space_type=${space}`;

  return {
    addDocument: (body) =>
      request('POST', '/knowledge/documents', addDocumentResponseSchema, body),
    listDocuments: (space) =>
      request(
        'GET',
        `/knowledge/documents?${spaceQuery(space)}`,
        listDocumentsResponseSchema,
      ),
    getDocument: (id, space) =>
      request(
        'GET',
        `/knowledge/documents/${encodeURIComponent(id)}?${spaceQuery(space)}`,
        documentViewSchema,
      ),
    deleteDocument: async (id, space) => {
      const out = await request(
        'DELETE',
        `/knowledge/documents/${encodeURIComponent(id)}?${spaceQuery(space)}`,
        deleteDocumentResponseSchema,
      );
      return out.document;
    },
  };
}
