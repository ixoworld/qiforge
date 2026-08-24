import type { Readable } from 'node:stream';
import {
  VfsAuthError,
  VfsHttpError,
  type VfsAbility,
  type VfsAuthErrorKind,
} from './vfs-errors.js';
import { nodeToWebStream, webToNodeStream } from './vfs-streams.js';

/**
 * Typed HTTP client for the IXO Virtual Filesystem worker (routes under
 * `/api/fs/*`).
 *
 * Every method maps to exactly ONE worker endpoint and parses that endpoint's
 * documented response shape (the worker's `src/schemas/fs.ts`): `/tree` →
 * `{ nodes }`, `/glob` → `{ files }`, `/search` → `{ hits }`, `/grep` →
 * `{ matches }`, `/files/:id/read` → `{ text, offset, count, … }`, batch ops →
 * `{ results, succeeded, failed }`. No field-name guessing — if the worker
 * contract changes, exactly one parser here changes with it.
 *
 * Per request the client mints a fresh single-use UCAN bearer, applies a
 * per-request timeout layered on the caller's abort signal, and maps every
 * non-2xx to a typed {@link VfsHttpError}. Retries match the worker's
 * idempotency + replay rules:
 *   - idempotent GETs: one retry on 429 / 5xx / network error;
 *   - any request: one retry on 401 (re-mint a fresh bearer);
 *   - 409 write-conflict retries live in the tool layer, not here.
 */

/** Mints a bearer for an ability. Returns an auth error instead of throwing. */
export type VfsMintFn = (
  ability: VfsAbility,
) => Promise<{ bearer: string } | { error: VfsAuthErrorKind; detail?: string }>;

