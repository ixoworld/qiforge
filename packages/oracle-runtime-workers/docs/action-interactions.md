# Private action interaction drafts

`@ixo/action-interactions` is the portable Zod 4 wire contract and authenticated
fetch client. It has no editor, React or runtime dependencies. The client SDK
also exports it through `@ixo/oracles-client-sdk/action-interactions`. Inside the
monorepo (and for consumers that pin a git commit) it resolves to its TypeScript
source; the published package is compiled to `dist` through `publishConfig`, so
Node and CommonJS consumers never load TypeScript from `node_modules`.

The public `/health` response advertises `actionInteractions: {version: 1, owners, operations}` only when enabled. This is protocol negotiation, not proof of deployment acceptance or collection authority.

The Workers shell enables the routes only with
`ACTION_INTERACTIONS_ENABLED=true`. Every route requires a signed UCAN invocation,
uses the authenticated user DID to select that user's Durable Object, and checks
that the session still exists in that object. No body can select another user
or oracle. The oracle DID comes from runtime configuration.

| Request                                      | Purpose                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| `GET /action-interactions?sessionId=...`     | The session's 50 newest drafts, oldest first          |
| `GET /action-interactions/:id?sessionId=...` | Read an opaque reference                              |
| `POST /action-interactions`                  | Prepare or reopen an owner-bound draft                |
| `PATCH /action-interactions/:id`             | Apply answer values or cancel                         |
| `POST /action-interactions/:id/reserve`      | Host reserves the reviewed revision and digest        |
| `POST /action-interactions/:id/observe`      | Host records an unknown outcome or executor reference |

Mutations use UUID request IDs. Reusing a request ID with different content
fails. A replay returns the current interaction and `replayed: true`. All edits
and reservations use compare-and-swap revisions inside real DO transactions.
A claim step (account, network, Flow, run, step) has at most one current draft,
whichever chat prepared it. Preparing it again:

| Existing draft for the step                                      | Result                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| None, cancelled, expired, or reserved but never dispatched       | A new draft; the old one ends `cancelled`/`superseded`            |
| Open in this chat, same collection and schema                    | The existing draft, `replayed: true`                              |
| Open in this chat, collection or schema changed                  | A new draft for the new form; the old one is superseded           |
| Open or being dispatched in another chat                         | 409 `target_in_use`                                               |
| Being dispatched in this chat, form changed                      | 409 `target_changed`                                              |
| Its operation reached the claim service, or the host reported it | Same chat and form: the record; otherwise 409 `dispatch_consumed` |

Question and artifact owners are keyed per chat and follow the same rules
without reservations.
Updates may include `remove: string[]` for fields cleared by SurveyJS. A removed field must be unique and absent from `patch`. User removals are remembered in `updatedByUser`, so later agent pre-fill cannot restore a deliberately cleared value. Agent updates and removals preserve fields edited by the user. Host integrations must set
`source: user` for genuine user edits and `source: agent` for model pre-fill.

The server validates structural JSON and immutable owner context. The live Flow
adapter must validate its actual SurveyJS schema and authorization before it
reserves or dispatches. The personal store is not a collection authorization
service. Claim owner fields are binding information, not proof of access.

The app-wide existing claim executor calls `client.checkClaimDispatch` before each
claim side effect, including forms reopened outside Companion. It supplies the
actual Flow owner and the digest of executable answers.

- **The card** (`cardRef`, `operationKey`, `valuesDigest`) needs its exact
  unexpired `reserved` record with the reviewed schema, collection and digest.
  The operation key is consumed atomically, once; a second tab or a replay gets
  409 `dispatch_consumed`.
- **The ordinary form** (no `cardRef`) goes ahead unless a Companion operation
  for the step already consumed its key or was reported observed (409
  `dispatch_consumed`: check the claims list). Any other draft for the step,
  open, expired, cancelled, or reserved without having been dispatched, is
  superseded in the same transaction, so its card can no longer pass this
  check and an abandoned card never locks the step.

The dispatch check stays authenticated and active when new draft
preparation is disabled, so disabling the feature cannot bypass existing records.
This check is only a duplicate-effect precondition; the existing executor must
still check authorization and signing. It must be installed in the app-wide
claim handler, not only in the transient card UI.

Only the host exposes reserve/observe/claim-dispatch; never register either as an agent tool.
A fresh reservation is metadata, not consent or permission to execute. Dispatch
only when `replayed === false`, after checking the current account, network,
session, owner, schema digest, revision and reviewed values against the existing
Flow executor. Pass the reserved operation key into that existing path. Once
reserved, the draft cannot be edited, cancelled or reserved again. A lost
acknowledgment remains `outcome-unknown`; reconcile the existing operation and
never create another submission merely to retry the card request. `observe` is
accepted after the draft expired, so a late outcome is still recorded. A step
whose operation reached the claim service stays closed to further managed or
manual submissions in that run, because only the claim service can tell whether
it succeeded; there is no reconciliation endpoint yet, so the person continues
with a new run.

`observed` records a caller-reported executor reference only. It never means
verified completion. Re-read the trusted Flow/claim owner for completion and
receipt evidence. Questions and artifact references can use the same private
proposal service but cannot obtain claim dispatch reservations.

Draft values have a 64 KiB bound and drafts expire for mutation after seven days.
Existing expired references remain historical and must be rendered noninteractive.
Ended drafts carry `cancelReason`: `user` (cancelled by the person or agent) or
`superseded` (the step was submitted from the form, or a newer card replaced a
stale one).

Storage is the user object's key-value store, with three indexes so no request
scans every record: one per session (lists read at most 50 keys and fetch the
records in one batched read), one by expiry, and one from each record to its
request tombstones. Retention runs after each new draft and handles at most 16
records whose `expiresAt` is more than 30 days past: an abandoned draft is
deleted with its owner key, indexes and request tombstones; a draft whose
operation reached the claim service keeps its record, reservation and dispatch
tombstone (they stop a duplicate claim) but loses its draft values. A user who
never prepares another draft keeps their expired records until they do.
Durable Object storage survives isolate reloads; it is separate from the
Matrix/VFS SQLite owner backup and is not part of it.

Validate with the portable package tests, Workers package typecheck, and
`vitest run src/action-interactions/store.test.ts`. The latter uses workerd and
real Durable Object storage transactions. Live claim/signature execution
remains an independent acceptance gate in Portal.
