# Checkpoint Backups on VFS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back up each user's checkpoint DB to their own VFS (two-hop UCAN) instead of Matrix room media, with per-user cutover gated on a deposited delegation, fully streamed in both directions.

**Architecture:** A `CheckpointBackupStore` seam inside the checkpointer with two implementations (`VfsCheckpointStore`, `MatrixCheckpointStore`); the existing VFS plugin's `VfsClient` gains streaming upload/download methods and a `RuntimeContext`-free bearer minter so the cron can use it; the sync service selects a store per user, cuts a user over on their first successful VFS upload, and never falls back afterwards.

**Tech Stack:** TypeScript (NodeNext, DOM lib), NestJS, better-sqlite3, undici `fetch` with streamed bodies, `@ixo/ucan` via `UcanService`, vitest.

**Spec:** `specs/checkpoint-vfs-backup.md` (worker contracts: `specs/vfs-oracle-integration-plan.md` §3/§7)

## Global Constraints

- Work ONLY inside this worktree: `/Users/yousef/ixo-oracles-boilerplate/.claude/worktrees/feature-checkpoint-vfs-backup`. Another agent works in the main tree — never touch `/Users/yousef/ixo-oracles-boilerplate/` files directly.
- **NEVER run git write commands** (no add/commit/stash/checkout/branch). Report done and stop; the controller handles commits/PR.
- **No type assertions** (`as any`, `as X`, `as unknown as X`, angle-bracket). The repo uses the DOM lib, so `fetch` init needs `duplex: 'half'` via an intersection type annotation (`RequestInit & { duplex: 'half' }`), and web↔node stream conversion goes through the assertion-free helpers in Task 2 — never `Readable.fromWeb(x as …)`.
- **No task/spec metadata in source comments.** Comments describe runtime behavior.
- Env booleans follow the base schema convention: `z.enum(['true', 'false']).default('true').transform((v) => v === 'true')`.
- Worker URLs are NEVER env vars — they derive from `NETWORK` via `NETWORK_URLS` (mainnet `https://vfs.ixo.earth` / `https://store.ucan.ixo.earth`, testnet `https://testnet.…`, devnet `https://devnet.…`; default devnet).
- VFS backup path: `oracle-data/<oracleEntityDid>/<storageKey>.db.gz`; abilities: `fs/write` upload, `fs/read` download, `fs/delete` delete; resource `ixo:filesystem`.
- Run every unit test you write with the exact command given and paste real output. Never run `*.int.test.ts`. Do not run root `pnpm lint`/`pnpm format` (controller runs them per wave).
- Tight assertions; 2 test-side attempts max on a failing test, then STOP and report.
- Runtime tests: `pnpm --filter @ixo/oracle-runtime exec vitest run <file>`. Runtime type-check: `pnpm --filter @ixo/oracle-runtime build`. Saver tests (this worktree has no hoisted vitest): from `packages/sqlite-saver`, run `../vitest-config/node_modules/.bin/vitest run <file>`.

---

### Task 1: Shared VFS network map + context-free bearer minter

**Files:**

- Create: `packages/oracle-runtime/src/plugins/vfs/vfs-network.ts`
- Modify: `packages/oracle-runtime/src/plugins/vfs/vfs.plugin.ts` (replace the inline `NETWORK_URLS` block + its use in `getRequestTools`)
- Modify: `packages/oracle-runtime/src/plugins/vfs/vfs-auth.ts`
- Modify: `packages/oracle-runtime/src/plugins/vfs/index.ts` (export the new symbols)
- Test: `packages/oracle-runtime/src/plugins/vfs/vfs-auth.test.ts` (new)

**Interfaces:**

- Consumes: `RuntimeContext['ucan']` method types from `plugin-api/types.ts`.
- Produces:
  - `vfs-network.ts`: `type IxoNetwork = 'mainnet' | 'testnet' | 'devnet'`, `interface VfsWorkerUrls { vfs: string; store: string }`, `NETWORK_URLS: Record<IxoNetwork, VfsWorkerUrls>`, `resolveVfsWorkerUrls(network: string | undefined): VfsWorkerUrls`.
  - `vfs-auth.ts`: `type VfsDelegationMinter = Pick<RuntimeContext['ucan'], 'getServiceDelegation' | 'createInvocationFromDelegation'>`, `interface VfsAuthUrls { VFS_BASE_URL: string; UCAN_STORE_URL: string }`, `mintVfsBearerFor(minter: VfsDelegationMinter, userDid: string, urls: VfsAuthUrls, ability: VfsAbility, targetResource?: string): Promise<VfsBearerResult>`. Existing `vfsBearer(rtCtx, cfg, ability, targetResource?)` keeps its signature and delegates.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { mintVfsBearerFor, type VfsDelegationMinter } from './vfs-auth.js';

const URLS = {
  VFS_BASE_URL: 'https://devnet.vfs.ixo.earth',
  UCAN_STORE_URL: 'https://devnet.store.ucan.ixo.earth',
};

function minter(
  overrides: Partial<VfsDelegationMinter> = {},
): VfsDelegationMinter {
  return {
    getServiceDelegation: vi.fn(async () => ({
      token: 'CAR',
      with: 'ixo:filesystem/oracle-data/did:ixo:entity:abc',
    })),
    createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'INV' })),
    ...overrides,
  };
}

