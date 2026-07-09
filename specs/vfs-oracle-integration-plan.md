# VFS Plugin — Spec

The `vfs` plugin lets an oracle agent read, create, edit, search, organise, and share a user's files on the **IXO Virtual Filesystem** (VFS). The agent acts as the user, inside the folder the user granted it, and every action is audited on the user's behalf.

---

## 1. Constants

```ts
// per network (NETWORK = devnet | testnet | mainnet)
VFS_BASE_URL = {
  mainnet: 'https://vfs.ixo.earth',
  testnet: 'https://testnet.vfs.ixo.earth',
  devnet: 'https://devnet.vfs.ixo.earth',
}; // local: http://localhost:8795
UCAN_STORE_URL = {
  mainnet: 'https://store.ucan.ixo.earth',
  testnet: 'https://testnet.store.ucan.ixo.earth',
  devnet: 'https://devnet.store.ucan.ixo.earth',
}; // local: http://localhost:8796

VFS_RESOURCE = 'ixo:filesystem'; // personal namespace user:<addr>
VFS_RESOURCE_ENTITY = (did) => `ixo:filesystem/${did}`; // domain namespace entity:<did>
STORE_RESOURCE = 'ixo:ucan-store';

INVOCATION_TTL_SECONDS = 60; // fresh, single-use per call
DELEGATION_TTL_DAYS = 7; // what the user signs
```

Env (plugin `configSchema`): `VFS_BASE_URL` (z.url), `UCAN_STORE_URL` (z.url), `VFS_MAX_READ_LINES` (default 2000), `VFS_REQUEST_TIMEOUT_MS` (default 20000). `autoDetect` on `VFS_BASE_URL && UCAN_STORE_URL`.

**Hard requirement:** `VFS_BASE_URL`, `UCAN_STORE_URL`, and `ORACLE_DID` must all be on the **same network**. All three resolve the oracle's `did:ixo` via BlockSync; a network mismatch ⇒ 401 everywhere.

---

## 2. Ownership

The user owns their filesystem; the oracle owns nothing. The user is the only party who can grant access (they sign the delegation with their key). The oracle is a scoped, expiring, revocable delegate: it sees only the granted subtree, does only the granted ability, and every file it creates lives in the user's namespace, owned by the user. The user revokes by expiring the delegation, retracting the store deposit, or granting a narrower one.

---

## 3. Auth — two hops per call

Both hops are REST with a fresh, single-use, nonce-unique UCAN invocation. Service DIDs are `did:web`, resolved from `<url>/.well-known/did.json` and cached per origin.

