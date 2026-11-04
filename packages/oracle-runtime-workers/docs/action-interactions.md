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
or oracle. The oracle DID comes from runtime configuration. Requests are parsed
before a user object is addressed: only the shapes below exist, path ids must
be UUIDs and `sessionId` is at most 512 characters; anything else is 404 or 400,
and every refusal of these routes (including a body over 96 KiB, or over
2 MiB for a prepare) is JSON
`{code, message}`. The shell's shared authentication (401) and rate limit (429)
answer `{statusCode, message}`; the client turns those into the codes
`unauthorized` and `rate_limited`.
Card routes use three per-user buckets of their own on the same binding, apart
from chat turns (`<oracle>|<bucket>|<user>`): `card-read` for reads (`GET`),
`card-dispatch` for the two dispatch checks, and `card-write` for every other
card request. Cards left open or edited on screen never use up the budget of
chat turns, and neither chat nor card edits can use up the dispatch check: the
Portal treats its 429 as "could not ask" and lets the submission through.

| Request                                      | Purpose                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /action-interactions?sessionId=...`     | The session's 50 newest drafts, oldest first                                       |
| `GET /action-interactions/:id?sessionId=...` | Read an opaque reference                                                           |
| `POST /action-interactions`                  | Prepare or reopen an owner-bound draft                                             |
| `PATCH /action-interactions/:id`             | Apply answer values or cancel                                                      |
| `POST /action-interactions/:id/reserve`      | Host reserves the reviewed revision and digest                                     |
| `POST /action-interactions/:id/observe`      | Host records an unknown outcome, a reported executor reference, or `not-submitted` |

Mutations use UUID request IDs. Reusing a request ID with different content
fails. A replay returns the current interaction and `replayed: true`. A prepare
is remembered by request ID until retention; an edit, reserve or observe only in
its record's window of the 16 newest requests (an older retry fails the
revision check instead, which never applies an edit twice). All edits and
reservations use compare-and-swap revisions inside real DO transactions.
A claim step (account, network, Flow, run, step) has at most one current draft,
whichever chat prepared it. Preparing it again:

| Existing draft for the step                                      | Result                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| None, cancelled, or expired (an expired reservation included)    | A new draft; the old one ends `cancelled`/`superseded`            |
| Open in this chat, same collection and schema                    | The existing draft, `replayed: true`                              |
| Open in this chat, collection or schema changed                  | A new draft for the new form; the old one is superseded           |
| Open or being dispatched in another chat                         | 409 `target_in_use`                                               |
| Being dispatched in this chat, form changed                      | 409 `target_changed`                                              |
| Its operation reached the claim service, or the host reported it | Same chat and form: the record; otherwise 409 `dispatch_consumed` |
| The ordinary form already passed its dispatch check for the step | 409 `dispatch_consumed` (a card could file the same claim again)  |

Question and artifact owners are keyed per chat and follow the same rules
without reservations.
Updates may include `remove: string[]` for fields cleared by SurveyJS. A removed field must be unique and absent from `patch`. User removals are remembered in `updatedByUser`, so later agent pre-fill cannot restore a deliberately cleared value. Agent updates and removals preserve fields edited by the user. Host integrations must set
`source: user` for genuine user edits and `source: agent` for model pre-fill.

The server validates structural JSON and immutable owner context. The live Flow
adapter must validate its actual SurveyJS schema and authorization before it
reserves or dispatches. The personal store is not a collection authorization
service. Claim owner fields are binding information, not proof of access.

A host calls `client.checkClaimDispatch` before every claim side effect on a
Flow claim step: the claim form (with or without a card, also when reopened
outside Companion) and an agent-run execution of the same step. It supplies the
actual Flow owner and the digest of executable answers. The check never boots
the user object, so it is one small Durable Object call.

- **The card** (`cardRef`, `operationKey`, `valuesDigest`) needs its exact
  unexpired `reserved` record with the reviewed schema, collection and digest.
  The operation key is consumed atomically, once; a second tab or a replay gets
  409 `dispatch_consumed`.
- **The ordinary form** (no `cardRef`) goes ahead unless a Companion operation
  for the step already consumed its key or was reported observed (409
  `dispatch_consumed`: check the claims list). Any other draft for the step,
  open, expired, cancelled, or reserved without having been dispatched, is
  superseded in the same transaction, so its card can no longer pass this
  check and an abandoned card never locks the step. The step is also marked
  as submitted from the form, so no card prepared afterwards can file the
  same claim (it gets 409 `dispatch_consumed`); the mark is written before the
  form signs, so a form submission the person then abandons still closes the
  step to cards for that run.

The check never boots the user object: it reads the stored user binding and a
few keys, so an ordinary claim from someone who never used Companion costs one
small Durable Object call, and an idle owner copy is never imported for it.

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
reserved, the draft cannot be edited or reserved again; until its dispatch
check passes it can still be cancelled (a reserve whose acknowledgement was
lost, a closed tab). After dispatch, the host reports one outcome:

- `not-submitted`: the executor refused before sending anything (a declined
  signature, an eligibility or input refusal). Accepted only while the record
  is `reserved`; the card ends `cancelled`/`not-submitted` and the step is free
  for the form or a new card. The operation key is never accepted again.
- `unknown`: the acknowledgement was lost or the result is uncertain. Reconcile
  the existing operation; never create another submission merely to retry.
- `reported`: the executor returned a reference.

`observe` is accepted after the draft expired, so a late outcome is still
recorded. A step whose operation reached the claim service with an `unknown`
or `reported` outcome stays closed to further managed or manual submissions in
that run, because only the claim service can tell whether it succeeded; there
is no reconciliation endpoint yet, so the person continues with a new run.

`observed` records a caller-reported executor reference only. It never means
verified completion. Re-read the trusted Flow/claim owner for completion and
receipt evidence. Questions and artifact references can use the same private
proposal service but cannot obtain claim dispatch reservations.

Draft values have a 64 KiB bound and drafts expire for mutation after seven days.
Existing expired references remain historical and must be rendered noninteractive.
Ended drafts carry `cancelReason`: `user` (cancelled by the person or agent),
`superseded` (the step was submitted from the form, or a newer card replaced a
stale or changed-form draft) or `not-submitted` (the executor refused before
sending). Stored records and responses strip unknown fields, so an added field
never breaks an older reader; request bodies stay strict. Adding a value to a
closed list (`status`, `cancelReason`, an owner `kind`) is a contract version
change. A record this version cannot read is answered with 409
`record_unreadable` (never a 500, which the Portal would treat as "could not
ask"), is left out of session lists, and is kept untouched by retention.
A chat creates at most 200 cards within one draft lifetime of 7 days (409
`too_many_drafts`); older cards, including kept records of sent claims, do not
count.

Storage is the user object's key-value store, with three indexes so no request
scans every record: one per session (lists read at most 50 keys and fetch the
records in one batched read), one by expiry, and one from each record to its
prepare tombstones. Retention runs after each new draft and on the object's
housekeeping alarm, at most 16 records per pass, for records whose `expiresAt`
is more than 30 days past: an abandoned draft is deleted with its owner key,
indexes and request tombstones; a draft whose operation reached the claim
service keeps its record, reservation and dispatch tombstone (they stop a
duplicate claim) but loses its draft values (with a revision bump). Deleting a
chat applies the same rules to its drafts at once. Values plus the user-edit
list are limited to 64 KiB of UTF-8. The per-step form marks and dispatch
tombstones are a few bytes each and are kept. Card reads and the dispatch
check never boot the user object or count as activity, so open cards neither
import an evicted owner copy nor keep an idle object alive. A task card's read
is the one exception: its summary comes from the task scheduler, so it boots
the object, but it still never counts as activity, so an open task card cannot
keep an idle object from being evicted. When an idle
object's working copy is evicted, its alarm stays armed for the next draft
retention (marked in storage, cleared by any boot) and that wake prunes on the
bare object without importing the owner copy.
Durable Object storage survives isolate reloads; it is separate from the
Matrix/VFS SQLite owner backup and is not part of it.

Validate with the portable package tests, Workers package typecheck, and
`vitest run src/action-interactions/store.test.ts`. The latter uses workerd and
real Durable Object storage transactions. Live claim/signature execution
remains an independent acceptance gate in Portal.

## Additional owner families

The version 1 contract also supports these owner bindings. All are private to the
same authenticated user; ownership names are not execution permissions.

| Kind               | Immutable binding                                                                 | Execution owner                 |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------- |
| `flow-claim-block` | Claim fields, with collection included in the uniqueness key                      | Existing claim-block executor   |
| `flow-bid`         | Claim fields plus `roleId` and optional `groupId`, both in the uniqueness key     | Existing Flow bid executor      |
| `approval`         | `family` (`plugin`, `domain-write`, `recipe-release`), `requestKey`, `accountDid` | Existing host approval handlers |
| `task`             | Existing owner `taskId`                                                           | Scheduler; card is read-only    |

`client.checkDispatch` calls authenticated `POST /action-interactions/dispatch`
with the full owner plus `cardRef`, `operationKey` and `valuesDigest`. This is the
same one-time dispatch precondition as the legacy claim route, which remains
compatible. Unmanaged Flow claims and bids can continue through their existing
manual handler. Approval dispatch always requires a matching managed request.
Both dispatch routes remain active when preparation is disabled.

Approval `values` must contain exactly `{request: <JSON object>}`. The entire
request is immutable after preparation, including edits labelled as user edits.
A request key reused with different executable bytes fails. Only draft approvals
can be cancelled. Reservation does not grant consent, signing or authority.

`observe` accepts an optional JSON `receipt`, bounded to 64 KiB, and a `partial`
outcome in addition to `reported` and `unknown`. Partial effects are durable
checkpoints of the same reserved operation. Use an append-only `receipt.events`
array for file and release-phase effects. A later checkpoint must preserve every
previously acknowledged fact; it cannot remove array entries or change scalar
values. Checkpoints use CAS revisions; after an acknowledgment is lost, read the
current record before reconciling. A final `reported` checkpoint may add a final
summary. Partial and unknown records never release another dispatch reservation.
None of these statuses verifies completion or proves external effects.

Domain-write approval requests accept up to 2 MiB including record overhead
(16 KiB reserved for metadata), enough for the existing 1 MiB UTF-8 write batch.
Other draft values retain the 64 KiB UTF-8 byte limit. Large approval values are
stored as private DO chunks of 24K UTF-16 units, each below the 128 KiB storage
value ceiling, with the metadata and chunks committed in one transaction. They
are never placed in public VFS files. Reads and authenticated session listings
rehydrate the same immutable values; isolate recreation does not lose checkpoints.
The HTTP JSON body limit is 2 MiB for a prepare and 96 KiB for every other
interaction request. JSON escaping and overhead count toward it.

`client.readTask(taskId, sessionId)` calls authenticated
`GET /action-interactions/tasks/:taskId?sessionId=...`. It reads the existing
scheduler record and returns `{task: <get_task summary>}` using the same redaction
as `get_task`; restricted source text and result summaries are omitted. Preparing
a task reference requires an existing task in that user's scheduler. Cards must
read this owner state rather than treating proposal values as current task state.
Pending approval is display-only here; this protocol does not approve an occurrence.

The extension keeps the existing draft store and dispatch precondition rather
than adding a parallel executor. This preserves signing and permissions in the
existing Flow, plugin, domain and release owners. A separate card executor was
rejected because it would duplicate those authority checks and lose their receipts.

For large histories, `client.listReferences(sessionId)` uses
`GET /action-interactions?sessionId=...&view=references` to return metadata
without draft values, user-edit markers or receipts. Read selected references
individually. Full listings fail with `list_too_large` above 8 MiB instead of
materializing an unbounded response. Listings retain the existing 1,000-reference
limit; paging a longer history remains follow-up work.