describe('mintVfsBearerFor', () => {
  it('mints an invocation attenuated to the granted resource', async () => {
    const m = minter();
    const result = await mintVfsBearerFor(m, 'did:ixo:user', URLS, 'fs/write');
    expect(result).toEqual({ bearer: 'INV' });
    expect(m.getServiceDelegation).toHaveBeenCalledWith('did:ixo:user', {
      storeUrl: URLS.UCAN_STORE_URL,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/write',
    });
    expect(m.createInvocationFromDelegation).toHaveBeenCalledWith(
      'CAR',
      URLS.VFS_BASE_URL,
      {
        can: 'fs/write',
        with: 'ixo:filesystem/oracle-data/did:ixo:entity:abc',
      },
      { maxTtlSeconds: 60 },
    );
  });

  it('passes a no-delegation result through untouched', async () => {
    const m = minter({
      getServiceDelegation: vi.fn(async () => ({
        error: 'no-delegation' as const,
      })),
    });
    expect(await mintVfsBearerFor(m, 'did:ixo:user', URLS, 'fs/read')).toEqual({
      error: 'no-delegation',
    });
    expect(m.createInvocationFromDelegation).not.toHaveBeenCalled();
  });

  it('maps a mint failure to mint-failed with the detail', async () => {
    const m = minter({
      createInvocationFromDelegation: vi.fn(async () => ({ error: 'no key' })),
    });
    expect(await mintVfsBearerFor(m, 'did:ixo:user', URLS, 'fs/read')).toEqual({
      error: 'mint-failed',
      detail: 'no key',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/plugins/vfs/vfs-auth.test.ts`
Expected: FAIL — `mintVfsBearerFor` is not exported.

- [ ] **Step 3: Create `vfs-network.ts` and use it from the plugin**

```ts
/** VFS + UCAN Store worker URLs per IXO network, derived from `NETWORK`. */
export type IxoNetwork = 'mainnet' | 'testnet' | 'devnet';

export interface VfsWorkerUrls {
  vfs: string;
  store: string;
}

export const NETWORK_URLS: Record<IxoNetwork, VfsWorkerUrls> = {
  mainnet: {
    vfs: 'https://vfs.ixo.earth',
    store: 'https://store.ucan.ixo.earth',
  },
  testnet: {
    vfs: 'https://testnet.vfs.ixo.earth',
    store: 'https://testnet.store.ucan.ixo.earth',
  },
  devnet: {
    vfs: 'https://devnet.vfs.ixo.earth',
    store: 'https://devnet.store.ucan.ixo.earth',
  },
};

/** Worker URLs for a `NETWORK` value; anything unrecognised means devnet. */
export function resolveVfsWorkerUrls(
  network: string | undefined,
): VfsWorkerUrls {
  if (network === 'mainnet' || network === 'testnet') {
    return NETWORK_URLS[network];
  }
  return NETWORK_URLS.devnet;
}
```

In `vfs.plugin.ts`: delete the local `NETWORK_URLS` constant (lines 11–34 of the current file, comment included), add `import { resolveVfsWorkerUrls } from './vfs-network.js';`, and in `getRequestTools` replace `const urls = NETWORK_URLS[network];` with `const urls = resolveVfsWorkerUrls(network);` (keep the existing `network` derivation line as is — `resolveVfsWorkerUrls` accepts the same string).

- [ ] **Step 4: Split `vfsBearer` into the minter + the context wrapper**

Replace the body of `vfs-auth.ts` below the imports with:

```ts
/** Personal-namespace resource the user delegates over. */
const VFS_RESOURCE = 'ixo:filesystem';

/** Invocations are single-use per call, so a short TTL suffices. */
const INVOCATION_TTL_SECONDS = 60;

export type VfsBearerResult =
  | { bearer: string }
  | { error: VfsAuthErrorKind; detail?: string };

/** The two UCAN operations the two-hop flow needs — satisfied by `rtCtx.ucan` and by `UcanService` itself. */
export type VfsDelegationMinter = Pick<
  RuntimeContext['ucan'],
  'getServiceDelegation' | 'createInvocationFromDelegation'
>;

export interface VfsAuthUrls {
  VFS_BASE_URL: string;
  UCAN_STORE_URL: string;
}

/**
 * Resolve a fresh, single-use VFS bearer for one operation via the two-hop
 * UCAN flow, for any caller that holds the UCAN operations directly — the
 * request path (through `vfsBearer`) and background jobs alike:
 *
 *   1. Fetch the user's delegation for this oracle from the store worker
 *      (`getServiceDelegation`) over `ixo:filesystem`, requiring an ability
 *      that covers `ability`.
 *   2. Mint an invocation proved by that delegation, attenuated to
 *      `{ can: ability, with: <granted resource> }`.
 *
 * Non-throwing: every failure is returned as `{ error, detail? }`.
 */
export async function mintVfsBearerFor(
  minter: VfsDelegationMinter,
  userDid: string,
  urls: VfsAuthUrls,
  ability: VfsAbility,
  targetResource?: string,
): Promise<VfsBearerResult> {
  const delegation = await minter.getServiceDelegation(userDid, {
    storeUrl: urls.UCAN_STORE_URL,
    resource: VFS_RESOURCE,
    requiredAbility: ability,
  });
  if ('error' in delegation) {
    return delegation;
  }

  const minted = await minter.createInvocationFromDelegation(
    delegation.token,
    urls.VFS_BASE_URL,
    { can: ability, with: targetResource ?? delegation.with },
    { maxTtlSeconds: INVOCATION_TTL_SECONDS },
  );
  if ('error' in minted) {
    return { error: 'mint-failed', detail: minted.error };
  }

  return { bearer: minted.invocation };
}

/** Request-path convenience: the same flow using the runtime context's user + UCAN adapter. */
export function vfsBearer(
  rtCtx: RuntimeContext,
  cfg: VfsConfig,
  ability: VfsAbility,
  targetResource?: string,
): Promise<VfsBearerResult> {
  return mintVfsBearerFor(
    rtCtx.ucan,
    rtCtx.user.did,
    cfg,
    ability,
    targetResource,
  );
}
```

(`VfsConfig` structurally satisfies `VfsAuthUrls`; keep the existing imports.) Add `mintVfsBearerFor`, `type VfsDelegationMinter`, `type VfsAuthUrls` and the `vfs-network.js` exports to `plugins/vfs/index.ts`.

- [ ] **Step 5: Run the new test and the whole VFS plugin suite**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/plugins/vfs/`
Expected: all PASS (3 new + existing). Then `pnpm --filter @ixo/oracle-runtime build` clean. Report done.

---

### Task 2: Streaming methods on `VfsClient` + stream helpers

**Files:**

- Create: `packages/oracle-runtime/src/plugins/vfs/vfs-streams.ts`
- Create: `packages/oracle-runtime/src/plugins/vfs/vfs-streams.test.ts`
- Modify: `packages/oracle-runtime/src/plugins/vfs/vfs-client.ts`
- Create: `packages/oracle-runtime/src/plugins/vfs/vfs-client.stream.test.ts`

**Interfaces:**

- Produces:
  - `vfs-streams.ts`: `nodeToWebStream(source: Readable): ReadableStream<Uint8Array>`, `webToNodeStream(body: ReadableStream<Uint8Array>): Readable`.
  - `vfs-client.ts`: `interface VfsStreamBody { open: () => Readable; sizeBytes: number; mime: string }`; `interface VfsContentStream { stream: Readable; sizeBytes?: number; contentHash?: string; cid?: string; mimeType: string }`; methods `createStream(path: string, body: VfsStreamBody): Promise<VfsFileStat>`, `replaceStream(id: string, body: VfsStreamBody): Promise<VfsFileStat>`, `contentStreamByPath(path: string): Promise<VfsContentStream | null>` (404 → `null`), `purge(ids: string[]): Promise<VfsBatchItemResult[]>`; `VfsFileStat` gains `cid?: string` (parsed from the worker's `cid` field).

- [ ] **Step 1: Write the failing stream-helper tests**

```ts
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { nodeToWebStream, webToNodeStream } from './vfs-streams.js';

async function collect(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('vfs stream helpers', () => {
  it('round-trips bytes node → web → node', async () => {
    const payload = Buffer.from('a'.repeat(100_000));
    const web = nodeToWebStream(
      Readable.from([payload.subarray(0, 60_000), payload.subarray(60_000)]),
    );
    const back = await collect(webToNodeStream(web));
    expect(back.equals(payload)).toBe(true);
  });

  it('destroys the node source when the web stream is cancelled', async () => {
    const source = Readable.from([Buffer.from('x')]);
    const web = nodeToWebStream(source);
    await web.cancel();
    expect(source.destroyed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/plugins/vfs/vfs-streams.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `vfs-streams.ts`**

```ts
import { Readable } from 'node:stream';

/**
 * Wrap a Node readable as a WHATWG stream for a `fetch` request body. Built
 * by hand (not `Readable.toWeb`) so the result carries the DOM lib's
 * `ReadableStream` type that `fetch` expects — no cast needed.
 */
export function nodeToWebStream(source: Readable): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(Buffer.isBuffer(value) ? value : Buffer.from(value));
    },
    cancel() {
      source.destroy();
    },
  });
}

/** Expose a `fetch` response body as a Node readable without buffering. */
export function webToNodeStream(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Readable.from(chunks());
}
```

Run the helper test: PASS.

- [ ] **Step 4: Write the failing client streaming tests**

```ts
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { VfsClient } from './vfs-client.js';

function client(fetchImpl: typeof fetch): VfsClient {
  return new VfsClient({
    baseUrl: 'https://vfs.test/api/fs',
    mint: vi.fn(async () => ({ bearer: 'B' })),
    timeoutMs: 1000,
    fetchImpl,
    retryDelayMs: 0,
  });
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!body) return 0;
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

describe('VfsClient streaming', () => {
  it('createStream sends a streamed body with content-length and re-opens it on 401', async () => {
    const opens = vi.fn(() => Readable.from([Buffer.alloc(1024, 7)]));
    const seen: Array<{
      url: string;
      init: RequestInit & { duplex?: string };
    }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request: RequestInit & { duplex?: string } = init ?? {};
        seen.push({ url: String(input), init: request });
        const bodyBytes =
          request.body instanceof ReadableStream
            ? await drain(request.body)
            : 0;
        if (seen.length === 1)
          return new Response('unauthorized', { status: 401 });
        return new Response(
          JSON.stringify({
            id: 'f1',
            path: 'oracle-data/e/k.db.gz',
            cid: 'bafy',
            size: bodyBytes,
          }),
          { status: 201 },
        );
      },
    );

    const stat = await client(fetchImpl).createStream('oracle-data/e/k.db.gz', {
      open: opens,
      sizeBytes: 1024,
      mime: 'application/gzip',
    });

    expect(stat).toMatchObject({ id: 'f1', cid: 'bafy', size: 1024 });
    expect(opens).toHaveBeenCalledTimes(2);
    expect(seen[1]?.init.duplex).toBe('half');
    expect(new Headers(seen[1]?.init.headers).get('content-length')).toBe(
      '1024',
    );
    expect(new Headers(seen[1]?.init.headers).get('content-type')).toBe(
      'application/gzip',
    );
    expect(seen[1]?.url).toBe(
      'https://vfs.test/api/fs/files?path=oracle-data%2Fe%2Fk.db.gz',
    );
  });

  it('contentStreamByPath streams the body and surfaces the hash headers', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from('gzip-bytes'), {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            'content-length': '10',
            'x-vfs-content-hash': 'deadbeef',
            'x-vfs-cid': 'bafyq',
          },
        }),
    );
    const result = await client(fetchImpl).contentStreamByPath(
      'oracle-data/e/k.db.gz',
    );
    if (!result) throw new Error('expected a content stream');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('gzip-bytes');
    expect(result).toMatchObject({
      sizeBytes: 10,
      contentHash: 'deadbeef',
      cid: 'bafyq',
      mimeType: 'application/gzip',
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://vfs.test/api/fs/content?path=oracle-data%2Fe%2Fk.db.gz',
    );
  });

  it('contentStreamByPath returns null on 404', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not found', { status: 404 }),
    );
    expect(await client(fetchImpl).contentStreamByPath('missing')).toBeNull();
  });

  it('purge posts to /batch/purge', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ results: [{ id: 'f1', ok: true, status: 200 }] }),
          { status: 200 },
        ),
    );
    expect(await client(fetchImpl).purge(['f1'])).toEqual([
      { id: 'f1', ok: true, status: 200, path: undefined, error: undefined },
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://vfs.test/api/fs/batch/purge',
    );
  });
});
```

- [ ] **Step 5: Run to verify they fail**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/plugins/vfs/vfs-client.stream.test.ts`
Expected: FAIL — methods do not exist.

