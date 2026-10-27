import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import {
  chunkDocument,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_CHUNKS,
} from './document-chunker';
import { loadDocumentText } from './document-source';
import {
  createMemoryEngineClient,
  entityDidOrWarn,
  MemoryEngineError,
  type AddDocumentRequest,
  type DocumentSummary,
  type MemoryEngineClient,
} from './memory-engine-client';

export const ADD_ORACLE_DOCUMENT_TOOL_NAME = 'add_oracle_document';
export const LIST_ORACLE_DOCUMENTS_TOOL_NAME = 'list_oracle_documents';
export const DELETE_ORACLE_DOCUMENT_TOOL_NAME = 'delete_oracle_document';

/** The engine refuses one document whose chunks total more than this (bytes). */
export const ENGINE_DOCUMENT_TOTAL_BYTES = 900_000;

export interface OracleDocumentToolsDeps {
  fetchImpl?: typeof fetch;
}

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const spaceSchema = z
  .enum(['public', 'private'])
  .describe(
    "Which knowledge space: 'public' is shared with every user of this oracle; 'private' is visible only to the domain's members (its controllers, owner, admins and DAO members).",
  );

const sourceSchema = z
  .object({
    kind: z
      .enum(['attachment', 'vfs'])
      .describe(
        "'attachment' for a file the person attached in this conversation, 'vfs' for a file in their Library.",
      ),
    ref: z
      .string()
      .min(1)
      .describe(
        'For kind attachment: the value inside the `[source: eventId="…"]` (or `[source: url="…"]`) line that accompanies the attached file, passed exactly as given (an event id such as "$abc…" or an mxc:// URL). For kind vfs: the file path in the Library, for example /private/policies/travel.pdf.',
      ),
  })
  .strict()
  .describe('Where the file is.');

export const addOracleDocumentSchema = z
  .object({
    source: sourceSchema,
    title: z
      .string()
      .min(1)
      .max(200)
      .describe('A short human title for the document, 1 to 200 characters.'),
    knowledge_space_type: spaceSchema,
    group_as_document: z
      .boolean()
      .describe(
        'Required, no default. true: the file is ONE coherent record and is kept together under a document id (it can be listed and removed as one). false: the file is a collection of unrelated facts and each part is stored as ordinary loose knowledge with no document grouping. Decide with the person, see the tool description.',
      ),
    document_id: z
      .string()
      .regex(DOCUMENT_ID_PATTERN)
      .optional()
      .describe(
        "Only with group_as_document true (ignored otherwise). A stable id such as 'board-resolution-2026-10' (letters, digits, '.', '_' and '-', up to 120 characters, starting with a letter or digit). Adding a document with an id that already exists replaces it. Leave out and the tool derives one from the title and the content, so adding the same file again replaces it.",
      ),
    source_description: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Only with group_as_document true (ignored otherwise). One line saying where the document comes from, up to 500 characters (for example 'Signed PDF from the board secretary, 12 Oct 2026').",
      ),
    if_exists: z
      .enum(['replace', 'fail'])
      .optional()
      .describe(
        "Only with group_as_document true (ignored otherwise). 'replace' (default) overwrites a grouped document with the same document_id; 'fail' refuses instead.",
      ),
    allow_truncation: z
      .boolean()
      .optional()
      .describe(
        'Default false. When the file is larger than the limits the tool refuses and tells you the size. Set true only after the person agreed that the first part of the file is enough.',
      ),
    confirmed_insertion_from_user: z
      .boolean()
      .describe(
        'true only when the person has explicitly asked you to store this file as oracle knowledge after you told them who will be able to see it. Otherwise ask first.',
      ),
  })
  .strict();

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

