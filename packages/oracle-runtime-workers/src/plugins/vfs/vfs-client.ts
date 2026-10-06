import {
  VfsAuthError,
  VfsContentTooLargeError,
  VfsHttpError,
  type VfsAbility,
  type VfsAuthErrorKind,
} from './vfs-errors';

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
  contentHash?: string;
  cid?: string;
  version?: number;
  /** Anyone-can-download link, present only when the file is public. */
  publicUrl?: string;
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
  /** 1-based cited line range (search hits) — pairs with {@link VfsClient.readLines}. */
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
    contentHash: str(v.contentHash),
    cid: str(v.cid),
    version: num(v.version),
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

/** Exact-length `ArrayBuffer` copy of a view. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

interface RequestInitLite {
  body?: string | Uint8Array;
  contentType?: string;
  accept?: string;
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
    // Bind the global: `this.fetchImpl(...)` hands the client instance as
    // `this`, and workerd's fetch throws "Illegal invocation" for any `this`
    // other than the global scope.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.retryDelayMs = opts.retryDelayMs ?? 250;
  }

  // -------------------------------------------------------------------------
  // Read / search
  // -------------------------------------------------------------------------

  /**
   * Resolve a path to exactly that file, or `null` when no file has that
   * path. The worker has no metadata-by-path endpoint, so this asks `/glob`
   * — which treats `*` and `?` as wildcards — and keeps only the entry whose
   * path equals `path` character for character. A wildcard path therefore
   * never resolves to some other file it happens to match, while a real file
   * whose name contains `*` or `?` still resolves: its matches are read in
   * worker-maximum pages, in the worker's path order, until the page holding
   * it or a short page, at most {@link GLOB_MAX_PAGES} pages. When every
   * page is full and the file was not seen, the path is refused instead of
   * reported missing. Folders never resolve: `/glob` returns files only. More
   * than one exact match is refused rather than guessed between.
   */
  async statByPath(path: string): Promise<VfsFileStat | null> {
    if (!hasGlobWildcard(path)) {
      return this.exactMatch(
        path,
        await this.get('fs/list', `/glob?pattern=${enc(path)}`, readJson),
      );
    }
    for (let pageNo = 0; pageNo < GLOB_MAX_PAGES; pageNo += 1) {
      const body = await this.get(
        'fs/list',
        `/glob?pattern=${enc(path)}&limit=${GLOB_MAX_PAGE}&offset=${pageNo * GLOB_MAX_PAGE}`,
        readJson,
      );
      const found = this.exactMatch(path, body);
      if (found || arrayAt(body, 'files').length < GLOB_MAX_PAGE) return found;
    }
    throw new VfsHttpError({
      status: 400,
      message: `\`${path}\` matches more than ${GLOB_MAX_PAGES * GLOB_MAX_PAGE} files as a pattern, so the file with exactly that name cannot be looked up; rename it without \`*\` or \`?\`.`,
      raw: '',
    });
  }

  /** Content-addressed workspace recovery uses a short paginated prefix, avoiding the D1 LIKE byte limit. */
  async statWorkspacePath(path: string): Promise<VfsFileStat | null> {
    if (!path.startsWith('/.workspaces/'))
      throw new Error('Expected a workspace path');
    for (let pageNo = 0; pageNo < GLOB_MAX_PAGES; pageNo += 1) {
      const body = await this.get(
        'fs/list',
        `/files?path=${enc('/.workspaces')}&limit=${GLOB_MAX_PAGE}&offset=${pageNo * GLOB_MAX_PAGE}`,
        readJson,
      );
      const found = this.exactMatch(path, body);
      if (found || arrayAt(body, 'files').length < GLOB_MAX_PAGE) return found;
    }
    throw new Error('Workspace recovery listing exceeded its scan limit');
  }

  /** The `/glob` entry whose path is exactly `path`; refuses two of them. */
  private exactMatch(path: string, body: unknown): VfsFileStat | null {
    const exact = arrayAt(body, 'files')
      .map((v) => parseFile(v))
      .filter(nonNull)
      .filter((f) => f.path === path);
    if (exact.length > 1) {
      throw new VfsHttpError({
        status: 400,
        message: `\`${path}\` matches more than one file; refusing to act on an ambiguous path.`,
        raw: '',
      });
    }
    return exact[0] ?? null;
  }

  /** List the direct children of a folder (`/tree`). */
  async list(path: string): Promise<VfsTreeEntry[]> {
    const body = await this.get('fs/list', `/tree?path=${enc(path)}`, readJson);
    return arrayAt(body, 'nodes').map(parseTreeEntry).filter(nonNull);
  }

  /** Hybrid lexical + semantic search over indexed content (`/search`). */
  async search(q: string, path: string): Promise<VfsSearchResult> {
    const body = await this.get(
      'fs/read',
      `/search?q=${enc(q)}&path=${enc(path)}`,
      readJson,
    );
    return {
      results: arrayAt(body, 'hits').map(parseSearchHit).filter(nonNull),
      semantic: (isRecord(body) && bool(body.semantic)) ?? true,
    };
  }

  /** Literal term search inside files (`/grep`). */
  async grep(q: string, path: string): Promise<VfsSearchHit[]> {
    const body = await this.get(
      'fs/read',
      `/grep?q=${enc(q)}&path=${enc(path)}`,
      readJson,
    );
    return arrayAt(body, 'matches').map(parseGrepMatch).filter(nonNull);
  }

  /** Match files by path pattern (`/glob`). */
  async glob(pattern: string): Promise<VfsGlobMatch[]> {
    const body = await this.get(
      'fs/list',
      `/glob?pattern=${enc(pattern)}`,
      readJson,
    );
    return arrayAt(body, 'files').flatMap((v) => {
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
    const r = asRecord(
      await this.get(
        'fs/read',
        `/files/${enc(id)}/read?offset=${offset}&limit=${limit}`,
        readJson,
      ),
    );
    return {
      text: str(r.text) ?? '',
      offset: num(r.offset) ?? offset,
      count: num(r.count) ?? 0,
      hasMore: bool(r.hasMore) ?? false,
      totalLines: num(r.totalLines) ?? 0,
    };
  }

  /**
   * Download a file's raw bytes (`/files/:id/content`) — for binaries. Throws
   * {@link VfsContentTooLargeError} once the body is known to exceed
   * `maxBytes` — from `content-length` before reading, or while streaming —
   * so an oversized file is never fully buffered in the isolate.
   */
  async contentBytes(id: string, maxBytes: number): Promise<VfsContentBytes> {
    return this.get(
      'fs/read',
      `/files/${enc(id)}/content`,
      async (res) => {
        const bytes = await readBodyCapped(res, maxBytes);
        const mimeType =
          res.headers.get('content-type')?.split(';')[0]?.trim() ||
          'application/octet-stream';
        return { bytes, mimeType, size: bytes.byteLength };
      },
      {},
    );
  }

  /** Immutable retained version, read under the caller's current VFS authority. */
  async versionContentBytes(
    id: string,
    version: number,
    maxBytes: number,
  ): Promise<VfsContentBytes> {
    if (!Number.isInteger(version) || version < 1)
      throw new Error('Invalid VFS version');
    return this.get(
      'fs/read',
      `/files/${enc(id)}/versions/${version}/content`,
      async (response) => {
        const bytes = await readBodyCapped(response, maxBytes);
        return {
          bytes,
          size: bytes.byteLength,
          mimeType:
            response.headers.get('content-type')?.split(';')[0]?.trim() ||
            'application/octet-stream',
        };
      },
      {},
    );
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
    return parseFile(res, path) ?? emptyStat(path);
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
    return parseFile(res) ?? emptyStat('');
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
    return { replacements: num(asRecord(res).replacements) };
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
    return parseBatchResults(res);
  }

  /** Move files to trash by id (`POST /batch/delete`). */
  async trash(ids: string[]): Promise<VfsBatchItemResult[]> {
    const res = await this.send('fs/delete', 'POST', `/batch/delete`, {
      body: JSON.stringify({ ids }),
      contentType: 'application/json',
      accept: 'application/json',
    });
    return parseBatchResults(res);
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
    const r = asRecord(res);
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
    const r = asRecord(res);
    return { public: bool(r.public) ?? pub, publicUrl: str(r.publicUrl) };
  }

  // -------------------------------------------------------------------------
  // Transport core
  // -------------------------------------------------------------------------

  /**
   * Idempotent GET (retried once on 429/5xx/network). `consume` reads the 2xx
   * body inside the request's timeout and abort window.
   */
  private get<T>(
    ability: VfsAbility,
    pathAndQuery: string,
    consume: (res: Response) => Promise<T>,
    opts: RequestInitLite = { accept: 'application/json' },
  ): Promise<T> {
    return this.request(ability, 'GET', pathAndQuery, opts, true, consume);
  }

  /**
   * Non-idempotent write (retried only once on 401, to re-mint). Resolves to
   * the parsed JSON body (`null` when it is empty or not JSON).
   */
  private send(
    ability: VfsAbility,
    method: string,
    pathAndQuery: string,
    opts: RequestInitLite,
  ): Promise<unknown> {
    return this.request(ability, method, pathAndQuery, opts, false, readJson);
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.retryDelayMs);
    });
  }

  /**
   * One fetch with a fresh bearer, an accept/content-type header set, and a
   * combined caller-abort + timeout signal that stays armed until the body
   * has been read — a stalled body times out and honours cancellation just
   * like stalled headers. Every non-2xx that isn't retried becomes a
   * {@link VfsHttpError}; an unresolved auth mint becomes a
   * {@link VfsAuthError}. A body read that times out or fails is not retried.
   */
  private async request<T>(
    ability: VfsAbility,
    method: string,
    pathAndQuery: string,
    opts: RequestInitLite,
    idempotent: boolean,
    consume: (res: Response) => Promise<T>,
  ): Promise<T> {
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

      const disarm = (): void => {
        clearTimeout(timer);
        this.callerSignal?.removeEventListener('abort', onCallerAbort);
      };

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          // Binary bodies arrive as a `Uint8Array`; copy into a standalone
          // `ArrayBuffer` so a view's extra backing bytes are never sent.
          body:
            opts.body instanceof Uint8Array
              ? toArrayBuffer(opts.body)
              : opts.body,
          signal: controller.signal,
        });
      } catch (err) {
        disarm();
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
      }

      const retryAuth = res.status === 401 && !didAuthRetry;
      const retryTransient =
        (res.status === 429 || res.status >= 500) && idempotent && !didGetRetry;
      if (retryAuth || retryTransient) {
        disarm();
        discardBody(res);
        if (retryAuth) {
          didAuthRetry = true;
        } else {
          didGetRetry = true;
          await this.delay();
        }
        continue;
      }

      try {
        const read = res.ok
          ? consume(res)
          : this.toHttpError(res).then((e): never => {
              throw e;
            });
        return await raceAbort(read, controller.signal, () => discardBody(res));
      } catch (err) {
        if (err instanceof VfsHttpError) throw err;
        if (this.callerSignal?.aborted && !timedOut) throw err;
        throw new VfsHttpError({
          status: 0,
          message: timedOut
            ? 'Filesystem request timed out.'
            : 'Filesystem request failed.',
          raw: err instanceof Error ? err.message : String(err),
        });
      } finally {
        disarm();
      }
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