- [ ] **Step 6: Extend `vfs-client.ts`**

Add near the top: `import { Readable } from 'node:stream';` and `import { nodeToWebStream, webToNodeStream } from './vfs-streams.js';`. Add `cid?: string` to `VfsFileStat` and set `cid: str(v.cid)` in `parseFile`. Add the two public interfaces:

```ts
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
```

Extend `RequestInitLite` with `streamBody?: VfsStreamBody;`. In `request()`, where `headers` are built, add after the `opts.body` block:

```ts
if (opts.streamBody) {
  headers['content-type'] = opts.streamBody.mime;
  headers['content-length'] = String(opts.streamBody.sizeBytes);
}
```

and change the `fetchImpl` call to pass a streamed body when present (`duplex` is required by undici for request streams and absent from the DOM `RequestInit` type, hence the intersection annotation):

```ts
const init: RequestInit & { duplex: 'half' } = {
  method,
  headers,
  body: opts.streamBody
    ? nodeToWebStream(opts.streamBody.open())
    : opts.body instanceof Uint8Array
      ? toArrayBuffer(opts.body)
      : opts.body,
  signal: controller.signal,
  duplex: 'half',
};
res = await this.fetchImpl(url, init);
```

Add the four methods (write section, next to `create`/`replace`/`trash`):

