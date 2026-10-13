/* eslint-disable no-console -- console is the logger on workerd (no @ixo/logger); retries and cleanups must be visible */
/**
 * `OwnerStore` backed by the user's IXO Virtual File System.
 *
 * The file lives at `/.oracles/<oracleDid>/state.db.gz` in the user's own
 * namespace — they can list, download, share or delete it like any file.
 * Every request carries a fresh single-use UCAN invocation minted from the
 * ONE delegation the user deposited for this oracle (`POST /delegation`,
 * the `ucan_delegation` room state — the same delegation Matrix turns and
 * every plugin mint from). That delegation must carry a capability over the
 * user's own filesystem covering the `/.oracles` folder:
 *
 *   `{ can: '*', with: 'ixo:filesystem/.oracles', nb: { hidden: ['/.oracles'] } }`
 *
 * (`with: 'ixo:filesystem'`, the whole personal library, also qualifies; the
 * VFS grant lattice has no `fs/*`, so `'*'` is the owner grant covering
 * read/write/list/delete.) The invocation is attenuated to the one ability
 * and proved by that delegation. There is no other source of file access:
 * without that capability the user is "not on VFS" (`VfsNoDelegationError`).
 *
 * Endpoints are the VFS worker's `/api/fs/*` (see the Node runtime's
 * `plugins/vfs/vfs-client.ts`): `GET /files?path=` (stat via a SHORT prefix —
 * see `listOracleFiles()`), `POST /files?path=` (create, ≤ one part),
 * `POST /upload` + `PATCH /upload/:id` (tus, larger files), `GET
 * /files/:id/content` (bytes, streamed), `POST /batch/delete`, `POST
 * /batch/move`. The file is never `PUT` (a new VERSION, capped at 50 by the
 * VFS): every flush uploads to a temp path and swaps it in with moves — see
 * `save()`. The VFS refuses to move onto an occupied path (per-item 409
 * "Destination occupied"), so the old file is moved aside first.
 *
 * Two VFS semantics this store must respect:
 *   - `/.oracles` is a dot-folder, so the file is HIDDEN by the VFS dotfile
 *     convention. Every invocation therefore carries `nb.hidden: ['*']` — it
 *     imposes no widening (the worker intersects reveal sets across the proof
 *     chain), but without it even the owner's own chain reveals nothing. The
 *     USER's delegation must itself grant a reveal covering `/.oracles`
 *     (`nb.hidden: ['/.oracles']`, or `['*']`).
 *   - D1 caps LIKE patterns at 50 bytes, and the full file path embeds the
 *     oracle DID (70+ bytes) — so it can never be used as a path/glob filter.
 *     `stat()` lists under the short literal `/.oracles` prefix and matches
 *     the exact path client-side.
 */
import { abilityCovers } from '../core/runtime-context';
import { type WorkersUcanService } from '../do/ucan-service';
import { isNetworkError, withRetry } from './retry';
import { tusUpload } from './tus-upload';
import {
  bytesOfStream,
  countStream,
  gunzipStreamIfNeeded,
  gzipStream,
  type FileSnapshot,
  type OwnerCopy,
  type OwnerStore,
  type SaveResult,
  type SaveHints,
} from './types';

const VFS_RESOURCE = 'ixo:filesystem';
const INVOCATION_TTL_SECONDS = 60;
/** Root folder for per-oracle state files — also the short stat prefix. */
const ORACLES_ROOT = '/.oracles';
/** The `with` a user's delegation needs at minimum: the personal `/.oracles` folder. */
export const VFS_OWNER_COPY_RESOURCE = `${VFS_RESOURCE}${ORACLES_ROOT}`;

export const VFS_DEFAULT_BASE_URLS: Record<string, string> = {
  mainnet: 'https://vfs.ixo.earth',
  testnet: 'https://testnet.vfs.ixo.earth',
  devnet: 'https://devnet.vfs.ixo.earth',
};
/** UCAN store worker per network — used by the VFS plugin's file tools, not by this store. */
export const UCAN_STORE_DEFAULT_URLS: Record<string, string> = {
  mainnet: 'https://store.ucan.ixo.earth',
  testnet: 'https://testnet.store.ucan.ixo.earth',
  devnet: 'https://devnet.store.ucan.ixo.earth',
};