/** The worker's largest `/glob` page (`limit` is validated as 1..200). */
const GLOB_MAX_PAGE = 200;

/**
 * Most `/glob` pages one path lookup reads: 5,000 matches, the most the
 * worker scans for one pattern.
 */
const GLOB_MAX_PAGES = 25;

/** `true` when the worker's glob would treat a character of `path` as a wildcard. */
export function hasGlobWildcard(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

/** Parse a body as JSON; empty or malformed JSON is `null`, a read failure throws. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read a body into an `ArrayBuffer`, refusing with
 * {@link VfsContentTooLargeError} as soon as it is known to exceed
 * `maxBytes`: from `content-length` before any byte is read, otherwise
 * while streaming (the stream is cancelled at the first chunk past the cap).
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discardBody(res);
    throw new VfsContentTooLargeError(maxBytes, declared);
  }
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new VfsContentTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/** Release an unread body so its connection is not held open. */
function discardBody(res: Response): void {
  if (res.body && !res.body.locked) {
    void res.body.cancel().catch(() => undefined);
  }
}

/**
 * Settle with `work`, or reject with the signal's reason as soon as it
 * aborts (running `onAbort` first). Bounds a body read even when the
 * transport does not tie the body stream to the request signal.
 */
function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  let abort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      onAbort();
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
  });
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return Promise.race([work, aborted]).finally(() => {
    signal.removeEventListener('abort', abort);
  });
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