export const listOracleDocumentsSchema = z
  .object({
    knowledge_space_type: spaceSchema,
    status: z
      .enum(['ingesting', 'ready', 'partial', 'deleting', 'delete_failed'])
      .optional()
      .describe('Only list documents in this status. Leave out for all.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIST_LIMIT)
      .optional()
      .describe(
        `Most documents to list, 1 to ${MAX_LIST_LIMIT} (default ${DEFAULT_LIST_LIMIT}).`,
      ),
  })
  .strict();

export const deleteOracleDocumentSchema = z
  .object({
    document_id: z
      .string()
      .regex(DOCUMENT_ID_PATTERN)
      .describe(
        'The id of a grouped document, as shown by list_oracle_documents.',
      ),
    knowledge_space_type: spaceSchema,
    confirmed_deletion_from_user: z
      .boolean()
      .describe(
        'true only when the person has explicitly asked you to remove this document after you told them it will be deleted for everyone who can see that space.',
      ),
  })
  .strict();

export const ADD_ORACLE_DOCUMENT_DESCRIPTION = [
  "Use this, not memory-engine__add_oracle_knowledge, whenever the knowledge comes from a file: one the person attached or one in their Library, even when the file's text is visible in the conversation. Store that file as this oracle's domain knowledge. For an attachment, set source to kind 'attachment' and ref to the value inside the `[source: eventId=…]` (or `[source: url=…]`) line that accompanies the attached file: pass that eventId or mxc URL as ref. For a Library file, kind 'vfs' and ref the path. The text is read out of the file, split into parts and written to the public or private knowledge space of this oracle. Only a controller, owner, admin or DAO member of the domain can do this; the memory engine checks and refuses anyone else.",
  '',
  'Decide with group_as_document, which is required and has no default:',
  '- true: the file is ONE coherent record that belongs together, such as a board resolution, a contract or a report. It is stored under one document id, so it can be listed with list_oracle_documents, replaced by adding it again with the same document_id, and removed as one with delete_oracle_document.',
  '- false: the file is a place where someone dumped many unrelated company facts to upload them easily (for example a notes file with the office address, the refund rule, the CEO name and the opening hours). Each part is stored as an ordinary knowledge fact with no document grouping. Loose facts cannot be listed as a document or removed as a group; they are found by search and removed one by one with delete_episode.',
  '',
  'If it is not obvious which one the file is, ask the person before you call this tool. Say what you found in the file in one sentence and offer the two options in plain words. Never pick one silently when the file could be either.',
  '',
  'Always confirm first: tell the person whether the public space (every user of this oracle) or the private space (the members of the domain only: controllers, owner, admins and DAO members) will hold the content, and set confirmed_insertion_from_user to true only after they say yes. Do not store files the person did not ask you to store.',
  '',
  'Limits: a text file or a PDF with a text layer up to 25 MB; a scanned PDF, an image or an Office file (read by a helper model) up to 10 MB. Text is split into parts of about 12 KB, at most 64 parts (about 750 KB of text, the memory engine accepts 900 KB per document). A larger file is refused with its size unless allow_truncation is true, which keeps only the first part of the file; use that only if the person agrees. Without a document_id a grouped document gets one derived from the title and content, so repeating the call after a timeout replaces rather than duplicates; the result reports the id.',
  'The result says how many parts were queued. Indexing continues in the background; for a grouped document list_oracle_documents shows the status (ingesting, ready, partial, deleting or delete_failed).',
].join('\n');

export const LIST_ORACLE_DOCUMENTS_DESCRIPTION =
  "List the grouped documents in one of this oracle's knowledge spaces with their id, title, status (ingesting, ready, partial, deleting or delete_failed) and number of parts. Optional status filter and limit (default 100, at most 500). Loose facts stored with group_as_document false are not listed here; they are ordinary knowledge found by search.";

export const DELETE_ORACLE_DOCUMENT_DESCRIPTION =
  'Remove a grouped document and every one of its parts from the public or private knowledge space of this oracle. Use the id from list_oracle_documents. This cannot be undone and it takes effect for everyone who can see that space, so tell the person which document will go and set confirmed_deletion_from_user to true only after they say yes. Loose facts are not documents; remove those with delete_episode. The removal runs in the background; if list_oracle_documents later shows the document as delete_failed, call this again to retry it.';

const NO_ENGINE_MESSAGE =
  'Memory engine is not reachable from this oracle (missing MEMORY_ENGINE_URL or signing key).';

const knobsSchema = z.object({
  MEMORY_DOCUMENT_CHUNK_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16_384)
    .default(DEFAULT_CHUNK_BYTES),
  MEMORY_DOCUMENT_MAX_CHUNKS: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MAX_CHUNKS),
  MEMORY_DOCUMENT_MAX_CHARS: z.coerce.number().int().min(1_000).optional(),
});