/**
 * The user's delegation to this oracle (if any) grants no `ixo:filesystem`
 * capability covering `/.oracles`. Distinguished from transient VFS failures
 * so the migrating store can treat "not on VFS yet" as *no VFS copy* (and
 * read the legacy Matrix media) instead of failing the whole boot — while
 * genuine outages still fail loudly rather than silently serving a stale
 * legacy copy.
 */
export class VfsNoDelegationError extends Error {
  constructor(userDid: string, reason: VfsNoDelegationReason) {
    super(
      reason === 'no-delegation'
        ? `${userDid} has not deposited a delegation for this oracle (POST /delegation)`
        : `${userDid}'s delegation to this oracle carries no ixo:filesystem capability covering ${ORACLES_ROOT}`,
    );
    this.name = 'VfsNoDelegationError';
  }
}
export type VfsNoDelegationReason = 'no-delegation' | 'no-capability';

/**
 * The capability of a user's delegation that lets this store reach the
 * `/.oracles` folder with `ability`, or null. A qualifying `with` is the
 * whole personal filesystem or exactly its `/.oracles` subtree — a narrower
 * scope (say `/.oracles/<oracleDid>`) cannot list `/.oracles`, which the
 * store must do because a full path with the DID embedded is too long for
 * the VFS's filter (see `listOracleFiles()`). Domain namespaces
 * (`ixo:filesystem/did:…`) never qualify.
 */
export function ownerCopyCapability<C extends { can: string; with: string }>(
  capabilities: readonly C[],
  ability: string,
): C | null {
  const qualifyingScope = (resource: string): boolean => {
    if (resource === VFS_RESOURCE) return true;
    if (!resource.startsWith(`${VFS_RESOURCE}/`)) return false;
    const scope = resource.slice(VFS_RESOURCE.length).replace(/\/+$/, '');
    return scope === '' || scope === ORACLES_ROOT;
  };
  return (
    capabilities.find(
      (c) => qualifyingScope(c.with) && abilityCovers(c.can, ability),
    ) ?? null
  );
}

/** A non-2xx VFS response, with the status and body for callers that recover. */
export class VfsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'VfsRequestError';
  }
}

/**
 * Uploads land at `<path>.uploading-<ts>` first and are moved into place
 * once complete; anything still carrying the infix is a crashed flush.
 */
export const TEMP_PATH_INFIX = '.uploading-';
/**
 * The previous file is moved to `<path>.replaced-<ts>` while the new one
 * moves into place, and deleted once it has. Anything still carrying the
 * infix is a complete earlier copy a crashed or failed swap left behind.
 */
export const ASIDE_PATH_INFIX = '.replaced-';
/** tus part size: a multiple of 64 KiB, ≥ 5 MiB (the VFS minimum) — and the peak upload buffer. */
export const TUS_PART_BYTES = 5 * 1024 * 1024;
/** Gzipped files up to one part go through the single-request `POST /files`. */
export const SINGLE_SHOT_MAX_BYTES = TUS_PART_BYTES;
/** Requests carrying a part-sized body get a longer timeout than metadata calls. */
const UPLOAD_TIMEOUT_MS = 120_000;

interface BatchResult {
  results?: Array<{
    id: string;
    ok: boolean;
    status: number;
    error?: string;
  }>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Transient: network failures, 5xx, 429. Everything else is a real answer. */
export function isRetryableRequest(error: unknown): boolean {
  if (error instanceof VfsRequestError)
    return error.status >= 500 || error.status === 429;
  return isNetworkError(error);
}

export interface IxoVfsOwnerStoreOptions {
  ucan: WorkersUcanService;
  userDid: string;
  oracleDid: string;
  /** VFS worker origin, e.g. `https://devnet.vfs.ixo.earth`. */
  vfsBaseUrl: string;
  /**
   * The user's current delegation to this oracle (serialized CAR), or
   * undefined when none is deposited. Read on every request so a delegation
   * deposited or revoked mid-life takes effect at once.
   */
  delegation: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Backoff between retries of a failed request (tests: zeros). */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

interface VfsFileStat {
  id: string;
  path: string;
  size?: number;
  updatedAt?: string;
  checksum?: string;
}

export class IxoVfsOwnerStore implements OwnerStore {
  readonly kind = 'vfs' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly path: string;

