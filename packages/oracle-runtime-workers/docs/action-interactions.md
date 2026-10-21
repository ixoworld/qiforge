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