export interface DocumentKnobs {
  chunkBytes: number;
  maxChunks: number;
  /** Most characters read from one file. */
  maxChars: number;
}

let warnedInvalid = false;
let warnedClamp = false;

/** Forget that the knob warnings were logged (tests only). */
export function resetDocumentKnobWarningsForTests(): void {
  warnedInvalid = false;
  warnedClamp = false;
}

/**
 * The effective limits. `chunkBytes × maxChunks` never exceeds the engine's
 * 900 KB per-document cap (the part count is clamped, with one warning per
 * isolate), and the character cap defaults to that product so the reader,
 * the chunker and the engine agree on one limit.
 */
export function readKnobs(ctx: RuntimeContext): DocumentKnobs {
  const parsed = knobsSchema.safeParse({
    MEMORY_DOCUMENT_CHUNK_BYTES: ctx.config.MEMORY_DOCUMENT_CHUNK_BYTES,
    MEMORY_DOCUMENT_MAX_CHUNKS: ctx.config.MEMORY_DOCUMENT_MAX_CHUNKS,
    MEMORY_DOCUMENT_MAX_CHARS: ctx.config.MEMORY_DOCUMENT_MAX_CHARS,
  });
  const knobs = parsed.success ? parsed.data : knobsSchema.parse({});
  if (!parsed.success && !warnedInvalid) {
    warnedInvalid = true;
    ctx.logger.warn(
      '[memory] invalid MEMORY_DOCUMENT_* setting; using the defaults',
    );
  }
  const chunkBytes = knobs.MEMORY_DOCUMENT_CHUNK_BYTES;
  let maxChunks = knobs.MEMORY_DOCUMENT_MAX_CHUNKS;
  if (chunkBytes * maxChunks > ENGINE_DOCUMENT_TOTAL_BYTES) {
    maxChunks = Math.floor(ENGINE_DOCUMENT_TOTAL_BYTES / chunkBytes);
    if (!warnedClamp) {
      warnedClamp = true;
      ctx.logger.warn(
        `[memory] MEMORY_DOCUMENT_CHUNK_BYTES × MEMORY_DOCUMENT_MAX_CHUNKS exceeds the engine's ${ENGINE_DOCUMENT_TOTAL_BYTES}-byte document cap; using ${maxChunks} parts`,
      );
    }
  }
  return {
    chunkBytes,
    maxChunks,
    maxChars: knobs.MEMORY_DOCUMENT_MAX_CHARS ?? chunkBytes * maxChunks,
  };
}

function retryNote(err: MemoryEngineError): string {
  return err.retryAfterSeconds !== undefined
    ? ` Retry in about ${err.retryAfterSeconds} s.`
    : '';
}

/** What the failed call was doing, so a retry hint can be right for it. */
export interface ErrorContext {
  /** `grouped` writes replace on a repeat call, `loose` writes do not. */
  mode?: 'grouped' | 'loose';
  /** The id of the grouped document being written. */
  documentId?: string;
}

const ENTITY_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENTITY_HEADER_MISSING',
  'ENTITY_HEADER_INVALID',
  'ENTITY_NOT_VOUCHED',
  'ENTITY_UNVERIFIED',
]);

function describeEntityError(err: MemoryEngineError): string {
  switch (err.code) {
    case 'ENTITY_HEADER_MISSING':
    case 'ENTITY_HEADER_INVALID':
      return "The memory engine did not accept the oracle entity DID this oracle sent. This is a setup problem for the operator: ORACLE_ENTITY_DID must be the oracle's domain entity DID (did:ixo:entity:<32 hex digits>). Nothing was written.";
    case 'ENTITY_NOT_VOUCHED':
      return "The memory engine does not know this oracle's domain entity as an oracle it serves. This is a setup problem for the operator: the domain entity's on-chain document must list this oracle's account as a linked entity with service matrix and relationship admin. Nothing was written.";
    default:
      return "The memory engine could not verify this oracle's domain entity right now. This is usually temporary; try again shortly. Nothing was written.";
  }
}