  constructor(private readonly opts: IxoVfsOwnerStoreOptions) {
    // Bind the global: calling `this.fetchImpl(...)` hands the store instance
    // as `this`, and workerd's fetch throws "Illegal invocation" for any
    // `this` other than the global scope.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.apiBase = `${opts.vfsBaseUrl.replace(/\/+$/, '')}/api/fs`;
    this.path = `${ORACLES_ROOT}/${opts.oracleDid}/state.db.gz`;
  }

  async head(): Promise<{ etag: string } | null> {
    const stat = await this.ownerCopy();
    return stat ? { etag: this.etagOf(stat) } : null;
  }

  /**
   * Stream the durable copy: the response body is gunzipped on the fly (a
   * raw legacy upload passes through) and handed to the object, which
   * writes it into its VFS chunk by chunk and validates the SQLite header
   * on the first one.
   */
  async load(): Promise<OwnerCopy | null> {
    const stat = await this.ownerCopy();
    if (!stat) return null;
    const res = await this.request(
      'fs/read',
      'GET',
      `/files/${encodeURIComponent(stat.id)}/content`,
    );
    if (!res.body) throw new Error('VFS content response has no body');
    return {
      stream: await gunzipStreamIfNeeded(res.body),
      etag: this.etagOf(stat),
    };
  }

  /**
   * Replace the file by moves, never a new version, and never leave the
   * user without a complete upstream copy:
   *
   *   1. take the gzipped length from `hints` (the object measured it in the
   *      same pass as its checksum) or, without a hint, count it in a pass
   *      of its own (the VFS needs `Upload-Length` at session creation —
   *      `Upload-Defer-Length` is not supported — and gzip output is
   *      deterministic for identical input);
   *   2. upload gzip → a TEMP path next to the real one: one `POST /files`
   *      when it fits in a single part, else a tus session in 5 MiB parts
   *      (`tusUpload`, resumable per part);
   *   3. move the old file aside (`.replaced-<ts>`), then the temp file
   *      into place; when that move fails for good, the old file is moved
   *      back before the error is thrown;
   *   4. only once the new file is at the path: delete the old copy and any
   *      leftovers of earlier flushes (`.uploading-` / `.replaced-` files).
   *      A leftover may be the only complete copy (a swap that failed after
   *      the old file was moved aside), so none is deleted earlier.
   *
   * The path is empty only between the two moves. Every request is retried
   * with backoff; a step that still fails throws, the working copy stays
   * dirty and the next tick starts over. Peak memory is one part (5 MiB)
   * plus fixed overhead, whatever the file size.
   */
  async save(
    snapshot: FileSnapshot,
    hints: SaveHints = {},
  ): Promise<SaveResult> {
    const listing = await this.listOracleFiles();
    const existing = listing.filter((f) => f.path === this.path);
    const leftovers = listing.filter((f) => this.isLeftover(f.path));

    const gzLength =
      hints.gzippedLength ?? (await countStream(gzipStream(snapshot.open())));
    const stamp = Date.now().toString(36);
    const tempPath = `${this.path}${TEMP_PATH_INFIX}${stamp}`;
    const uploaded =
      gzLength <= SINGLE_SHOT_MAX_BYTES
        ? await this.uploadSingleShot(tempPath, snapshot)
        : await this.uploadResumable(tempPath, snapshot, gzLength);
    const tempId = uploaded.id ?? (await this.statPath(tempPath))?.id;
    if (!tempId) {
      throw new Error(
        `VFS upload of ${tempPath} completed but the file cannot be found`,
      );
    }

    const aside: VfsFileStat[] = [];
    for (const [i, file] of existing.entries()) {
      const asidePath = `${this.path}${ASIDE_PATH_INFIX}${stamp}${i > 0 ? `-${i}` : ''}`;
      await this.moveWithRetry(
        file.id,
        asidePath,
        'moving the previous state file aside',
      );
      aside.push({ ...file, path: asidePath });
    }
    try {
      await this.moveIntoPlace(tempId, stamp, aside);
    } catch (error) {
      await this.restoreAside(aside);
      throw error;
    }

    const stale = [...leftovers, ...aside].filter((f) => f.id !== tempId);
    if (stale.length > 0) {
      await withRetry(() => this.batchDelete(stale.map((f) => f.id)), {
        isRetryable: isRetryableRequest,
        ...this.retryOptions(),
      }).catch((err: unknown) => {
        console.warn(
          `[owner-store] could not delete ${stale.length} earlier cop${stale.length === 1 ? 'y' : 'ies'} of ${this.path} (the next flush retries): ${describe(err)}`,
        );
      });
    }
    const etag =
      uploaded.contentHash ??
      (await this.statPath(this.path))?.checksum ??
      tempId;
    return { etag, bytes: gzLength };
  }

