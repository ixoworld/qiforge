# Private action interaction drafts

`@ixo/action-interactions` is the portable Zod 4 wire contract and authenticated
fetch client. It has no editor, React or runtime dependencies. The client SDK
also exports it through `@ixo/oracles-client-sdk/action-interactions`.

The public `/health` response advertises `actionInteractions: {version: 1, owners, operations}` only when enabled. This is protocol negotiation, not proof of deployment acceptance or collection authority.

The Workers shell enables the routes only with
`ACTION_INTERACTIONS_ENABLED=true`. Every route requires a signed UCAN invocation,
uses the authenticated user DID to select that user's Durable Object, and checks
that the session still exists in that object. No body can select another user
or oracle. The oracle DID comes from runtime configuration.

| Request                                      | Purpose                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| `GET /action-interactions?sessionId=...`     | List private interaction drafts                       |
| `GET /action-interactions/:id?sessionId=...` | Read an opaque reference                              |
| `POST /action-interactions`                  | Prepare or reopen an owner-bound draft                |
| `PATCH /action-interactions/:id`             | Apply answer values or cancel                         |
| `POST /action-interactions/:id/reserve`      | Host reserves the reviewed revision and digest        |
| `POST /action-interactions/:id/observe`      | Host records an unknown outcome or executor reference |

Mutations use UUID request IDs. Reusing a request ID with different content
fails. A replay returns the current interaction and `replayed: true`. All edits
and reservations use compare-and-swap revisions inside real DO transactions.
Preparing the same immutable owner in its original session returns the existing draft; claim owner keys also prevent independent reservations from another session. Changed collection or schema bindings fail closed.
opening another card cannot obtain an independent dispatch reservation.
Updates may include `remove: string[]` for fields cleared by SurveyJS. A removed field must be unique and absent from `patch`. User removals are remembered in `updatedByUser`, so later agent pre-fill cannot restore a deliberately cleared value. Agent updates and removals preserve fields edited by the user. Host integrations must set
`source: user` for genuine user edits and `source: agent` for model pre-fill.

The server validates structural JSON and immutable owner context. The live Flow
adapter must validate its actual SurveyJS schema and authorization before it
reserves or dispatches. The personal store is not a collection authorization
service. Claim owner fields are binding information, not proof of access.

The app-wide existing claim executor calls `client.checkClaimDispatch` before each
claim side effect, including forms reopened outside Companion. It supplies the
actual Flow owner and the digest of executable answers. An owner with no personal
draft may continue its existing manual path. A managed owner requires its exact
`cardRef`, reserved `operationKey`, reviewed `valuesDigest`, live schema/collection,
and an unexpired `reserved` record. The operation key is atomically consumed once;
a second tab, replay, unknown outcome, or reopened unkeyed manual form fails
closed. The dispatch check stays authenticated and active when new draft
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
never create another submission merely to retry the card request.

`observed` records a caller-reported executor reference only. It never means
verified completion. Re-read the trusted Flow/claim owner for completion and
receipt evidence. Questions and artifact references can use the same private
proposal service but cannot obtain claim dispatch reservations.

Draft values have a 64 KiB bound and drafts expire for mutation after seven days.
Existing expired references remain historical and must be rendered noninteractive.
The DO retains drafts and request/owner tombstones; this initial API does not
claim automatic physical erasure or cross-device owner-store backup. Durable DO
storage survives isolate reloads; it is separate from the Matrix/VFS SQLite
owner backup. A future retention policy must retain reservation tombstones long
enough to prevent replay while deleting sensitive draft values.

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
| `flow-bid`         | Claim fields plus `roleId` and optional `groupId`                                 | Existing Flow bid executor      |
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
The HTTP JSON body limit is 2 MiB. JSON escaping and overhead count toward it.

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