function describeTimeout(ctx: ErrorContext): string {
  if (ctx.mode === 'grouped') {
    return `The memory engine did not answer in time, so the write may or may not have happened. Call add_oracle_document again with the same document_id${ctx.documentId ? ` ("${ctx.documentId}")` : ''}: it replaces the document, so nothing is duplicated.`;
  }
  if (ctx.mode === 'loose') {
    return 'The memory engine did not answer in time, so some or all of the parts may have been stored. Do not retry the write: search for the content to see what landed.';
  }
  return 'The memory engine did not answer in time. Try again in a moment.';
}

function describePartialQueue(
  err: MemoryEngineError,
  ctx: ErrorContext,
): string {
  const stored =
    err.queued !== undefined
      ? `${err.queued} part(s) were stored before the engine stopped.`
      : 'Some parts were stored before the engine stopped.';
  if (ctx.mode === 'grouped') {
    return `${stored} Call add_oracle_document again with the same document_id${ctx.documentId ? ` ("${ctx.documentId}")` : ''} to replace the document with a complete one.`;
  }
  return `${stored} Do NOT retry: the stored parts are already there as loose knowledge and a second call would duplicate them.`;
}

/** The agent-facing sentence for a refusal from the engine. */
export function describeEngineError(
  err: MemoryEngineError,
  ctx: ErrorContext = {},
): string {
  if (err.code !== undefined && ENTITY_ERROR_CODES.has(err.code)) {
    return describeEntityError(err);
  }
  switch (err.code) {
    case 'DOMAIN_ACCESS_DENIED':
      return 'The memory engine refused: this person is not a controller, owner, admin or DAO member of this domain, so they cannot change its knowledge.';
    case 'DOCUMENT_EXISTS':
      return "A document with that id already exists and if_exists is 'fail'. Choose another document_id or use if_exists 'replace'.";
    case 'DOCUMENT_NOT_FOUND':
      return 'No document with that id exists in that knowledge space. Check the id with list_oracle_documents.';
    case 'DOCUMENT_INGESTING':
      return 'That document is still being processed. Try again in about 10 s.';
    case 'DOCUMENT_TOO_LARGE':
      return `The memory engine refused: the document is too large in total${err.detail ? ` (${err.detail})` : ''}. Nothing was written. Split the file into smaller files, or store fewer or shorter parts.`;
    case 'DOCUMENT_LIMIT':
      return 'This knowledge space already holds the most documents the memory engine allows. Ask the person to delete old documents (list_oracle_documents shows them) before adding another.';
    case 'DOCUMENT_BACKLOG':
      return `The memory engine is busy ingesting documents.${err.retryAfterSeconds !== undefined ? retryNote(err) : ' Try again in about a minute.'}`;
    case 'EPISODE_TOO_LARGE':
      return 'The memory engine refused: a part of the document is larger than it accepts. Ask the operator to lower MEMORY_DOCUMENT_CHUNK_BYTES.';
    case 'CONFIRMATION_REQUIRED':
      return 'The memory engine refused: the person has not confirmed this write.';
    case 'QUEUE_FULL':
      return `The memory engine is busy and its queue is full.${retryNote(err)}`;
    case 'BUDGET_EXCEEDED':
      return `The memory engine refused: this person's daily memory write budget is used up.${retryNote(err)}`;
    case 'USER_RATE_LIMITED':
      return `The memory engine is limiting how often this person can write.${retryNote(err)}`;
    case 'PARTIAL_QUEUE':
      return describePartialQueue(err, ctx);
    case 'TIMEOUT':
      return describeTimeout(ctx);
    case 'NETWORK_ERROR':
      return 'The memory engine could not be reached.';
    default: {
      if (err.status === 413) {
        return 'The memory engine refused: a part of the document is larger than it accepts. Ask the operator to lower MEMORY_DOCUMENT_CHUNK_BYTES.';
      }
      const what = err.code ?? `status ${err.status}`;
      const detail = err.detail ? ` — ${err.detail}` : '';
      return `The memory engine refused: ${what}${detail}.${retryNote(err)}`;
    }
  }
}