  /**
   * The file at the path or, when a swap failed after moving the previous
   * file aside (and could not put it back), the newest set-aside copy — the
   * last complete file this store landed. Never an `.uploading-` temp: its
   * swap did not finish, so it is not the owner copy. `save()` removes the
   * set-aside copies only after its own file is at the path.
   */
  private async ownerCopy(): Promise<VfsFileStat | null> {
    const listing = await this.listOracleFiles();
    const exact = listing.find((f) => f.path === this.path);
    if (exact) return exact;
    const prefix = `${this.path}${ASIDE_PATH_INFIX}`;
    let newest: { file: VfsFileStat; at: number } | null = null;
    for (const file of listing) {
      if (!file.path.startsWith(prefix)) continue;
      // `<stamp>` or `<stamp>-<n>`: the stamp is the save's base-36 time.
      const at = Number.parseInt(
        file.path.slice(prefix.length).split('-')[0] ?? '',
        36,
      );
      if (!Number.isFinite(at)) continue;
      if (newest === null || at > newest.at) newest = { file, at };
    }
    return newest?.file ?? null;
  }

  /** A crashed or failed flush's temp upload or set-aside copy of this file. */
  private isLeftover(path: string): boolean {
    return (
      path.startsWith(`${this.path}${TEMP_PATH_INFIX}`) ||
      path.startsWith(`${this.path}${ASIDE_PATH_INFIX}`)
    );
  }