```ts
  /** Create a file from a streamed body (`POST /files?path=`). 409 if it exists. */
  async createStream(path: string, body: VfsStreamBody): Promise<VfsFileStat> {
    const res = await this.send('fs/write', 'POST', `/files?path=${enc(path)}`, {
      streamBody: body,
      accept: 'application/json',
    });
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
```

- [ ] **Step 7: Run both new test files + the existing VFS suite, then build**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/plugins/vfs/` then `pnpm --filter @ixo/oracle-runtime build`
Expected: all PASS, build clean. Report done.

---

### Task 3: The store seam + `MatrixCheckpointStore` (behavior-preserving)

**Files:**

- Create: `packages/oracle-runtime/src/matrix/checkpointer/checkpoint-backup-store.ts`
- Create: `packages/oracle-runtime/src/matrix/checkpointer/matrix-checkpoint-store.ts`
- Modify: `packages/oracle-runtime/src/matrix/checkpointer/user-matrix-sqlite-sync-service.service.ts` (`_syncLocalStorageFromMatrixStorage`, `uploadCheckpointToMatrixStorage`'s upload tail, `deleteUserStorageFromMatrix`)

**Interfaces:**

- Consumes: `uploadMediaToRoom`, `getMediaFromRoomByStorageKey`, `getMediaFromRoom`, `deleteMediaFromRoom` from `matrix-upload-utils.ts`; `MatrixManager`, `getMatrixHomeServerCroppedForDid`, `config` (already imported in the service).
- Produces (`checkpoint-backup-store.ts`):

```ts
import type { Readable } from 'node:stream';

export type CheckpointStoreKind = 'vfs' | 'matrix';

export interface CheckpointUploadParams {
  userDid: string;
  storageKey: string;
  /** Re-openable: a retry must re-read the temp file from the start. */
  openStream: () => Readable;
  sizeBytes: number;
}

export interface CheckpointUploadResult {
  /** Store-specific handle (Matrix event id / VFS file id) persisted in file_events. */
  pointer: string;
  cid?: string;
  /** Matrix only: the media event, cached for offline re-download. */
  event?: unknown;
}

export interface CheckpointDownloadResult {
  stream: Readable;
  sizeBytes?: number;
  /** Store-computed hash of the bytes, verified by the caller when present. */
  contentHash?: string;
}