export interface VfsClientOptions {
  /** Worker file-API base, e.g. `https://devnet.vfs.ixo.earth/api/fs`. */
  baseUrl: string;
  mint: VfsMintFn;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Fixed backoff before the one permitted retry. Default 250ms. */
  retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Result shapes (a faithful subset of the worker schemas — only the fields the
// oracle's tools consume).
// ---------------------------------------------------------------------------

/** A file's identity + display metadata (worker `FileMetadata`). */
export interface VfsFileStat {
  id: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  /** Anyone-can-download link, present only when the file is public. */
  publicUrl?: string;
  /** Content id, when the worker sends one. */
  cid?: string;
}

/** One entry in a directory listing (worker `TreeNode`). */
export interface VfsTreeEntry {
  path: string;
  name: string;
  type: 'file' | 'folder';
  id?: string;
  mimeType?: string;
  size?: number;
}

/** One search/grep hit, normalised across `/search` and `/grep`. */
export interface VfsSearchHit {
  path: string;
  /** `/search` returns `fileId`; `/grep` returns `id`. */
  id?: string;
  /** 1-based cited line range (search hits) — pairs with {@link readLines}. */
  lineStart?: number;
  lineEnd?: number;
  /** Highlighted snippet: `/search` `preview` or `/grep` `snippet`. */
  snippet?: string;
  score?: number;
}

export interface VfsSearchResult {
  results: VfsSearchHit[];
  /** `false` when the semantic engine was down and only lexical hits returned. */
  semantic: boolean;
}

/** A glob match (worker `GlobResult.files[]`). */
export interface VfsGlobMatch {
  path: string;
  id?: string;
}

/** A window of a text file's contents (worker `ReadResult`). */
export interface VfsReadWindow {
  /** Server-rendered numbered text (cat -n style), ready to display as-is. */
  text: string;
  /** 1-based line number of the first line in this window. */
  offset: number;
  /** Number of lines in this window. */
  count: number;
  hasMore: boolean;
  totalLines: number;
}

export interface VfsContentBytes {
  bytes: ArrayBuffer;
  mimeType: string;
  size: number;
}

/** A re-openable streamed request body: `open` is called per attempt (401 re-mint retries replay it). */
export interface VfsStreamBody {
  open: () => Readable;
  sizeBytes: number;
  mime: string;
}

export interface VfsContentStream {
  stream: Readable;
  sizeBytes?: number;
  /** Worker-computed content hash (`x-vfs-content-hash`), when sent. */
  contentHash?: string;
  /** Content id (`x-vfs-cid`), when sent. */
  cid?: string;
  mimeType: string;
}

/** One item's outcome in a batch move/delete (worker `BatchResult.results[]`). */
export interface VfsBatchItemResult {
  id: string;
  ok: boolean;
  status: number;
  path?: string;
  error?: string;
}

export interface VfsPublicResult {
  public: boolean;
  publicUrl?: string;
}

export interface VfsEditResult {
  replacements?: number;
}

// ---------------------------------------------------------------------------
// Defensive JSON access (type-guard based — no assertions).
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** The array under `key`, or `[]` when absent/not an array. */
function arrayAt(body: unknown, key: string): unknown[] {
  if (isRecord(body) && Array.isArray(body[key])) return body[key];
  return [];
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// ---------------------------------------------------------------------------
// Response parsers (each pinned to one worker schema).
// ---------------------------------------------------------------------------

/** Worker `FileMetadata` → {@link VfsFileStat}. Returns null without an id. */
function parseFile(v: unknown, fallbackPath?: string): VfsFileStat | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  const path = str(v.path) ?? fallbackPath ?? '';
  return {
    id,
    path,
    name: str(v.name) ?? basename(path),
    mimeType: str(v.mimeType) ?? '',
    size: num(v.size) ?? 0,
    publicUrl: str(v.publicUrl),
    cid: str(v.cid),
  };
}

/** Worker `TreeNode` → {@link VfsTreeEntry}. */
function parseTreeEntry(v: unknown): VfsTreeEntry | null {
  if (!isRecord(v)) return null;
  const path = str(v.path);
  if (!path) return null;
  return {
    path,
    name: str(v.name) ?? basename(path),
    type: str(v.type) === 'folder' ? 'folder' : 'file',
    id: str(v.id),
    mimeType: str(v.mimeType),
    size: num(v.size),
  };
}

/** Worker `SearchHit` → {@link VfsSearchHit}. */
function parseSearchHit(v: unknown): VfsSearchHit | null {
  if (!isRecord(v)) return null;
  const path = str(v.path);
  if (!path) return null;
  return {
    path,
    id: str(v.fileId),
    lineStart: num(v.lineStart),
    lineEnd: num(v.lineEnd),
    snippet: str(v.preview),
    score: num(v.score),
  };
}

/** Worker `GrepMatch` (FileMetadata + snippet) → {@link VfsSearchHit}. */
function parseGrepMatch(v: unknown): VfsSearchHit | null {
  if (!isRecord(v)) return null;
  const path = str(v.path);
  if (!path) return null;
  return { path, id: str(v.id), snippet: str(v.snippet) };
}

/** Worker `BatchResult.results[]` → {@link VfsBatchItemResult}[]. */
function parseBatchResults(body: unknown): VfsBatchItemResult[] {
  return arrayAt(body, 'results').flatMap((v) => {
    if (!isRecord(v)) return [];
    return [
      {
        id: str(v.id) ?? '',
        ok: bool(v.ok) ?? false,
        status: num(v.status) ?? 0,
        path: str(v.path),
        error: str(v.error),
      },
    ];
  });
}

function nonNull<T>(v: T | null): v is T {
  return v !== null;
}

/** Exact-length `ArrayBuffer` copy of a view — safe for pooled Node buffers. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

interface RequestInitLite {
  body?: string | Uint8Array;
  contentType?: string;
  accept?: string;
  streamBody?: VfsStreamBody;
}

export class VfsClient {
  private readonly baseUrl: string;

  private readonly mint: VfsMintFn;

  private readonly timeoutMs: number;

  private readonly callerSignal?: AbortSignal;

  private readonly fetchImpl: typeof fetch;

  private readonly retryDelayMs: number;

  constructor(opts: VfsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.mint = opts.mint;
    this.timeoutMs = opts.timeoutMs;
    this.callerSignal = opts.signal;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 250;
  }

  // -------------------------------------------------------------------------
  // Read / search
  // -------------------------------------------------------------------------

  /** Resolve a path to its file via `/glob` (exact-path match). */
  async statByPath(path: string): Promise<VfsFileStat | null> {
    const res = await this.get('fs/list', `/glob?pattern=${enc(path)}`);
    const first = arrayAt(await this.json(res), 'files')[0];
    return first === undefined ? null : parseFile(first, path);
  }

  /** List the direct children of a folder (`/tree`). */
  async list(path: string): Promise<VfsTreeEntry[]> {
    const res = await this.get('fs/list', `/tree?path=${enc(path)}`);
    return arrayAt(await this.json(res), 'nodes')
      .map(parseTreeEntry)
      .filter(nonNull);
  }

  /** Hybrid lexical + semantic search over indexed content (`/search`). */
  async search(q: string, path: string): Promise<VfsSearchResult> {
    const res = await this.get(
      'fs/read',
      `/search?q=${enc(q)}&path=${enc(path)}`,
    );
    const body = await this.json(res);
    return {
      results: arrayAt(body, 'hits').map(parseSearchHit).filter(nonNull),
      semantic: (isRecord(body) && bool(body.semantic)) ?? true,
    };
  }

  /** Literal term search inside files (`/grep`). */
  async grep(q: string, path: string): Promise<VfsSearchHit[]> {
    const res = await this.get(
      'fs/read',
      `/grep?q=${enc(q)}&path=${enc(path)}`,
    );
    return arrayAt(await this.json(res), 'matches')
      .map(parseGrepMatch)
      .filter(nonNull);
  }

  /** Match files by path pattern (`/glob`). */
  async glob(pattern: string): Promise<VfsGlobMatch[]> {
    const res = await this.get('fs/list', `/glob?pattern=${enc(pattern)}`);
    return arrayAt(await this.json(res), 'files').flatMap((v) => {
      const f = parseFile(v);
      return f ? [{ path: f.path, id: f.id }] : [];
    });
  }

  /**
   * Read a window of a text file as server-numbered lines (`/files/:id/read`).
   * `offset` is 1-based — the worker rejects `offset < 1` with a 400.
   */
  async readLines(
    id: string,
    offset: number,
    limit: number,
  ): Promise<VfsReadWindow> {
    const res = await this.get(
      'fs/read',
      `/files/${enc(id)}/read?offset=${offset}&limit=${limit}`,
    );
    const r = asRecord(await this.json(res));
    return {
      text: str(r.text) ?? '',
      offset: num(r.offset) ?? offset,
      count: num(r.count) ?? 0,
      hasMore: bool(r.hasMore) ?? false,
      totalLines: num(r.totalLines) ?? 0,
    };
  }

  /** Download a file's raw bytes (`/files/:id/content`) — for binaries. */
  async contentBytes(id: string): Promise<VfsContentBytes> {
    const res = await this.get('fs/read', `/files/${enc(id)}/content`, {});
    const bytes = await res.arrayBuffer();
    const mimeType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ||
      'application/octet-stream';
    return { bytes, mimeType, size: bytes.byteLength };
  }

  // -------------------------------------------------------------------------
  // Write / organise
  // -------------------------------------------------------------------------

  /** Create a file at `path` (`POST /files?path=`). 409 if it already exists. */
  async create(
    path: string,
    body: string | Uint8Array,
    mime: string,
  ): Promise<VfsFileStat> {
    const res = await this.send(
      'fs/write',
      'POST',
      `/files?path=${enc(path)}`,
      {
        body,
        contentType: mime,
        accept: 'application/json',
      },
    );
    return parseFile(await this.json(res), path) ?? emptyStat(path);
  }

  /** Replace a file's whole content (`PUT /files/:id`). */
  async replace(
    id: string,
    body: string | Uint8Array,
    mime: string,
  ): Promise<VfsFileStat> {
    const res = await this.send('fs/write', 'PUT', `/files/${enc(id)}`, {
      body,
      contentType: mime,
      accept: 'application/json',
    });
    return parseFile(await this.json(res)) ?? emptyStat('');
  }

  /** Create a file from a streamed body (`POST /files?path=`). 409 if it exists. */
  async createStream(path: string, body: VfsStreamBody): Promise<VfsFileStat> {
    const res = await this.send(
      'fs/write',
      'POST',
      `/files?path=${enc(path)}`,
      {
        streamBody: body,
        accept: 'application/json',
      },
    );
    return parseFile(await this.json(res), path) ?? emptyStat(path);
  }

  /** Replace a file's content from a streamed body (`PUT /files/:id`). */
  async replaceStream(id: string, body: VfsStreamBody): Promise<VfsFileStat> {
    const res = await this.send('fs/write', 'PUT', `/files/${enc(id)}`, {
      streamBody: body,
      accept: 'application/json',
    });
    return parseFile(await this.json(res)) ?? emptyStat('');
  }

  /** Exact-string edit (`PATCH /files/:id/edit`). */
  async edit(
    id: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): Promise<VfsEditResult> {
    const res = await this.send('fs/write', 'PATCH', `/files/${enc(id)}/edit`, {
      body: JSON.stringify({ oldString, newString, replaceAll }),
      contentType: 'application/json',
      accept: 'application/json',
    });
    return { replacements: num(asRecord(await this.json(res)).replacements) };
  }

  /**
   * Move/rename files (`POST /batch/move`). Each item is `{ id,
   * destinationPath }` — resolve source paths to ids via {@link statByPath}
   * first (the worker addresses moves by id, not source path).
   */
  async move(
    items: Array<{ id: string; destinationPath: string }>,
  ): Promise<VfsBatchItemResult[]> {
    const res = await this.send('fs/write', 'POST', `/batch/move`, {
      body: JSON.stringify({ items }),
      contentType: 'application/json',
      accept: 'application/json',
    });
    return parseBatchResults(await this.json(res));
  }

  /** Move files to trash by id (`POST /batch/delete`). */
  async trash(ids: string[]): Promise<VfsBatchItemResult[]> {
    const res = await this.send('fs/delete', 'POST', `/batch/delete`, {
      body: JSON.stringify({ ids }),
      contentType: 'application/json',
      accept: 'application/json',
    });
    return parseBatchResults(await this.json(res));
  }

  /** Stream a file's bytes by path (`GET /content?path=`); `null` when absent. */
  async contentStreamByPath(path: string): Promise<VfsContentStream | null> {
    let res: Response;
    try {
      res = await this.get('fs/read', `/content?path=${enc(path)}`, {});
    } catch (err) {
      if (err instanceof VfsHttpError && err.status === 404) return null;
      throw err;
    }
    if (!res.body) return null;
    const length = res.headers.get('content-length');
    return {
      stream: webToNodeStream(res.body),
      sizeBytes: length === null ? undefined : num(Number(length)),
      contentHash: res.headers.get('x-vfs-content-hash') ?? undefined,
      cid: res.headers.get('x-vfs-cid') ?? undefined,
      mimeType:
        res.headers.get('content-type')?.split(';')[0]?.trim() ||
        'application/octet-stream',
    };
  }

  /** Permanently delete trashed files by id (`POST /batch/purge`). */
  async purge(ids: string[]): Promise<VfsBatchItemResult[]> {
    const res = await this.send('fs/delete', 'POST', `/batch/purge`, {
      body: JSON.stringify({ ids }),
      contentType: 'application/json',
      accept: 'application/json',
    });
    return parseBatchResults(await this.json(res));
  }

  /**
   * Publish/unpublish a file (`PATCH /files/:id/public?public=`). The worker
   * reads the flag from the query param (its preferred form).
   */
  async setFilePublic(id: string, pub: boolean): Promise<VfsPublicResult> {
    const res = await this.send(
      'fs/write',
      'PATCH',
      `/files/${enc(id)}/public?public=${pub}`,
      { accept: 'application/json' },
    );
    const r = asRecord(await this.json(res));
    return { public: bool(r.public) ?? pub, publicUrl: str(r.publicUrl) };
  }

  /**
   * Publish/unpublish a folder (`PUT /folders/public?path=&public=`). Both the
   * folder path and the flag are query params — the worker does not read them
   * from the body.
   */
  async setFolderPublic(path: string, pub: boolean): Promise<VfsPublicResult> {
    const res = await this.send(
      'fs/write',
      'PUT',
      `/folders/public?path=${enc(path)}&public=${pub}`,
      { accept: 'application/json' },
    );
    const r = asRecord(await this.json(res));
    return { public: bool(r.public) ?? pub, publicUrl: str(r.publicUrl) };
  }

  // -------------------------------------------------------------------------
  // Transport core
  // -------------------------------------------------------------------------

  /** Idempotent GET (retried once on 429/5xx/network). */
  private get(
    ability: VfsAbility,
    pathAndQuery: string,
    opts: RequestInitLite = { accept: 'application/json' },
  ): Promise<Response> {
    return this.request(ability, 'GET', pathAndQuery, opts, true);
  }

  /** Non-idempotent write (retried only once on 401, to re-mint). */
  private send(
    ability: VfsAbility,
    method: string,
    pathAndQuery: string,
    opts: RequestInitLite,
  ): Promise<Response> {
    return this.request(ability, method, pathAndQuery, opts, false);
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.retryDelayMs);
    });
  }

  /**
   * One fetch with a fresh bearer, an accept/content-type header set, and a
   * combined caller-abort + timeout signal. Every non-2xx that isn't retried
   * becomes a {@link VfsHttpError}; an unresolved auth mint becomes a
   * {@link VfsAuthError}.
   */
  private async request(
    ability: VfsAbility,
    method: string,
    pathAndQuery: string,
    opts: RequestInitLite,
    idempotent: boolean,
  ): Promise<Response> {
    const url = `${this.baseUrl}${pathAndQuery}`;
    let didGetRetry = false;
    let didAuthRetry = false;

    for (;;) {
      const minted = await this.mint(ability);
      if ('error' in minted) {
        throw new VfsAuthError(minted.error, minted.detail);
      }

      const headers: Record<string, string> = {
        authorization: `Bearer ${minted.bearer}`,
        'x-auth-type': 'ucan',
      };
      if (opts.accept) headers.accept = opts.accept;
      if (opts.body !== undefined) {
        headers['content-type'] = opts.contentType ?? 'application/json';
      }
      if (opts.streamBody) {
        headers['content-type'] = opts.streamBody.mime;
        headers['content-length'] = String(opts.streamBody.sizeBytes);
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('vfs request timeout'));
      }, this.timeoutMs);
      const onCallerAbort = () => controller.abort(this.callerSignal?.reason);
      if (this.callerSignal) {
        if (this.callerSignal.aborted)
          controller.abort(this.callerSignal.reason);
        else
          this.callerSignal.addEventListener('abort', onCallerAbort, {
            once: true,
          });
      }

      // Held so it can be closed below: when the worker answers before it has
      // read the body (an auth middleware rejecting with 401/403), the fetch
      // implementation never cancels the request stream, and the open file
      // descriptor behind it would leak once per attempt.
      const bodyStream: Readable | undefined = opts.streamBody?.open();

      let res: Response;
      try {
        // `duplex` is required by undici for request streams and absent from
        // the DOM `RequestInit` type this repo compiles against, hence the
        // intersection annotation (not a cast).
        const init: RequestInit & { duplex: 'half' } = {
          method,
          headers,
          // Binary bodies arrive as a `Uint8Array`; copy into a standalone
          // `ArrayBuffer` so a pooled Buffer's extra bytes are never sent.
          body: bodyStream
            ? nodeToWebStream(bodyStream)
            : opts.body instanceof Uint8Array
              ? toArrayBuffer(opts.body)
              : opts.body,
          signal: controller.signal,
          // Auth is a bearer header — cookies are never used. This must stay
          // `'omit'`: on a 401 the Fetch spec re-sends the request with
          // credentials, which needs a re-readable body source, and a stream
          // has none — with the default (`'same-origin'`) undici rejects the
          // whole call ("expected non-null body source") before the 401 is
          // ever observable, so the re-mint retry below could not fire for a
          // streamed upload.
          credentials: 'omit',
          duplex: 'half',
        };
        res = await this.fetchImpl(url, init);
      } catch (err) {
        // A caller-initiated abort is terminal — surface it, don't retry.
        if (this.callerSignal?.aborted && !timedOut) throw err;
        if (idempotent && !didGetRetry) {
          didGetRetry = true;
          await this.delay();
          continue;
        }
        throw new VfsHttpError({
          status: 0,
          message: 'Filesystem request failed.',
          raw: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
        this.callerSignal?.removeEventListener('abort', onCallerAbort);
        // No-op once the body was fully sent (the stream has already
        // auto-destroyed); closes the fd on every path that did not.
        bodyStream?.destroy();
      }

      if (res.ok) return res;

      if (res.status === 401 && !didAuthRetry) {
        didAuthRetry = true;
        continue;
      }
      if (
        (res.status === 429 || res.status >= 500) &&
        idempotent &&
        !didGetRetry
      ) {
        didGetRetry = true;
        await this.delay();
        continue;
      }
      throw await this.toHttpError(res);
    }
  }

  /**
   * Parse a non-2xx body into a {@link VfsHttpError}. Handles the worker's
   * `{ error, message, status }` shape, the zod-openapi `{ success:false,
   * error }` shape, and a plain-text body.
   */
  private async toHttpError(res: Response): Promise<VfsHttpError> {
    let raw = '';
    try {
      raw = await res.text();
    } catch {
      raw = '';
    }

    let message = '';
    let code: string | undefined;
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          const errField = parsed.error;
          // zod-openapi validation errors nest `{ error: { message } }`.
          const nested = isRecord(errField) ? str(errField.message) : undefined;
          message = str(parsed.message) ?? nested ?? str(errField) ?? '';
          code = str(errField) ?? str(parsed.code);
        }
      } catch {
        message = raw;
      }
    }
    if (!message) message = `HTTP ${res.status}`;

    return new VfsHttpError({ status: res.status, message, raw, code });
  }
}

/** URL-encode a path/query value. */
function enc(v: string): string {
  return encodeURIComponent(v);
}

/** Coerce an unknown JSON body to a record for field reads. */
function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/** A metadata stub for the rare case the worker returns an unparseable body. */
function emptyStat(path: string): VfsFileStat {
  return { id: '', path, name: basename(path), mimeType: '', size: 0 };
}