/**
 * Run a tool body: a refusal from the engine becomes the agent-facing string,
 * a cancelled turn propagates, any other failure is logged and reported
 * without its message.
 */
async function guard(
  ctx: RuntimeContext,
  errorContext: () => ErrorContext,
  fn: () => Promise<string>,
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MemoryEngineError) {
      if (err.code !== undefined && ENTITY_ERROR_CODES.has(err.code)) {
        ctx.logger.warn(
          `[memory] the engine rejected this oracle's entity: ${err.code}`,
        );
      }
      return describeEngineError(err, errorContext());
    }
    if (ctx.abortSignal.aborted) throw err;
    ctx.logger.warn(
      `[memory] document tool failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'The document request failed unexpectedly.';
  }
}

/** Loose chunks have no document to name them, so the label carries the title. */
function looseLabel(title: string, label: string): string {
  return `${title} — ${label}`.slice(0, 120);
}

function formatDocumentRow(doc: DocumentSummary): string {
  const updated = doc.updated_at ?? doc.created_at ?? 'unknown';
  const retiring = doc.retiring_chunks
    ? ` (${doc.retiring_chunks} old chunks being removed)`
    : '';
  const failure =
    doc.status === 'delete_failed' && doc.delete_error
      ? `: ${doc.delete_error}`
      : '';
  return `${doc.id} | ${doc.title} | ${doc.status}${failure}${retiring} | ${doc.chunks_indexed}/${doc.chunk_count} parts indexed | updated ${updated}`;
}

const NO_ENTITY_MESSAGE =
  'This oracle is not configured for domain documents (ORACLE_ENTITY_DID missing).';

async function withClient(
  ctx: RuntimeContext,
  deps: OracleDocumentToolsDeps,
  fn: (client: MemoryEngineClient) => Promise<string>,
): Promise<string> {
  if (entityDidOrWarn(ctx) === undefined) return NO_ENTITY_MESSAGE;
  const client = await createMemoryEngineClient(ctx, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!client) return NO_ENGINE_MESSAGE;
  return fn(client);
}

/**
 * Before reading a file (or deleting), ask the engine for the private list: it
 * needs the same domain access as a write, so a person without it is stopped
 * before any download, parse or helper-model call. Only an access or entity
 * refusal stops the call; anything else is left for the write to report.
 */
async function precheckAccess(
  client: MemoryEngineClient,
  ctx: RuntimeContext,
): Promise<void> {
  try {
    await client.listDocuments('private');
  } catch (err) {
    if (
      err instanceof MemoryEngineError &&
      (err.status === 400 || err.status === 403)
    ) {
      throw err;
    }
    if (ctx.abortSignal.aborted) throw err;
    ctx.logger.debug?.('[memory] document access pre-check was inconclusive');
  }
}

/** `slug(title)` for a derived document id: lowercase `[a-z0-9.-]`, at most 80 characters. */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/g, '');
  return slug || 'document';
}

async function sha256Hex8(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest).subarray(0, 4), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * The id a grouped document gets when the caller gives none: the title slug and
 * the first 8 hex digits of the SHA-256 of the part contents. The same file
 * added again (a retry after a timeout) lands on the same id and replaces
 * instead of duplicating.
 */
export async function deriveDocumentId(
  title: string,
  contents: readonly string[],
): Promise<string> {
  return `${slugifyTitle(title)}-${await sha256Hex8(contents.join('\u0000'))}`;
}

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function addDocument(
  rawArgs: unknown,
  ctx: RuntimeContext,
  deps: OracleDocumentToolsDeps,
): Promise<string> {
  // The agent runtime validates the arguments against the schema before the
  // handler runs; this parse only types them.
  const args = addOracleDocumentSchema.parse(rawArgs);

  // Checks the schema cannot express.
  if (args.source.kind === 'vfs' && !args.source.ref.startsWith('/')) {
    return 'Invalid arguments — source.ref for kind vfs must be an absolute Library path starting with "/".';
  }
  if (args.source.kind === 'attachment' && args.source.ref.startsWith('/')) {
    return 'Invalid arguments — source.ref looks like a Library path; use kind vfs for a Library file, or pass the eventId or mxc URL for an attachment.';
  }
  if (args.confirmed_insertion_from_user !== true) {
    return `Confirmation required: tell the person that this file will be stored in the ${args.knowledge_space_type} knowledge space of this oracle (${args.knowledge_space_type === 'public' ? 'visible to every user of the oracle' : "visible to the domain's members only: its controllers, owner, admins and DAO members"}), ask whether they want that, and call again with confirmed_insertion_from_user true once they say yes.`;
  }

  const errorContext: ErrorContext = {
    mode: args.group_as_document ? 'grouped' : 'loose',
    ...(args.document_id ? { documentId: args.document_id } : {}),
  };
  return guard(
    ctx,
    () => errorContext,
    () =>
      withClient(ctx, deps, async (client) => {
        await precheckAccess(client, ctx);

        const knobs = readKnobs(ctx);
        const source =
          args.source.kind === 'attachment'
            ? { attachment_ref: args.source.ref }
            : { vfs_path: args.source.ref };
        let loaded;
        try {
          loaded = await loadDocumentText(ctx, source, {
            maxChars: knobs.maxChars,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        } catch (err) {
          if (ctx.abortSignal.aborted) throw err;
          return `Could not read the file: ${err instanceof Error ? err.message : String(err)}`;
        }

        const chunked = chunkDocument(loaded.text, {
          maxChunkBytes: knobs.chunkBytes,
          maxChunks: knobs.maxChunks,
        });
        if (chunked.chunks.length === 0) {
          return `Nothing to store: no text could be read from "${loaded.filename}".`;
        }
        const truncated = loaded.truncated || chunked.truncated;
        if (truncated && args.allow_truncation !== true) {
          return `The file "${loaded.filename}" (${kb(loaded.bytes)}) is too large to store whole: ${loaded.truncated ? `reading stopped at ${knobs.maxChars} characters` : `its text is about ${kb(chunked.totalBytes)}`}, and at most ${knobs.maxChunks} parts of ${kb(knobs.chunkBytes)} (${kb(knobs.maxChunks * knobs.chunkBytes)} in all) can be stored. Nothing was written. Ask the person whether the first ${chunked.chunks.length} parts are enough (then call again with allow_truncation true) or whether to split the file.`;
        }

        const body: AddDocumentRequest = {
          knowledge_space_type: args.knowledge_space_type,
          confirmed_insertion_from_user: true,
          chunks: chunked.chunks.map((c) => ({
            label: args.group_as_document
              ? c.label
              : looseLabel(args.title, c.label),
            content: c.content,
          })),
        };
        let derivedId = false;
        if (args.group_as_document) {
          let id = args.document_id;
          if (id === undefined) {
            id = await deriveDocumentId(
              args.title,
              chunked.chunks.map((c) => c.content),
            );
            derivedId = true;
          }
          errorContext.documentId = id;
          body.document = {
            id,
            title: args.title,
            ...(args.source_description
              ? { source_description: args.source_description }
              : {}),
          };
          body.if_exists = args.if_exists ?? 'replace';
        }

        ctx.logger.debug?.(
          `[memory] adding ${args.group_as_document ? 'grouped' : 'loose'} document: ${chunked.chunks.length} chunks, method=${loaded.method}`,
        );
        const res = await client.addDocument(body);

        if (res.document) {
          return JSON.stringify({
            document_id: res.document.id,
            ...(derivedId ? { document_id_derived: true } : {}),
            generation: res.document.generation,
            chunks: res.document.chunk_count,
            status: res.document.status,
            replaced: res.document.replaced,
            ...(res.document.retiring_chunks
              ? { retiring_chunks: res.document.retiring_chunks }
              : {}),
            method: loaded.method,
            truncated,
            note: 'Indexing continues in the background; list_oracle_documents shows the status.',
          });
        }
        const ignored = [
          args.document_id !== undefined ? 'document_id' : undefined,
          args.if_exists !== undefined ? 'if_exists' : undefined,
          args.source_description !== undefined
            ? 'source_description'
            : undefined,
        ].filter((name): name is string => name !== undefined);
        return JSON.stringify({
          queued: res.queued,
          chunk_ids_count: res.chunk_ids?.length ?? res.queued,
          method: loaded.method,
          truncated,
          ...(ignored.length > 0 ? { ignored_in_loose_mode: ignored } : {}),
          note: 'Stored as loose knowledge; it is found by search and has no document to list.',
        });
      }),
  );
}

async function listDocuments(
  rawArgs: unknown,
  ctx: RuntimeContext,
  deps: OracleDocumentToolsDeps,
): Promise<string> {
  const args = listOracleDocumentsSchema.parse(rawArgs);
  const space = args.knowledge_space_type;
  const limit = args.limit ?? DEFAULT_LIST_LIMIT;
  return guard(
    ctx,
    () => ({}),
    () =>
      withClient(ctx, deps, async (client) => {
        const { documents } = await client.listDocuments(space);
        const matching = args.status
          ? documents.filter((d) => d.status === args.status)
          : documents;
        const filter = args.status ? ` with status ${args.status}` : '';
        if (matching.length === 0) {
          return `No grouped documents${filter} in the ${space} knowledge space.`;
        }
        const shown = matching.slice(0, limit);
        const count =
          shown.length < matching.length
            ? `${shown.length} of ${matching.length} document(s)`
            : `${matching.length} document(s)`;
        return [
          `${count}${filter} in the ${space} knowledge space (id | title | status | parts | updated):`,
          ...shown.map(formatDocumentRow),
        ].join('\n');
      }),
  );
}

async function deleteDocument(
  rawArgs: unknown,
  ctx: RuntimeContext,
  deps: OracleDocumentToolsDeps,
): Promise<string> {
  const args = deleteOracleDocumentSchema.parse(rawArgs);
  if (args.confirmed_deletion_from_user !== true) {
    return `Confirmation required: tell the person that document "${args.document_id}" will be removed from the ${args.knowledge_space_type} knowledge space for everyone who can see it, ask whether they want that, and call again with confirmed_deletion_from_user true once they say yes.`;
  }
  return guard(
    ctx,
    () => ({}),
    () =>
      withClient(ctx, deps, async (client) => {
        await precheckAccess(client, ctx);
        const out = await client.deleteDocument(
          args.document_id,
          args.knowledge_space_type,
        );
        return `Deletion scheduled for document "${args.document_id}" (${out.chunks} chunks) in the ${args.knowledge_space_type} knowledge space; it is removed in the background.`;
      }),
  );
}

export function createOracleDocumentTools(
  deps: OracleDocumentToolsDeps = {},
): PluginTool[] {
  return [
    tool((args, ctx) => addDocument(args, ctx, deps), {
      name: ADD_ORACLE_DOCUMENT_TOOL_NAME,
      description: ADD_ORACLE_DOCUMENT_DESCRIPTION,
      schema: addOracleDocumentSchema,
      repeatable: false,
    }),
    tool((args, ctx) => listDocuments(args, ctx, deps), {
      name: LIST_ORACLE_DOCUMENTS_TOOL_NAME,
      description: LIST_ORACLE_DOCUMENTS_DESCRIPTION,
      schema: listOracleDocumentsSchema,
      effect: 'read',
    }),
    tool((args, ctx) => deleteDocument(args, ctx, deps), {
      name: DELETE_ORACLE_DOCUMENT_TOOL_NAME,
      description: DELETE_ORACLE_DOCUMENT_DESCRIPTION,
      schema: deleteOracleDocumentSchema,
      repeatable: false,
    }),
  ];
}