export interface CheckpointBackupStore {
  readonly kind: CheckpointStoreKind;
  upload(params: CheckpointUploadParams): Promise<CheckpointUploadResult>;
  download(params: {
    userDid: string;
    storageKey: string;
  }): Promise<CheckpointDownloadResult | null>;
  delete(params: { userDid: string; storageKey: string }): Promise<boolean>;
  available(userDid: string): Promise<boolean>;
}
```

- [ ] **Step 1: Create the interface file exactly as above.**

- [ ] **Step 2: Create `matrix-checkpoint-store.ts`**

Move the room lookup + media calls out of the service into a class; the Matrix path keeps buffering (it is the legacy store — E2E media encryption needs the whole payload):

```ts
import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { Logger, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { getBaseEnvConfig } from '../../config/base-env-config.js';
import type {
  CheckpointBackupStore,
  CheckpointDownloadResult,
  CheckpointUploadParams,
  CheckpointUploadResult,
} from './checkpoint-backup-store.js';
import {
  deleteMediaFromRoom,
  getMediaFromRoom,
  getMediaFromRoomByStorageKey,
  type MatrixMediaEvent,
  uploadMediaToRoom,
} from './matrix-upload-utils.js';

const config = getBaseEnvConfig();

async function collect(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Checkpoint backups as encrypted media in the user's Matrix room (the original store). */
export class MatrixCheckpointStore implements CheckpointBackupStore {
  readonly kind = 'matrix' as const;

  /** Optional cached media event (from file_events) to download without a room lookup. */
  constructor(
    private readonly cachedEventFor: (
      storageKey: string,
    ) => MatrixMediaEvent | undefined,
  ) {}

  async available(): Promise<boolean> {
    return MatrixManager.getInstance().getClient() !== undefined;
  }

  private async roomIdFor(userDid: string): Promise<string> {
    const userHomeServer = await getMatrixHomeServerCroppedForDid(userDid);
    const { roomId } =
      await MatrixManager.getInstance().getOracleRoomIdWithHomeServer({
        userDid,
        oracleEntityDid: config.getOrThrow('ORACLE_ENTITY_DID'),
        userHomeServer,
      });
    if (!roomId)
      throw new NotFoundException('Room not found or Invalid Session Id');
    return roomId;
  }

  async upload(
    params: CheckpointUploadParams,
  ): Promise<CheckpointUploadResult> {
    const bytes = await collect(params.openStream());
    const roomId = await this.roomIdFor(params.userDid);
    Logger.debug(
      `Uploading compressed checkpoint to Matrix room ${roomId} for user ${params.userDid}`,
    );
    const event = await uploadMediaToRoom(
      roomId,
      {
        bytes,
        filename: `${params.storageKey}.db.gz`,
        mimetype: 'application/x-sqlite3',
      },
      params.storageKey,
    );
    return { pointer: event.eventId, event: event.event };
  }

  async download(params: {
    userDid: string;
    storageKey: string;
  }): Promise<CheckpointDownloadResult | null> {
    const cached = this.cachedEventFor(params.storageKey);
    const result = cached
      ? await getMediaFromRoom(undefined, undefined, cached)
      : await getMediaFromRoomByStorageKey(
          await this.roomIdFor(params.userDid),
          params.storageKey,
        );
    if (!result) return null;
    return {
      stream: Readable.from(result.mediaBuffer),
      sizeBytes: result.mediaBuffer.length,
    };
  }

  async delete(params: {
    userDid: string;
    storageKey: string;
  }): Promise<boolean> {
    return deleteMediaFromRoom(
      await this.roomIdFor(params.userDid),
      params.storageKey,
    );
  }
}
```

(The `as const` on `kind` is a literal-type annotation on a readonly field, not a cast — required so the class satisfies `CheckpointStoreKind`. If lint flags it, declare `readonly kind: CheckpointStoreKind = 'matrix';` instead.)

- [ ] **Step 3: Route the service's upload tail through the store**

In `uploadCheckpointToMatrixStorage`, the code from `const mxManager = MatrixManager.getInstance();` through the `uploadMediaToRoom(...)` call becomes (keep everything before it — snapshot/gzip/guard — untouched; the gz temp is now read as a stream instead of `fs.readFile`, so `compressedCheckpoint`/`fs.readFile(gzTmpPath)` go away and the `finally` cleanup must move to AFTER the upload):

```ts
const store = this.matrixStore;
let uploaded: CheckpointUploadResult;
try {
  uploaded = await store.upload({
    userDid,
    storageKey,
    openStream: () => fsSync.createReadStream(gzTmpPath),
    sizeBytes: compressedSize,
  });
} finally {
  await removeIfExists(gzTmpPath);
}
await this.saveFileEventToDB({
  eventId: uploaded.pointer,
  storageKey,
  event: uploaded.event,
  contentChecksum: currentChecksum,
});
```

Concretely: remove `gzTmpPath` from the existing snapshot `finally` (keep the snapshot removal there), and remove `let compressedCheckpoint: Buffer;` + its `fs.readFile`. `saveFileEventToDB`'s `event` parameter type widens to `unknown` (it is `JSON.stringify`ed). Add the field `private readonly matrixStore = new MatrixCheckpointStore((key) => this.cachedMediaEvent(key));` and a private `cachedMediaEvent(storageKey)` that performs the existing `SELECT event FROM file_events WHERE storage_key = ?` + `JSON.parse` (moved from `_syncLocalStorageFromMatrixStorage`, same try/catch → `undefined`).

- [ ] **Step 4: Route download through the store**

In `_syncLocalStorageFromMatrixStorage`, replace the cached-event lookup + `getMediaFromRoom`/`getMediaFromRoomByStorageKey` block with `const download = await this.matrixStore.download({ userDid, storageKey });` inside the same try/catch (the `isUnrecoverableDownloadError` split stays). Replace the decompression block so it works from a stream: write `download.stream` to `checkpointPath + '.raw.tmp'` via `pipeline`; then attempt `pipeline(createReadStream(rawTmp), createGunzip(), createWriteStream(tmpPath))`; on failure, read the first 16 bytes of the raw file (`readFileHeader`) — if it is the SQLite magic, `fs.rename(rawTmp, tmpPath)` (legacy uncompressed), else log + remove both and return. Always remove `rawTmp` in `finally`. The remaining header validation / `fs.rename(tmpPath, checkpointPath)` stays. Add `'.raw.tmp'` to `clearLocalCheckpoint`'s suffix list.

- [ ] **Step 5: Route delete through the store**

In `deleteUserStorageFromMatrix`, replace the room lookup + `deleteMediaFromRoom` with `const deleted = await this.matrixStore.delete({ userDid, storageKey: key });`. Keep the rest.

- [ ] **Step 6: Verify behavior preserved**

Run: `pnpm --filter @ixo/oracle-runtime build && pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/`
Expected: build clean; all existing checkpointer tests PASS unchanged (the service tests mock `@ixo/matrix` at module scope — the new store file imports it too, which the existing mock covers). Report done.

---

### Task 4: `VfsCheckpointStore`

**Files:**

- Create: `packages/oracle-runtime/src/matrix/checkpointer/vfs-checkpoint-store.ts`
- Create: `packages/oracle-runtime/src/matrix/checkpointer/vfs-checkpoint-store.test.ts`

**Interfaces:**

- Consumes: Task 1 (`mintVfsBearerFor`, `VfsDelegationMinter`, `VfsWorkerUrls`), Task 2 (`VfsClient` streaming methods), `isAlreadyExistsConflict`, `VfsAuthError`, `VfsHttpError` from `plugins/vfs/vfs-errors.ts`, Task 3 interface.
- Produces: `class VfsCheckpointStore implements CheckpointBackupStore` with constructor `(deps: { minter: VfsDelegationMinter; urls: VfsWorkerUrls; oracleEntityDid: string; knownFileId: (storageKey: string) => string | undefined; timeoutMs?: number; fetchImpl?: typeof fetch })` and `static backupPath(oracleEntityDid: string, storageKey: string): string`.

- [ ] **Step 1: Learn the download hash header semantics from the worker source (read-only)**

```bash
gh api "repos/ixoworld/ixo-virtual-filesystem/git/trees/main?recursive=1" --jq '.tree[].path' | grep -iE "content|hash" | head
# then read the route that serves GET /content (path from the listing):
gh api "repos/ixoworld/ixo-virtual-filesystem/contents/<path-from-listing>" --jq '.content' | base64 -d | grep -n -B3 -A3 "x-vfs-content-hash"
```

Record in your report: the algorithm + encoding of `x-vfs-content-hash` (e.g. `sha256` hex). Implement `verifyContentHash` below for that algorithm; if the header is not a digest of the raw bytes (e.g. a cid), verify `sizeBytes` only and say so in the report.

- [ ] **Step 2: Write the failing tests**

```ts
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { VfsDelegationMinter } from '../../plugins/vfs/vfs-auth.js';
import { VfsCheckpointStore } from './vfs-checkpoint-store.js';

const URLS = { vfs: 'https://vfs.test', store: 'https://store.test' };
const ENTITY = 'did:ixo:entity:abc';

function minter(delegation: 'ok' | 'none' = 'ok'): VfsDelegationMinter {
  return {
    getServiceDelegation: vi.fn(async () =>
      delegation === 'ok'
        ? { token: 'CAR', with: `ixo:filesystem/oracle-data/${ENTITY}` }
        : { error: 'no-delegation' as const },
    ),
    createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'INV' })),
  };
}