  /**
   * Move the uploaded temp file to the real path. A "Destination occupied"
   * answer means something still sits there (a concurrent or crashed
   * flush): it is moved aside too (`aside` collects it, so a failure
   * restores it and success deletes it) and the move retried.
   */
  private async moveIntoPlace(
    tempId: string,
    stamp: string,
    aside: VfsFileStat[],
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.move(tempId, this.path);
        } catch (err) {
          if (err instanceof VfsRequestError && err.status === 409) {
            const occupant = await this.statPath(this.path);
            // An earlier attempt committed but its answer was lost.
            if (occupant?.id === tempId) return;
            if (occupant) {
              const asidePath = `${this.path}${ASIDE_PATH_INFIX}${stamp}-o${aside.length}`;
              await this.move(occupant.id, asidePath);
              aside.push({ ...occupant, path: asidePath });
            }
          }
          throw err;
        }
      },
      {
        isRetryable: (err) =>
          isRetryableRequest(err) ||
          (err instanceof VfsRequestError && err.status === 409),
        ...this.retryOptions(),
        onRetry: (err, attempt, delay) =>
          console.warn(
            `[owner-store] move into ${this.path} failed (${describe(err)}) — retry ${attempt} in ${delay} ms`,
          ),
      },
    );
  }

  /**
   * The new file could not be moved into place: put the previous one back
   * so the path keeps a complete copy. Best effort — if this fails too the
   * set-aside copy stays where it is, and the next flush (which only
   * deletes leftovers after its own file landed) cleans it up.
   */
  private async restoreAside(aside: VfsFileStat[]): Promise<void> {
    const previous = aside[0];
    if (previous === undefined) return;
    try {
      await this.moveWithRetry(
        previous.id,
        this.path,
        'restoring the previous state file',
      );
    } catch (err) {
      console.error(
        `[owner-store] ${this.path} is empty: the previous copy stays at ${previous.path} until the next flush (${describe(err)})`,
      );
    }
  }

  private async moveWithRetry(
    id: string,
    destinationPath: string,
    what: string,
  ): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.move(id, destinationPath);
        } catch (err) {
          // The VFS checks the file's version on every move: a retry of a
          // move that committed but lost its answer gets a 409 although the
          // file is already where it was sent.
          if (
            err instanceof VfsRequestError &&
            err.status === 409 &&
            (await this.statPath(destinationPath))?.id === id
          )
            return;
          throw err;
        }
      },
      {
        isRetryable: isRetryableRequest,
        ...this.retryOptions(),
        onRetry: (err, attempt, delay) =>
          console.warn(
            `[owner-store] ${what} failed (${describe(err)}) — retry ${attempt} in ${delay} ms`,
          ),
      },
    );
  }

  /** ≤ one part: buffer the gzip once and `POST /files` it (retried as a whole). */
  private async uploadSingleShot(
    tempPath: string,
    snapshot: FileSnapshot,
  ): Promise<{ id: string | null; contentHash: string | null }> {
    const gz = await bytesOfStream(gzipStream(snapshot.open()));
    const created = await withRetry(
      async () =>
        this.json<Record<string, unknown>>(
          await this.request(
            'fs/write',
            'POST',
            `/files?path=${encodeURIComponent(tempPath)}`,
            gz,
            'application/gzip',
            UPLOAD_TIMEOUT_MS,
          ),
        ),
      {
        isRetryable: isRetryableRequest,
        ...this.retryOptions(),
        onRetry: (err, attempt, delay) =>
          console.warn(
            `[owner-store] upload of ${tempPath} failed (${describe(err)}) — retry ${attempt} in ${delay} ms`,
          ),
      },
    );
    return {
      id: typeof created?.id === 'string' ? created.id : null,
      contentHash:
        typeof created?.contentHash === 'string' ? created.contentHash : null,
    };
  }

  /** > one part: tus session in `TUS_PART_BYTES` parts, resumable per part. */
  private async uploadResumable(
    tempPath: string,
    snapshot: FileSnapshot,
    gzLength: number,
  ): Promise<{ id: string | null; contentHash: string | null }> {
    const result = await tusUpload({
      endpoint: `${this.apiBase}/upload`,
      path: tempPath,
      contentType: 'application/gzip',
      totalLength: gzLength,
      partSize: TUS_PART_BYTES,
      source: () => gzipStream(snapshot.open()),
      authHeaders: () => this.authHeaders('fs/write'),
      fetchImpl: this.fetchImpl,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      ...(this.opts.retryDelaysMs
        ? { retryDelaysMs: this.opts.retryDelaysMs }
        : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      log: (message) => console.warn(`[owner-store] ${message}`),
    });
    return { id: result.fileId, contentHash: result.contentHash };
  }

  async remove(): Promise<void> {
    const listing = await this.listOracleFiles();
    const mine = listing.filter(
      (f) => f.path === this.path || this.isLeftover(f.path),
    );
    if (mine.length === 0) return;
    await this.batchDelete(mine.map((f) => f.id));
  }

  private async batchDelete(ids: string[]): Promise<void> {
    const body = await this.json<BatchResult>(
      await this.request(
        'fs/delete',
        'POST',
        '/batch/delete',
        JSON.stringify({ ids }),
        'application/json',
      ),
    );
    // Already gone counts as deleted.
    const failed = (body?.results ?? []).filter(
      (r) => !r.ok && r.status !== 404,
    );
    const first = failed[0];
    if (first) {
      throw new VfsRequestError(
        first.status,
        first.error ?? '',
        `VFS batch/delete ${first.id} → ${first.status} ${first.error ?? ''}`,
      );
    }
  }

  private async move(id: string, destinationPath: string): Promise<void> {
    const body = await this.json<BatchResult>(
      await this.request(
        'fs/write',
        'POST',
        '/batch/move',
        JSON.stringify({ items: [{ id, destinationPath }] }),
        'application/json',
      ),
    );
    const item = body?.results?.[0];
    if (!item?.ok) {
      throw new VfsRequestError(
        item?.status ?? 500,
        item?.error ?? '',
        `VFS batch/move ${id} → ${destinationPath}: ${item?.status ?? '?'} ${item?.error ?? 'no result'}`,
      );
    }
  }

  private etagOf(stat: VfsFileStat): string {
    return (
      stat.checksum ?? `${stat.id}:${stat.updatedAt ?? ''}:${stat.size ?? ''}`
    );
  }

  /** The file at exactly `path`, if any (see `listOracleFiles`). */
  private async statPath(path: string): Promise<VfsFileStat | null> {
    const listing = await this.listOracleFiles();
    return listing.find((f) => f.path === path) ?? null;
  }

  /**
   * Every file under `/.oracles`. Lists the short literal prefix (the full
   * path would blow D1's 50-byte LIKE pattern budget) and pages in case the
   * user runs many oracles; callers match exact paths client-side.
   */
  private async listOracleFiles(): Promise<VfsFileStat[]> {
    const limit = 200;
    const out: VfsFileStat[] = [];
    for (let offset = 0; ; offset += limit) {
      // The listing backs every existence check (head/load/save): a transient
      // store or VFS failure here must not read as "no file" — retry it like
      // any other request.
      const res = await withRetry(
        () =>
          this.request(
            'fs/list',
            'GET',
            `/files?path=${encodeURIComponent(ORACLES_ROOT)}&limit=${limit}&offset=${offset}`,
          ),
        {
          isRetryable: isRetryableRequest,
          ...this.retryOptions(),
          onRetry: (err, attempt, delay) =>
            console.warn(
              `[owner-store] listing /.oracles failed (${describe(err)}) — retry ${attempt} in ${delay} ms`,
            ),
        },
      );
      const body = await this.json<{ files?: Array<Record<string, unknown>> }>(
        res,
      );
      const files = body?.files ?? [];
      for (const f of files) {
        if (typeof f.id !== 'string' || typeof f.path !== 'string') continue;
        out.push({
          id: f.id,
          path: f.path,
          size: typeof f.size === 'number' ? f.size : undefined,
          updatedAt:
            typeof f.updatedAt === 'string' || typeof f.updatedAt === 'number'
              ? String(f.updatedAt)
              : undefined,
          checksum:
            typeof f.contentHash === 'string' ? f.contentHash : undefined,
        });
      }
      if (files.length < limit) return out;
    }
  }

  private async bearer(
    ability: 'fs/list' | 'fs/read' | 'fs/write' | 'fs/delete',
  ): Promise<string> {
    const raw = this.opts.delegation();
    if (!raw)
      throw new VfsNoDelegationError(this.opts.userDid, 'no-delegation');
    const capability = ownerCopyCapability(
      await this.opts.ucan.delegationCapabilities(raw),
      ability,
    );
    if (!capability)
      throw new VfsNoDelegationError(this.opts.userDid, 'no-capability');
    const minted = await this.opts.ucan.createInvocationFromDelegation(
      raw,
      this.opts.vfsBaseUrl,
      // `nb.hidden: ['*']` imposes NO widening — the VFS intersects reveal
      // sets across the chain, so the effective reveal is exactly what the
      // user's delegation granted. Omitting it would zero the reveal and make
      // the dot-folder state file invisible to its own writer.
      { can: ability, with: capability.with, nb: { hidden: ['*'] } },
      { maxTtlSeconds: INVOCATION_TTL_SECONDS },
    );
    if ('error' in minted)
      throw new Error(`VFS auth: mint failed — ${minted.error}`);
    return minted.invocation;
  }

  private retryOptions(): {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } {
    return {
      ...(this.opts.retryDelaysMs ? { delaysMs: this.opts.retryDelaysMs } : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
    };
  }

  /** Fresh single-use auth headers for one request (the tus client mints per part). */
  private async authHeaders(
    ability: 'fs/list' | 'fs/read' | 'fs/write' | 'fs/delete',
  ): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.bearer(ability)}`,
      'x-auth-type': 'ucan',
    };
  }

  private async request(
    ability: 'fs/list' | 'fs/read' | 'fs/write' | 'fs/delete',
    method: string,
    pathAndQuery: string,
    body?: Uint8Array | string,
    contentType?: string,
    timeoutMs?: number,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...(await this.authHeaders(ability)),
      accept: 'application/json',
    };
    if (body !== undefined)
      headers['content-type'] = contentType ?? 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.opts.timeoutMs ?? 30_000,
    );
    try {
      const res = await this.fetchImpl(`${this.apiBase}${pathAndQuery}`, {
        method,
        headers,
        // A Uint8Array view is a valid body: no extra copy of a multi-MB file.
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new VfsRequestError(
          res.status,
          text,
          `VFS ${method} ${pathAndQuery} → ${res.status} ${text.slice(0, 200)}`,
        );
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(res: Response): Promise<T | null> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
}