**Hop 1 — fetch the user's delegation from the store worker.**
The oracle self-signs an invocation `{ can:'store/get', with:'ixo:ucan-store' }` (no proofs → the store acts as the oracle → the oracle's own inbox) and reads the delegation the user deposited for it:

```
GET <UCAN_STORE_URL>/api/delegations?issuer=<userDid>&resource=ixo:filesystem
Authorization: Bearer <self-signed store/get invocation>
```

The inbox returns matching delegations with the raw `token` (base64 CAR) inline. Select the newest row with `lifecycleState:'active'`, `expiresAt` null-or-future, and a capability over `ixo:filesystem[/…]` whose ability covers the operation (lattice: `* ⊇ fs/write ⊇ fs/read ⊇ fs/list`, `fs/delete ⊇ fs/read`). Cache the chosen token per `userDid` until it expires — delegations are reusable; only invocations are single-use. Do not filter by `can` (the store matches the literal ability and would miss a broader grant); do not use `undeliveredOnly` (it empties after first pickup).

**Hop 2 — call the VFS with an invocation proved by that delegation.**

```
createInvocationFromDelegation(token, VFS_BASE_URL, { can:<op ability>, with:<granted resource> }, { maxTtlSeconds: 60 })
→ Authorization: Bearer <invocation>,  X-Auth-Type: ucan
```

`can` is the minimum ability for the operation (`fs/read` reads, `fs/write` writes/edits/moves, `fs/delete` deletes). `with` is the resource the delegation granted (so the invocation always attenuates). The VFS routes the oracle into the user's namespace, confines it to the subtree, and audits as `invoker=oracle, actor=user`. Mint a fresh invocation every call.

The delegation the user signs must grant a **superset** of everything the oracle will do: read-only → `can:'fs/read'`; full read/write/organise → `can:'*'` (note `fs/write` alone does not grant `fs/delete`).

---

## 4. Runtime additions

Three small, reusable additions to `UcanService` (+ `rtCtx.ucan` adapter). None are VFS-specific.

1. **`mintSelfSignedInvocation(serviceUrl, { can, with }, { maxTtlSeconds })`** — an invocation with `proofs:[]`, issuer = oracle, `facts:[{ nonce }]`. Needed for Hop 1. (`@ixo/ucan.createInvocation` already supports `proofs:[]`.)
2. **Nonce on `createInvocationFromDelegation`** — add `facts:[{ nonce: crypto.randomUUID() }]` (ucan.service.ts:848). Without it, two calls in the same second produce an identical invocation CID and the second is rejected as a replay. Required for correctness.
3. **`getServiceDelegation(userDid, { storeUrl, resource, requiredAbility })`** — Hop 1 as a method: self-sign `store/get`, GET the inbox, select the covering row, cache per `(userDid, resource)`, return `{ token, with } | { error:'no-delegation'|'store-error' }`. Non-throwing (mirrors `plugins/ucan-failure.ts`).

---

## 5. Tools

One `tool()` per operation (own Zod schema + own description; handler validates args, resolves auth via §3, calls the VFS, maps the response). Contributed from `getRequestTools(rtCtx)` (needs `rtCtx.user.did` + the delegation). If there is no signing key, or `configSchema.safeParse` fails, contribute nothing.

| Tool         | Purpose                                     | VFS call                                                    | Ability   |
| ------------ | ------------------------------------------- | ----------------------------------------------------------- | --------- |
| `vfs_search` | find files by meaning ("the doc about X")   | `GET /search?q=&path=`                                      | fs/read   |
| `vfs_grep`   | find files by exact word/identifier         | `GET /grep?q=&path=`                                        | fs/read   |
| `vfs_glob`   | find files by name/path pattern             | `GET /glob?pattern=`                                        | fs/list   |
| `vfs_list`   | browse a folder                             | `GET /tree?path=`                                           | fs/list   |
| `vfs_read`   | read specific lines of a file               | resolve path→id, `GET /files/:id/read?offset=&limit=`       | fs/read   |
| `vfs_write`  | create a file (or replace one)              | `POST /files?path=`; on 409 → `PUT /files/:id` if replacing | fs/write  |
| `vfs_edit`   | change an exact string in a file            | `PATCH /files/:id/edit`                                     | fs/write  |
| `vfs_move`   | move/rename                                 | `POST /batch/move`                                          | fs/write  |
| `vfs_delete` | move to trash (recoverable)                 | `POST /batch/delete`                                        | fs/delete |
| `vfs_share`  | publish a file/folder, return a public link | `PATCH /files/:id/public` · `PUT /folders/public`           | fs/write  |

Every tool returns a **text string** (or compact JSON) — that is all a `role:tool` message can carry to the model; image/content blocks in a tool result are stripped by OpenRouter, so bytes are never returned raw.

### Content delivery — making any file readable by the agent (`vfs_read`)

`vfs_read` resolves the file's MIME, then:

- **Text** (md/json/code/csv/…): windowed line read via `GET /files/:id/read` — numbered lines with `hasMore`/`totalLines`, paged by `offset`/`limit` (cap `VFS_MAX_READ_LINES`). Never dump a whole file.
- **Image** (png/jpg/webp/…): fetch the bytes (`GET /files/:id/content`), base64 into a `data:` URI, and send it in a `role:user` message to the **vision model** — `rtCtx.llm.get('vision')` (`google/gemini-2.5-flash-lite`) with `[{ type:'text', text:'<describe/extract prompt>' }, { type:'image_url', image_url:{ url: dataURI } }]`. Return the model's **text** (description / OCR). This is the runtime's own attachment pattern; the main model then reads that text.
- **PDF / document**: same base64→vision path using a `{ type:'file', file:{ filename, file_data: dataURI } }` block (Gemini accepts documents), returning extracted text.
- **Other binary**: return a stub — `[binary file "x.bin" — <mime>, <n> bytes — not rendered]` (plus `publicUrl` if it's shared). Never base64 raw bytes into a tool result.

Guardrails: cap the bytes sent to the vision model (e.g. ≤10 MiB) and route it through `rtCtx.abortSignal`; the vision call is one extra LLM round-trip, so `vfs_read` on an image is heavier than on text — the tool description tells the agent to read images only when it needs to see them.

Register `vfsPlugin` in `BUNDLED_PLUGINS` + the public barrel; activates when `VFS_BASE_URL` + `UCAN_STORE_URL` are set.

---

## 6. Agent guidance (how the model is told to use it)

This is delivered three ways: the plugin **manifest** (surfaced by `list_capabilities` / loaded by `load_capability`), each **tool description**, and the **workflow** baked into those descriptions.

### Manifest

```ts
manifest = {
  title: 'Files',
  // Frame it so the agent knows exactly what this is and doesn't confuse it with sandbox scratch or chat attachments.
  summary:
    "The user's Virtual Filesystem (VFS) — their persistent, secure, governed filesystem: the canonical home for their real documents, notes, datasets, and artifacts, in folders, searchable and versioned. Reusable context that lives across sessions — not scratch files, not chat attachments, not the web. Securely stored and access-controlled (managed encryption); authorized IXO services can read content to power search, previews, and these tools, so it is NOT end-to-end encrypted — never describe it as zero-knowledge or unreadable by IXO.",
  category: 'data',
  visibility: 'on-demand', // a fork whose whole job is files can override to 'always'
  whenToUse: [
    "The user refers to a document, note, file, folder, or something they 'saved', 'uploaded', or 'shared with you'.",
    'You need to create, update, or organise a file for the user (draft, report, notes, export) that should persist.',
    'You need to find or quote something from the user\'s files ("what did my notes say about X", "find the contract").',
    'You can reuse a file the user already has instead of asking them to paste or re-upload it.',
    'The user asks you to share a file or make it downloadable.',
  ],
  whenNotToUse: [
    "General knowledge or web questions — the files are the user's private content, not a knowledge base of the world.",
    "Content the user pasted directly into chat (act on that inline; don't write it to a file unless asked).",
    "Temporary/scratch or intermediate files produced during a code or compute run — those belong to the sandbox, not the user's filesystem.",
    'Another plugin owns the data (flows, skills, memory) — use that plugin.',
  ],
  examples: [
    {
      user: 'What did my project notes say about the launch date?',
      thought: "Search the user's files, then read the relevant lines.",
      tool: 'vfs_search',
      args: { q: 'launch date', path: '/' },
    },
    {
      user: 'Save this summary as notes/meeting-2026-07.md',
      thought: 'Create the file at that path.',
      tool: 'vfs_write',
      args: { path: '/notes/meeting-2026-07.md' },
    },
    {
      user: 'In todo.md change "Draft" to "Final"',
      thought: 'Exact-string edit.',
      tool: 'vfs_edit',
      args: { path: '/todo.md', oldString: 'Draft', newString: 'Final' },
    },
    {
      user: 'Share my resume so I can send a link',
      thought: 'Publish it and return the link.',
      tool: 'vfs_share',
      args: { path: '/resume.pdf', public: true },
    },
  ],
};
```

### Tool descriptions (what the model reads on each tool)

Written so the model self-selects the right tool and chains them. Examples:

- `vfs_search` — "Find files by meaning across the user's filesystem. Use for questions and paraphrases ('the doc about pricing'). Returns file paths + cited line ranges. Follow with `vfs_read` to see the actual lines before answering or editing."
- `vfs_grep` — "Find files containing an exact word or identifier. Use when you know a literal term; use `vfs_search` for concepts."
- `vfs_list` — "List the files and folders under a path. Use to explore what the user has before searching, or to confirm a path exists."
- `vfs_read` — "Read a file's contents by path. Text files come back a window of numbered lines at a time (default first 2000; page with `offset` when `hasMore`). Images and PDFs are read too — described/transcribed for you. Always read before editing or answering from a file; do not guess its contents. Reading an image costs an extra step, so read it only when you need to see it."
- `vfs_write` — "Create a new text file at a path (or, only when the user asked to replace it, overwrite an existing one). Announce what you're creating. If the path already exists and the user did not ask to overwrite, stop and ask."
- `vfs_edit` — "Change an exact string in a file. `oldString` must match once (or set `replaceAll`). Read the file first so `oldString` is exact. Prefer this over rewriting the whole file."
- `vfs_move` / `vfs_delete` — "Move/rename, or move to trash (recoverable). Confirm destructive actions with the user first. Deletes go to trash, not permanent."
- `vfs_share` — "Publish a file or folder so anyone with the link can download it, and return the link. Only when the user asks to share/make public — publishing is visible to anyone with the link."

### Workflow the descriptions enforce

**Find → read → act.** Discover with `vfs_search`/`vfs_grep`/`vfs_glob`/`vfs_list`; read the relevant lines with `vfs_read`; only then `vfs_edit`/`vfs_write`/`vfs_move`. Never edit or answer-from a file without reading it. Announce writes/deletes in one short sentence; ask before overwriting or deleting. Work only inside what the user shared — if a call is refused as out-of-scope, tell the user it's outside the folder they shared rather than retrying elsewhere.

### No-access path

If the user hasn't granted filesystem access (no delegation), the file tools return a single actionable message the agent relays: _"You haven't shared any files with me yet — grant filesystem access in the portal and I'll be able to read and manage your files."_ The agent does not retry or invent file contents.

---

## 7. Error contract

`vfs-client.ts` maps every response to a typed result; each tool returns an agent-actionable string, never a raw stack. Reads/searches (GET) may retry ≤1 on 429/5xx/network with backoff; **mutations never auto-retry** except the one D37 case below.

| Status / signal                               | Meaning                                | Agent-facing result                                                                 | Retry                 |
| --------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- |
| no delegation                                 | user hasn't granted access             | the no-access message (§6)                                                          | no                    |
| store/mint failure                            | Hop-1 unreachable / mint failed        | "Couldn't get filesystem access right now."                                         | store GET ≤1          |
| `401`                                         | expired / bad sig / replay             | re-mint fresh, retry once                                                           | mint-fresh once       |
| `403`                                         | ability/scope not granted              | "That's outside what you shared with me (may be read-only, or a different folder)." | no                    |
| `404`                                         | out-of-scope id, absent, or blob drift | "No such file, or it's outside the folder you shared."                              | no                    |
| `409` `already exists`                        | create hit an existing path            | `PUT` if replacing; else "A file already exists at `<path>`."                       | no                    |
| `409` `oldString not found`/`appears N times` | edit match failed                      | relay ("add context or set replaceAll")                                             | no                    |
| `409` `Destination occupied`/`Duplicate id`   | move conflict                          | relay (per item)                                                                    | no                    |
| `409` `Version limit reached … 50 versions`   | version cap                            | "This file hit its 50-version limit."                                               | no                    |
| `409` `modified concurrently`                 | write raced another writer (D37)       | re-read the file, retry **once**; second conflict → tell the user                   | **once**              |
| `413`/`415`                                   | too large / not text                   | relay the limit; suggest replace or smaller scope                                   | no                    |
| `429`                                         | rate limited (no `Retry-After`)        | "Filesystem is busy; retrying shortly."                                             | GET ≤1, fixed backoff |
| `503`                                         | domain membership unresolvable         | "Filesystem temporarily unavailable."                                               | GET ≤1                |
| `5xx`/network/timeout                         | transient                              | "Filesystem request failed."                                                        | GET ≤1                |
| `200` `semantic:false` (search)               | vector engine down                     | proceed lexical-only                                                                | n/a                   |

Parsing rules the client handles: two 400 bodies (`{error,message,status}` and zod-openapi `{success:false,error}`); a plain-text 404 on an unknown route; batch endpoints return per-item `{id,ok,status,error}` at `200` (inspect `results`/`failed`, never assume all succeeded); `cid` is in the JSON body on upload and the `x-vfs-cid` header on download.

---

## 8. Limits & validation

Validate client-side before the round-trip (mirror the VFS): path absolute, 1–1024 chars, no `//`, no `.`/`..` segment, no null byte, no trailing slash; batch ≤1000; `q`/`pattern` ≤512; read `limit` ≤5000. Upload as string/Buffer with an explicit `Content-Length` (a length-less large body buffers server memory). Thread `rtCtx.abortSignal` and a `VFS_REQUEST_TIMEOUT_MS` timeout into every fetch. Never reuse an invocation. When pulling raw bytes, verify `x-vfs-content-hash`/`x-vfs-cid`.

---

## 9. Delivery

**Phase 0 — prerequisites.** Confirm network parity (§1). Confirm `ORACLE_DID` equals the oracle account DID the FE resolves as the delegation audience. FE work: sign a delegation to `ORACLE_DID` over `ixo:filesystem[/subtree]` (ability per the access the user grants) and deposit it in the store worker (`POST /api/delegations`), behind a "share my files with this oracle" consent. Runtime work: the three additions in §4.

**Phase 1 — read.** Plugin scaffold, `vfs-client` with the full §7 contract, `vfs-auth` (§3), tools `vfs_search`/`vfs_grep`/`vfs_glob`/`vfs_list`/`vfs_read`, manifest + tool descriptions (§6). Register + unit tests (fake fetch + fake `rtCtx.ucan`); run them.

**Phase 2 — write.** `vfs_write` (create; 409→PUT on replace), `vfs_edit`, `vfs_move`, `vfs_delete`. Mutation retry rules per §7.

**Phase 3 — share & versions.** `vfs_share`; optionally `vfs_versions` / restore (`GET /files/:id/versions`, `POST /files/:id/versions/:version/restore`). Docs.

**Phase 4 — integration test** (manual, not auto-run): read a shared file, create+edit, 403 out-of-scope, 401 stale token, a burst of reads (proves the nonce fix), a concurrent-edit 409 retry.

---

## 10. Testing

Unit: each tool against a fake fetch + fake `rtCtx.ucan` (test-fixtures already stub `createInvocationFromDelegation`) — cover happy path, each error row in §7, no-delegation degradation, the write-conflict single retry, batch per-item results. Integration (`*.int.test.ts`, throws on missing env, not auto-run) against a live store + VFS on one network.