function store(
  fetchImpl: typeof fetch,
  opts: { delegation?: 'ok' | 'none'; knownId?: string } = {},
) {
  return new VfsCheckpointStore({
    minter: minter(opts.delegation),
    urls: URLS,
    oracleEntityDid: ENTITY,
    knownFileId: () => opts.knownId,
    timeoutMs: 1000,
    fetchImpl,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('VfsCheckpointStore', () => {
  it('builds the backup path under the delegated subtree', () => {
    expect(VfsCheckpointStore.backupPath(ENTITY, 'k1')).toBe(
      `oracle-data/${ENTITY}/k1.db.gz`,
    );
  });

  it('is available only when a delegation exists', async () => {
    const f = vi.fn(async () => json({}));
    expect(await store(f, { delegation: 'ok' }).available('did:ixo:u')).toBe(
      true,
    );
    expect(await store(f, { delegation: 'none' }).available('did:ixo:u')).toBe(
      false,
    );
  });

  it('creates on first upload and returns the file id + cid', async () => {
    const f = vi.fn(async () =>
      json({ id: 'f1', cid: 'bafy', path: 'p' }, 201),
    );
    const result = await store(f).upload({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
      openStream: () => Readable.from([Buffer.from('gz')]),
      sizeBytes: 2,
    });
    expect(result).toEqual({ pointer: 'f1', cid: 'bafy' });
    expect(String(f.mock.calls[0]?.[0])).toContain(
      '/files?path=oracle-data%2F',
    );
  });

  it('replaces by known id when the path already exists', async () => {
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/files?path='))
        return new Response(
          JSON.stringify({ error: 'already exists', status: 409 }),
          { status: 409 },
        );
      if (url.endsWith('/files/f1')) return json({ id: 'f1', cid: 'bafy2' });
      throw new Error(`unexpected ${url}`);
    });
    const result = await store(f, { knownId: 'f1' }).upload({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
      openStream: () => Readable.from([Buffer.from('gz')]),
      sizeBytes: 2,
    });
    expect(result).toEqual({ pointer: 'f1', cid: 'bafy2' });
  });

  it('resolves the id via glob when the path exists but no id is known', async () => {
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/files?path='))
        return new Response(JSON.stringify({ error: 'already exists' }), {
          status: 409,
        });
      if (url.includes('/glob?pattern='))
        return json({ files: [{ id: 'f9', path: 'p' }] });
      if (url.endsWith('/files/f9')) return json({ id: 'f9', cid: 'c' });
      throw new Error(`unexpected ${url}`);
    });
    const result = await store(f).upload({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
      openStream: () => Readable.from([Buffer.from('gz')]),
      sizeBytes: 2,
    });
    expect(result.pointer).toBe('f9');
  });

  it('download returns null without a delegation and on 404', async () => {
    const f404 = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(
      await store(f404).download({ userDid: 'did:ixo:u', storageKey: 'k1' }),
    ).toBeNull();
    const fOk = vi.fn(async () => json({}));
    expect(
      await store(fOk, { delegation: 'none' }).download({
        userDid: 'did:ixo:u',
        storageKey: 'k1',
      }),
    ).toBeNull();
  });

  it('download streams bytes and surfaces the content hash', async () => {
    const f = vi.fn(
      async () =>
        new Response(Buffer.from('gz-bytes'), {
          status: 200,
          headers: { 'content-length': '8', 'x-vfs-content-hash': 'h' },
        }),
    );
    const result = await store(f).download({
      userDid: 'did:ixo:u',
      storageKey: 'k1',
    });
    if (!result) throw new Error('expected a download');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('gz-bytes');
    expect(result).toMatchObject({ sizeBytes: 8, contentHash: 'h' });
  });

  it('delete trashes then purges the file', async () => {
    const calls: string[] = [];
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/glob?'))
        return json({ files: [{ id: 'f1', path: 'p' }] });
      return json({ results: [{ id: 'f1', ok: true, status: 200 }] });
    });
    expect(
      await store(f).delete({ userDid: 'did:ixo:u', storageKey: 'k1' }),
    ).toBe(true);
    expect(calls.some((u) => u.endsWith('/batch/delete'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/batch/purge'))).toBe(true);
  });

  it('propagates a 403 as an error (terminal, never a silent null)', async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    await expect(
      store(f).download({ userDid: 'did:ixo:u', storageKey: 'k1' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/vfs-checkpoint-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `vfs-checkpoint-store.ts`**

```ts
import { Logger } from '@nestjs/common';
import {
  mintVfsBearerFor,
  type VfsDelegationMinter,
} from '../../plugins/vfs/vfs-auth.js';
import { VfsClient } from '../../plugins/vfs/vfs-client.js';
import {
  isAlreadyExistsConflict,
  VfsAuthError,
  VfsHttpError,
} from '../../plugins/vfs/vfs-errors.js';
import type { VfsWorkerUrls } from '../../plugins/vfs/vfs-network.js';
import type {
  CheckpointBackupStore,
  CheckpointDownloadResult,
  CheckpointUploadParams,
  CheckpointUploadResult,
} from './checkpoint-backup-store.js';

const VFS_API_BASE_PATH = '/api/fs';
const BACKUP_MIME = 'application/gzip';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface VfsCheckpointStoreDeps {
  minter: VfsDelegationMinter;
  urls: VfsWorkerUrls;
  oracleEntityDid: string;
  /** VFS file id recorded for a storage key on an earlier upload, if any. */
  knownFileId: (storageKey: string) => string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Checkpoint backups as a single gzip file in the user's own VFS namespace,
 * under the subtree the user delegated to this oracle. Every request mints a
 * fresh single-use invocation from the user's deposited delegation.
 */
export class VfsCheckpointStore implements CheckpointBackupStore {
  readonly kind = 'vfs' as const;

  private readonly logger = new Logger(VfsCheckpointStore.name);

  constructor(private readonly deps: VfsCheckpointStoreDeps) {}

  static backupPath(oracleEntityDid: string, storageKey: string): string {
    return `oracle-data/${oracleEntityDid}/${storageKey}.db.gz`;
  }

  private client(userDid: string): VfsClient {
    const { urls } = this.deps;
    return new VfsClient({
      baseUrl: `${urls.vfs.replace(/\/+$/, '')}${VFS_API_BASE_PATH}`,
      timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: this.deps.fetchImpl,
      mint: (ability) =>
        mintVfsBearerFor(
          this.deps.minter,
          userDid,
          { VFS_BASE_URL: urls.vfs, UCAN_STORE_URL: urls.store },
          ability,
        ),
    });
  }

  async available(userDid: string): Promise<boolean> {
    const delegation = await this.deps.minter.getServiceDelegation(userDid, {
      storeUrl: this.deps.urls.store,
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/write',
    });
    return !('error' in delegation);
  }

  async upload(
    params: CheckpointUploadParams,
  ): Promise<CheckpointUploadResult> {
    const client = this.client(params.userDid);
    const path = VfsCheckpointStore.backupPath(
      this.deps.oracleEntityDid,
      params.storageKey,
    );
    const body = {
      open: params.openStream,
      sizeBytes: params.sizeBytes,
      mime: BACKUP_MIME,
    };
    try {
      const created = await client.createStream(path, body);
      return { pointer: created.id, cid: created.cid };
    } catch (err) {
      if (!isAlreadyExistsConflict(err)) throw err;
    }
    const id =
      this.deps.knownFileId(params.storageKey) ??
      (await client.statByPath(path))?.id;
    if (!id) {
      throw new Error(
        `VFS reports ${path} exists but its id could not be resolved`,
      );
    }
    const replaced = await client.replaceStream(id, body);
    return { pointer: replaced.id || id, cid: replaced.cid };
  }

  async download(params: {
    userDid: string;
    storageKey: string;
  }): Promise<CheckpointDownloadResult | null> {
    const path = VfsCheckpointStore.backupPath(
      this.deps.oracleEntityDid,
      params.storageKey,
    );
    try {
      const content = await this.client(params.userDid).contentStreamByPath(
        path,
      );
      if (!content) return null;
      return {
        stream: content.stream,
        sizeBytes: content.sizeBytes,
        contentHash: content.contentHash,
      };
    } catch (err) {
      if (err instanceof VfsAuthError && err.kind === 'no-delegation')
        return null;
      if (err instanceof VfsHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async delete(params: {
    userDid: string;
    storageKey: string;
  }): Promise<boolean> {
    const client = this.client(params.userDid);
    const path = VfsCheckpointStore.backupPath(
      this.deps.oracleEntityDid,
      params.storageKey,
    );
    const id =
      this.deps.knownFileId(params.storageKey) ??
      (await client.statByPath(path))?.id;
    if (!id) return false;
    const trashed = await client.trash([id]);
    if (!trashed.some((r) => r.id === id && r.ok)) return false;
    const purged = await client.purge([id]);
    if (!purged.some((r) => r.id === id && r.ok)) {
      this.logger.warn(`Trashed but could not purge VFS backup ${path}`);
    }
    return true;
  }
}
```

- [ ] **Step 5: Run the tests, then build**

Run: `pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/vfs-checkpoint-store.test.ts && pnpm --filter @ixo/oracle-runtime build`
Expected: all PASS, build clean. Report done (include the Step 1 hash-header finding verbatim).

---

### Task 5: Store selection, per-user cutover, delete, env kill switch, DI

**Files:**

- Modify: `packages/oracle-runtime/src/matrix/checkpointer/user-matrix-sqlite-sync-service.service.ts`
- Modify: `packages/oracle-runtime/src/matrix/checkpointer/user-matrix-sqlite-sync-service.module.ts`
- Modify: `packages/oracle-runtime/src/config/base-env-schema.ts`
- Modify: `packages/oracle-runtime/src/matrix/checkpointer/user-matrix-sqlite-sync-service.service.test.ts` (add a `describe('VFS backup store')` block)
- Grep-and-rename callers of `deleteUserStorageFromMatrix` (`grep -rn deleteUserStorageFromMatrix packages/oracle-runtime/src`).

**Interfaces:**

- Consumes: `VfsCheckpointStore` (Task 4), `MatrixCheckpointStore` (Task 3), `resolveVfsWorkerUrls` (Task 1), `UcanService` from `modules/ucan/ucan.service.ts`.
- Produces: `UserMatrixSqliteSyncService.attachUcanService(ucan: UcanService, opts?: { fetchImpl?: typeof fetch }): void`; `deleteUserBackup(userDid, storageKey?)` (renamed from `deleteUserStorageFromMatrix`); env `CHECKPOINT_VFS_BACKUP_ENABLED`.

- [ ] **Step 1: Env kill switch**

In `base-env-schema.ts`, next to the existing `'true' | 'false'` field (~line 139), add:

```ts
  /**
   * Whether users may be cut over to VFS checkpoint backups. `false` stops
   * new cutovers only — users already on VFS stay there and never fall back.
   */
  CHECKPOINT_VFS_BACKUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
```

- [ ] **Step 2: `file_events` columns + in-memory map**

In `onModuleInit`, after the `content_checksum` ALTER, add three more backward-compatible ALTERs (each in its own try/catch, same style): `store TEXT DEFAULT 'matrix'`, `vfs_file_id TEXT`, `vfs_cid TEXT`. Extend the boot `SELECT` to `SELECT storage_key, content_checksum, store, vfs_file_id FROM file_events` and populate a new field:

```ts
  /** Which store holds a storage key's backup, plus the VFS file id once cut over. */
  private readonly backupLocation = new Map<string, { store: CheckpointStoreKind; vfsFileId?: string }>();
```

(`store` may be `null` on pre-migration rows → treat as `'matrix'`.) Extend `saveFileEventToDB` to accept `{ store, vfsFileId, vfsCid }` and write them (`INSERT OR REPLACE` now lists all seven columns), updating `backupLocation` after the write.

- [ ] **Step 3: Wire UcanService + the VFS store**

Add fields + method to the service:

```ts
  private vfsStore: VfsCheckpointStore | undefined;

  /**
   * Enables VFS backups. Called by the Nest module factory: the service is a
   * singleton, so the DI-provided UcanService is attached rather than injected.
   */
  attachUcanService(ucan: UcanService, opts: { fetchImpl?: typeof fetch } = {}): void {
    if (!ucan.hasSigningKey()) {
      Logger.warn('VFS checkpoint backups disabled — oracle has no UCAN signing key');
      return;
    }
    this.vfsStore = new VfsCheckpointStore({
      minter: ucan,
      urls: resolveVfsWorkerUrls(config.get('NETWORK')),
      oracleEntityDid: config.getOrThrow('ORACLE_ENTITY_DID'),
      knownFileId: (storageKey) => this.backupLocation.get(storageKey)?.vfsFileId,
      fetchImpl: opts.fetchImpl,
    });
  }
```

(If `config.get('NETWORK')` is not the accessor the base config exposes, use whatever `getBaseEnvConfig()` offers for an optional key — check `base-env-config.ts`; do not add a new accessor.) In the module:

```ts
import { UcanService } from '../../modules/ucan/ucan.service.js';
// ...
    {
      provide: UserMatrixSqliteSyncService,
      useFactory: (ucan: UcanService) => {
        const service = UserMatrixSqliteSyncService.getInstance();
        service.attachUcanService(ucan);
        return service;
      },
      inject: [UcanService],
    },
```

(`UcanModule` is `@Global`, so no import needed. If the module graph makes `UcanService` unavailable at this factory's instantiation, import `UcanModule` explicitly in `CheckpointStorageSyncModule` — report which was needed.)

- [ ] **Step 4: Store selection + cutover in the upload path**

Add a private resolver and use it where Task 3 introduced `const store = this.matrixStore;`:

```ts
  /**
   * VFS once a user is cut over (never back), VFS for new cutovers when the
   * feature is on and the user's delegation exists, Matrix otherwise.
   */
  private async resolveUploadStore(userDid: string, storageKey: string): Promise<CheckpointBackupStore> {
    const location = this.backupLocation.get(storageKey);
    if (location?.store === 'vfs') {
      return this.vfsStore ?? this.matrixStore;
    }
    if (this.vfsStore && config.get('CHECKPOINT_VFS_BACKUP_ENABLED') && (await this.vfsStore.available(userDid))) {
      return this.vfsStore;
    }
    return this.matrixStore;
  }
```

(When a `'vfs'` user's `vfsStore` is undefined — signing key removed — the `?? this.matrixStore` fallback must NOT happen silently: log an error and `return 'skipped'` from the upload instead. Implement that branch explicitly rather than the `??`.)

After `saveFileEventToDB(...)` in the upload, add the cutover:

```ts
if (store.kind === 'vfs' && previousLocation?.store !== 'vfs') {
  Logger.log(
    `Checkpoint backup for user ${userDid} moved to VFS (${bytesToHumanReadable(compressedSize)}${uploaded.cid ? `, cid ${uploaded.cid}` : ''}); redacting Matrix copy`,
  );
  try {
    await this.matrixStore.delete({ userDid, storageKey });
  } catch (error) {
    Logger.warn(
      `Could not redact the Matrix checkpoint copy for user ${userDid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

where `previousLocation` is read from `backupLocation` BEFORE `saveFileEventToDB` runs. `saveFileEventToDB` is called with `store: store.kind, vfsFileId: store.kind === 'vfs' ? uploaded.pointer : undefined, vfsCid: uploaded.cid`.

- [ ] **Step 5: Download resolution + hash verification**

In `_syncLocalStorageFromMatrixStorage` (rename to `_syncLocalStorageFromBackup`; keep the public method name), select stores by `backupLocation`:

```ts
const location = this.backupLocation.get(storageKey);
const candidates: CheckpointBackupStore[] =
  location?.store === 'vfs'
    ? [this.vfsStore].filter((s): s is VfsCheckpointStore => s !== undefined)
    : location?.store === 'matrix'
      ? [this.matrixStore]
      : [...(this.vfsStore ? [this.vfsStore] : []), this.matrixStore];
let download: CheckpointDownloadResult | null = null;
let source: CheckpointBackupStore | undefined;
for (const candidate of candidates) {
  download = await candidate.download({ userDid, storageKey });
  if (download) {
    source = candidate;
    break;
  }
}
```

(inside the existing try/catch with the unrecoverable/transient split — extend `isUnrecoverableDownloadError` with nothing: a VFS 403 propagates as transient, so a revoked delegation never triggers a fresh-DB overwrite). While writing the raw stream to `.raw.tmp`, tee it through a `createHash(<algorithm from Task 4 Step 1>)`; if `download.contentHash` is present and differs, log an error, remove the temp files and return (treated as no-download). Log which store served the download.

- [ ] **Step 6: Delete by location**

Rename `deleteUserStorageFromMatrix` → `deleteUserBackup` (update all callers). It resolves the store from `backupLocation` (`'vfs'` → `this.vfsStore`, else `this.matrixStore`), calls `store.delete`, then the existing cleanup plus `this.backupLocation.delete(key)` and the existing `syncedUsers.delete(userDid)`.

- [ ] **Step 7: Service tests for the cutover state machine**

Append to the existing service test file (reuse its env/mocks; add a `vi.mock('../../modules/ucan/ucan.service.js', …)`-free approach by calling `attachUcanService` with a hand-rolled object that satisfies `UcanService`'s two methods + `hasSigningKey` — if the class type makes that impossible without a cast, construct the `VfsCheckpointStore` yourself and assign it through a new test-only setter `attachBackupStoresForTests({ vfs })`; say which in the report):

1. `cuts a user over on the first successful VFS upload and redacts Matrix`: delegation ok, `fetchImpl` answering `POST /files` with `201 {id:'f1',cid:'c'}`; spy the Matrix store's `delete`; expect status `'uploaded'`, `backupLocation` row `store:'vfs'`, `file_events.store === 'vfs'`, Matrix delete called once.
2. `a VFS user never falls back to Matrix`: pre-seed `file_events` row `store:'vfs'`; `fetchImpl` returning 500; expect `'skipped'`, Matrix upload never attempted (spy `uploadMediaToRoom` via the existing partial mock).
3. `kill switch off keeps new users on Matrix`: set `CHECKPOINT_VFS_BACKUP_ENABLED='false'` in the hoisted env for this case (or a dedicated file if the value is read at load) — expect the Matrix path selected (`resolveUploadStore` returns `kind:'matrix'`).

- [ ] **Step 8: Build + checkpointer suite**

Run: `pnpm --filter @ixo/oracle-runtime build && pnpm --filter @ixo/oracle-runtime exec vitest run src/matrix/checkpointer/`
Expected: clean; all PASS. Report done.

---

### Task 6: Docs + version bump

**Files:**

- Modify: `docs/architecture/matrix-and-checkpointer.md`
- Modify: `/Users/yousef/ixo-docs/build-an-oracle/` env reference page (find it: `grep -rl "SQLITE_DATABASE_PATH" /Users/yousef/ixo-docs/build-an-oracle`) — add `CHECKPOINT_VFS_BACKUP_ENABLED`
- Modify: `packages/oracle-runtime/package.json` version `1.9.0` → `1.10.0` (verify current value first)

- [ ] **Step 1: Internal docs** — in the `UserMatrixSqliteSyncService` section, replace "uploads … to that user's Matrix room" wording with the two-store model: VFS (user's namespace, two-hop UCAN, per-user cutover on first successful upload, Matrix copy redacted) vs Matrix (legacy, until the kill date); the download order (`file_events` row → VFS → Matrix → fresh); the kill switch. Keep the page's code-first voice; one short paragraph + one bullet list.
- [ ] **Step 2: Public env reference** — one row for `CHECKPOINT_VFS_BACKUP_ENABLED` (`'true'|'false'`, default `true`, "stops new VFS cutovers; existing VFS users unaffected").
- [ ] **Step 3: Version** — bump the runtime minor.
- [ ] **Step 4:** `pnpm exec prettier --check docs/architecture/matrix-and-checkpointer.md` clean. Report done.

---

## Execution notes

- Order: 1 → 2 → 3 → 4 → 5 → 6. Tasks 1 and 3 are file-disjoint and may run in parallel; 2 depends on 1's exports only for the plugin index, 4 depends on 1+2+3, 5 on 3+4.
- Controller runs `pnpm lint` + `pnpm format:check` at wave end; agents do not.
- Integration round-trip against devnet (`/ixo-ucan-invocation` probe + the user-run integration suite) happens after the PR, by the user.
