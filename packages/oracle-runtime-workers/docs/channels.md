# Channels ingress

`POST /channels/turn` lets IXO Channels submit a text turn to the user's existing oracle session: this deployment's oracle, whether that is the Companion or any other oracle. One runtime serves every channel account (messaging number) bound to this oracle: any registered channel gateway whose DID is listed in `CHANNEL_SERVICE_DID` can bind numbers to this oracle. The route has its own UCAN policy. The generic Portal authentication policy is unchanged.

## Configuration

| Binding or variable            | Purpose                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `CHANNEL_SERVICE_DID`          | The channel service DID allowed to invoke this deployment, or a comma-separated list of them. |
| `AUTH_HUB`                     | Optional Cloudflare service binding to Auth Hub.                                              |
| `AUTH_HUB_URL`                 | Auth Hub HTTPS URL when no service binding is configured.                                     |
| `AUTH_HUB_CHANNEL_SERVICE_KEY` | Dedicated credential for Auth Hub channel validation.                                         |

`CHANNEL_SERVICE_DID` is parsed as a list: entries are split on commas, trimmed, empty entries dropped and duplicates removed (`did:web:a.example, did:web:b.example`). An unset value, or one with no entry left, disables the route: it answers `503` with `Channels are not configured`. Binding validation needs the key and either `AUTH_HUB` or `AUTH_HUB_URL`; the service binding is used when both are set. The validation credential is separate from operator credentials. Neither the channel service nor its grant receives a Matrix access token. Required-ness and wrangler syntax are in [configuration](configuration.md#channels-ingress).

## Authorization

The `Authorization` header contains `Bearer <base64 UCAN CAR>`. The `x-auth-type` header is `ucan`. The invocation uses `@ixo/ucan` 2.2.0.

The proof is a direct delegation from the user DID to a channel service listed in `CHANNEL_SERVICE_DID`. The service that signs the invocation must be a listed DID, and the proof's audience must be that same service: a grant addressed to one listed service cannot be invoked by another. Its sole capability is `ixo:channel/invoke` on `ixo:channel:<bindingId>`. Its caveats contain the provider, binding revision, and this deployment's `ORACLE_DID`. Its expiration is at most five minutes away.

The service invokes the same capability for `ORACLE_DID`. Its expiration is at most 60 seconds away. Its sole fact is `{requestId, requestHash}`. `requestHash` is the lowercase SHA-256 hex digest of the exact UTF-8 JSON request body.

The validator checks both signatures, the exact two-member chain, the resource, the caveats, both audiences, and both lifetimes. Wildcards and additional delegation hops are rejected. The channel proof is never deposited as generic downstream tool authority. Existing tool authorization remains responsible for each consequential action.

The validator records no replay marks: a poll repeats its exact body and may reuse an invocation, also concurrently, and the durable receipt makes every repeat return the same run. Once the invocation proves the user, the request spends one unit of that user's channel budget in `RATE_LIMIT` (key `<ORACLE_DID>|channel|<userDid>`, separate from the Portal's `<ORACLE_DID>|user|<userDid>`, so channel polls never push the user's Portal requests into `429` or the other way round); over the limit it returns `429` before Auth Hub is called.

Auth Hub receives `POST /api/internal/channels/validate-binding` with the dedicated `x-channels-service-key` header. The body contains `userDid`, `bindingId`, `bindingRevision`, `provider`, and `oracleDid`. Only `{active:true}` allows admission. An unavailable validator fails closed.

- **Polls of an existing run skip it.** The shell first asks the user's object whether the request already has a run (receipt and run row, same body). A warm object answers that poll from SQLite, without booting, without the admission lock and without Auth Hub; a finished reply is therefore released even while Auth Hub is down. A cold object, or a request without a run, goes the full way: the binding check, then admission.
- **Active verdicts are cached for 60 s.** Each isolate keeps an `{active:true}` verdict for `CHANNEL_BINDING_CACHE_TTL_MS` (60 s), keyed by oracle, provider, binding ID, binding revision and user DID, in a map bounded to 1,000 entries (the oldest makes room). An inactive binding (`403`) or a failed check (`503`) is never cached. A revocation is therefore noticed by new admissions at most 60 s late, inside the lifetime of the channel grant that authorized the request (at most 300 s), and a new binding revision is a new key.
- **Attempts check again, uncached.** The binding is checked again only before a queued or recovered attempt executes (`LiveRun.attemptSource` is `dequeue` or `recovery`), straight from the user object (no cache); an attempt that starts right after admission is not checked twice. A binding revoked while its run executes does not stop that run, and its finished reply is still answered to polls; the gateway re-resolves the binding before it delivers a reply.

At admission, an unavailable validator returns `503` and nothing is recorded. Before an attempt, the two outcomes differ. An inactive binding ends the run as `failed`. An unavailable or unconfigured validator defers the attempt: the run becomes `recovering` and is retried on the recovery backoff (`RUN_RECOVERY_DELAYS_MS`, default 5 s, 15 s, 30 s, 60 s). It fails only once `RUN_RECOVERY_ATTEMPTS` deferrals are spent. Whether a retry resumes or starts fresh is derived from the run row, so it holds across an object restart. Each run records the session checkpoint it started from (`start_checkpoint_id`, set at begin and again when a queued run is dequeued). A recovery attempt resumes only when the session's checkpoint has advanced since then, meaning the graph persisted part of the run. It then continues with the reply text so far. Otherwise the graph never saw the input, and the attempt runs fresh with it, without a `resumed` frame. Every retry, fresh or resumed, counts against the recovery cap. Rows written before the column existed always resume, as before. An unreadable checkpoint counts as "not advanced", the same as in the recovery-progress check.

## Tool authority

A channel turn runs with the user's full stored delegation to this oracle: the same delegation, and therefore the same tool authority, as a Matrix turn in the user's oracle room. This is a product decision. The channel grant itself never becomes tool authority, and a channel request that carries a delegation is refused with `403`.

A channel cannot recover a missing delegation. The `delegation_required` re-authorization prompt is posted only for Matrix turns. A NEW channel request is therefore refused, before it is recorded as a run and before any session marker is sent, unless the user's stored delegation is usable: present, with a known expiry, and with more than `CHANNEL_DELEGATION_MIN_REMAINING_SECONDS` (900 s) left, so that a turn never outlives the delegation its tools, memory, files and owner-copy flush run under. The response is `428` with code `delegation_required` and `Delegation required: the user must authorize this oracle again`. The same answer comes back when the delegation exists but cannot load the user's owner copy because it lacks the `ixo:filesystem` grant over `/.oracles` (the boot's `NO_VFS_DELEGATION`). The gateway should tell the user to open the oracle and authorize it. Retrying the same request ID after re-authorization admits it: `POST /delegation` hands the new delegation and its expiry to the user's object at once.

The margin applies where it matters, and nowhere else:

- **At the admission of a new request** (no run yet for its request ID).
- **As its run starts** (`runAttempt`, every attempt): if the delegation is gone or inside the margin when a queued or recovered attempt starts, the run ends as `failed`.
- **Never on a poll.** A poll of a run that exists answers its status (and a finished reply) whatever the delegation's state: inside the margin, expired or revoked.
- **Before a cold object boots** only a live delegation is required (present and not expired), because the boot may load the owner copy under it. A user with none, or an expired one, gets `428` before anything boots; one inside the margin boots, and admission decides. A cold object is rare while a run is live (its keep-alive alarm keeps the object loaded), but follows a deploy: such a poll is answered as long as the delegation has not expired outright.

When the delegation the object holds is inside the margin, a new request re-reads the `ucan_delegation` room state at once (not throttled; the 60 s throttle stays for true misses, when nothing is stored) and adopts a deposit there that outlives the held copy. A `POST /delegation` whose push to the object failed is therefore picked up by the next new request, not up to 15 minutes later.

The object holds the delegation with its expiry (unix seconds), taken from where it arrived: the shell's validation of a request header, the stored deposit record, the `ucan_delegation` room state, or `POST /delegation`. When none states one, the expiry is read off the token itself (the earliest `exp` along its proof chain). A token whose expiry cannot be read is treated as unusable for channel turns. Portal, Matrix and HTTP turns are not checked against the margin; the Portal SDK renews its own delegation.

## Request

```json
{
  "provider": "whatsapp",
  "bindingId": "chb_example",
  "bindingRevision": 1,
  "requestId": "wa:example",
  "remoteMessageRef": "hmac:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "message": "Help me plan my week",
  "context": { "kind": "oracle" }
}
```

`provider` is a provider id matching `^[a-z][a-z0-9_-]{0,31}$` (`whatsapp` today). The runtime does not enumerate providers: it echoes the id into the grant check (`nb.provider`), the Auth Hub binding check and the `org.ixo.qi.origin` Matrix event, and an id without its own delivery profile is shaped with the generic chat profile (WhatsApp keeps its own). `context.kind` is `oracle` (the gateway's value) or `companion` (accepted for gateways that predate channel accounts); the object is strict, so any other kind or extra field is `400 invalid_request`. The kind does not change behaviour: the oracle is always this deployment's.

`sessionId` is optional on the first request. An existing session must belong to this user and the canonical encrypted oracle room. The session is checked when a request is bound to it, before it starts a run; a poll of an admitted request checks nothing and writes nothing, so it does not mark the user's database dirty. Subsequent messages reuse the binding's session by default. Deleting that session releases the binding: its next message opens a new session.

An oracle can opt into [channel conversation routing](channel-routing.md) with `CHANNEL_SEMANTIC_ROUTING=shadow|on` (default `off`) and an optional binding allowlist. Only channel admission calls the router; Portal and Matrix remain explicit. In `on`, the runtime owns destination selection and treats the gateway's `sessionId` as a hint. `sessionPolicy: "continue"` bypasses semantic selection for an explicit correction. Explicit new/resume controls pin the next admitted turn. The router persists assignments before execution and can clarify without an agent or tools; automatic switching never cancels work. Off-mode session-conflict behavior below is unchanged.

A new request that names a session the user's object no longer holds (deleted in Qi.Space, or never created there) is answered `409 session_conflict`, its receipt is removed and the binding forgets that session. The gateway clears its stored session and sends the **same request ID again without `sessionId`**; that resend is a new body under a free request ID and opens a new session. A request without `sessionId` whose binding still pointed at a deleted session opens a new session at once, with no round trip. A session that exists but is not this user's oracle session (another room, a local session) stays `404 session_not_found`.

Topics, attachments, provider identifiers, and caller-supplied user identities are not accepted. The body limit is 64,000 bytes. Text is limited to 16,000 characters.

## Responses and retries

An admitted turn returns `202` with `requestId`, `runId`, `sessionId`, and a `queued`, `running`, or `recovering` status. A terminal turn returns `200` with its terminal status. A `finished` turn also contains `text` and, when available, `messageId`.

`finished` is the only successful terminal status. Its `text` may be empty after a tool-only completion; the gateway must complete delivery without sending an empty provider message. An absent `messageId` does not mean the turn should be retried.

Polling repeats the original POST body exactly. A fresh UCAN invocation can authorize the same body. Adding the returned session ID to a pending request changes the body and returns `409`. The returned session ID belongs on a later message.

### Admission order

1. The shell reads the body (`400 invalid_request`, `413 request_too_large`), parses it, and verifies the channel invocation (`401 unauthorized`, `403 scope_mismatch`).
2. The user's channel rate limit (`429 rate_limited`).
3. The poll path: a warm user object whose receipt for this request (same body) has a run answers its status now (`202`/`200`). Nothing else happens; steps 4–6 are skipped.
4. The Auth Hub binding check, or a cached active verdict under 60 s old (`403 binding_inactive`, `503 binding_check_unavailable` / `not_configured`).
5. The user's object refuses a request that carries a delegation header (`403 channel_grant_not_tool_authority`). A cold object then needs a live delegation (loaded from storage or the deposited room state; `428 delegation_required`) before it boots, importing the owner copy on a cold start. `NO_VFS_DELEGATION` becomes `428 delegation_required`; the file storage rejecting the oracle (`VFS_AUTH_FAILED`) becomes `403 storage_unauthorized`; any other boot failure is a `503 unavailable`.
6. Admission, in three steps so the per-user admission lock never waits on Matrix:
   1. Under the lock, SQLite only: the receipt (`410 response_expired`, `409 request_conflict`; a request whose run exists is answered here), and the binding's session (`409 session_conflict`).
   2. Outside the lock: the delegation of a new request (`428 delegation_required`), then the session marker of a binding's first message (`428 room_not_ready`) and the session check (`409 session_conflict` for a session that is gone, `404 session_not_found`, `409 room_not_encrypted`). A homeserver refusal of the oracle in the room is `409 room_unavailable`.
   3. Under the lock, SQLite only: bind the session, record the owed room mirrors, begin the run (`202`).

A request refused in step 6 before its run began leaves no receipt: the same request ID can be sent again, with the same or another body.

### Errors

Every refusal has the body `{ "code": "<code>", "message": "<text>" }`. A gateway maps it by `code` first and by status second. `428` (Precondition Required) means a precondition on the user's side is missing: the gateway tells the user what to fix and retries the same request once it is fixed; it is never treated as a transient outage. `503` is transient and may be retried with backoff. Two refusals report failures that retrying cannot fix, and are final: `409 room_unavailable` and `403 storage_unauthorized`. The gateway should answer them with its failure reply at once instead of retrying.

| Status | `code`                             | Meaning                                                                                                                                                   |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_request`                  | Body missing, not UTF-8, not JSON, or not the request shape.                                                                                              |
| `401`  | `unauthorized`                     | No valid user-rooted channel invocation (header, chain, grant or lifetime).                                                                               |
| `403`  | `scope_mismatch`                   | The invocation does not cover this binding, provider, revision, oracle or body.                                                                           |
| `403`  | `binding_inactive`                 | Auth Hub reports the binding inactive.                                                                                                                    |
| `403`  | `identity_required`                | The binding check got no channel identity.                                                                                                                |
| `403`  | `identity_mismatch`                | The channel identity does not match the request.                                                                                                          |
| `403`  | `channel_grant_not_tool_authority` | A channel request carried a delegation.                                                                                                                   |
| `403`  | `storage_unauthorized`             | Final. The user's file storage rejected the oracle's credentials (VFS 401/403) while the owner copy loaded. Do not retry; send the failure reply.         |
| `404`  | `session_not_found`                | The session exists but is not this user's session in the user's oracle room.                                                                              |
| `409`  | `request_conflict`                 | The request ID already belongs to another message body.                                                                                                   |
| `409`  | `session_conflict`                 | The binding already has another session, or the named session is gone. Clear the stored session and resend the same request ID without `sessionId`.       |
| `409`  | `room_not_encrypted`               | The user's oracle room is not end-to-end encrypted.                                                                                                       |
| `409`  | `room_unavailable`                 | Final. The homeserver refuses the oracle in the user's oracle room (`M_FORBIDDEN`/403, the bot is not a member). Do not retry; send the failure reply.    |
| `410`  | `response_expired`                 | The run was pruned; the request cannot execute again.                                                                                                     |
| `413`  | `request_too_large`                | The body is over 64,000 bytes.                                                                                                                            |
| `428`  | `delegation_required`              | No usable delegation: none, unknown expiry, under 900 s left, or no file-storage grant. Re-authorize.                                                     |
| `428`  | `room_not_ready`                   | The user has no oracle room yet. Finish the oracle's setup.                                                                                               |
| `429`  | `rate_limited`                     | Over the user's rate limit.                                                                                                                               |
| `503`  | `not_configured`                   | Channels or Auth Hub binding validation are not configured (or `AUTH_HUB_URL` is not HTTPS).                                                              |
| `503`  | `binding_check_unavailable`        | Auth Hub could not be reached or answered badly.                                                                                                          |
| `503`  | `unavailable`                      | Anything else. The shell logs `[channels] turn failed unexpectedly: <name>: <message>` (the message bounded to 300 characters, nothing from the request). |

### Durability

The tuple `(userDid, bindingId, requestId)` identifies one durable run. Concurrent submissions and requests after object restarts reuse it. A different request body under that tuple returns `409 request_conflict`. An aborted, failed, or interrupted run remains terminal. Retrying it never starts a replacement model or tool execution.

Completed channel runs follow the ordinary seven-day run retention: database boot removes their request, answer, segments, and tool marks, set-based in one transaction. The same transaction retains only a tombstone: the run ID, its terminal status and when it was pruned. Until then, the receipt keeps the binding ID, request ID, body hash, run ID, session ID, when it was written, and the state of its oracle room mirrors, inside the user-scoped database. The same boot removes the receipt of every tombstoned run. No message text enters the receipt or tombstone. Any request for a pruned run returns `410 response_expired`, whatever its body, and writes no new receipt, for as long as its tombstone exists. The canonical session and Matrix transcript keep their existing retention policy.

Pruning, from the user object's housekeeping alarm, in batches of at most 200 rows per table and tick (a full batch comes back a minute later):

- **Receipts whose request never started a run**, once 7 days old (`CHANNEL_RECORD_RETENTION_MS`). A request refused before its run began removes its own receipt at once; what is left is the rare request whose object stopped between its receipt and its run.
- **Tombstones**, 7 days after their run was pruned, so about 14 days after the run ended. **Replay horizon:** a request ID sent again after that is a new request and runs again. A gateway must not reuse a request ID for a different message, and must not resend an old one after this horizon.

Storage growth is therefore bounded by two weeks of channel traffic per user: under 100 bytes per tombstone, plus one receipt per live or recent request.

## Reply Plans

A finished turn also carries `plan`, the reply as the ordered parts to deliver. `text` is then the plan as one Markdown message, with artefacts as links, for gateways that predate plans (without a plan it is the model's reply). A gateway that reads `plan` ignores `text`. The user's oracle room mirror shows the same rendering, posted once per run. The run record itself keeps the model's own text.

```json
{
  "status": "finished",
  "text": "Here's the week…",
  "plan": {
    "v": 1,
    "parts": [
      {
        "partId": "p1",
        "kind": "text",
        "text": "Here's the week. **Wednesday** is the tight one."
      },
      {
        "partId": "p2",
        "kind": "artifact",
        "artifact": {
          "artifactId": "3f9a…",
          "title": "Week plan",
          "url": "https://companion.example/a/3f9a…#k=…",
          "mime": "text/markdown",
          "bytes": 2140,
          "expiresAt": "2026-10-25T09:00:00.000Z"
        }
      },
      {
        "partId": "p3",
        "kind": "text",
        "text": "Want me to block the focus time?"
      }
    ]
  }
}
```

- **Order and identity.** Parts are delivered in order. `partId` is stable for the run, so `(userDid, bindingId, requestId, partId)` identifies one provider message. A re-poll returns the same plan.
- **Text is chat Markdown:** `**bold**`, `_italic_`, `~~strike~~`, inline code, fenced code, `-` and `1.` lists, `>` quotes and links. It has no headings, tables or HTML. The gateway maps it to provider syntax. A part fits the profile's `bubbleMax` (1,500 characters on WhatsApp); the gateway still splits at the provider's hard limit and never truncates.
- **An artefact is a link to a document** the user opens in a browser. Send it as a button or a link with previews off. The title can be up to 120 characters; shorten it where a provider needs less (a WhatsApp CTA header takes 60).
- **Nothing to send.** An empty `parts`, like an empty `text`, completes delivery without a provider message. `plan` is absent when a run finished without one (a run from before plans); fall back to `text`.
- **At most `maxPartsPerRun` parts** (6 on WhatsApp). A gateway may still merge adjacent text parts to respect a provider's pacing.

The runtime picks the WhatsApp, Telegram or Slack profile from `provider`, and a generic chat profile for any provider without a profile of its own (a provider id equal to another profile's name, `matrix` or `generic`, gets that profile). See [chat delivery](chat-delivery.md).

## Matrix continuity

The session marker uses a deterministic transaction ID for the binding and the request that opens the session. Message mirrors use deterministic transaction IDs for the user, binding, request, and author. A lost response or a retried mirror therefore reuses the original Matrix event.

Matrix is off the channel critical path. The only Matrix send a channel request waits for is the session marker of a binding's first message (its event ID is the session ID); concurrent first messages of one binding share that marker. The user's oracle room mirrors are owed by the request's receipt and sent in the background:

- **Owed durably.** Admission records that the run owes the room its user message, then begins the run without waiting for Matrix. When the run ends, its reply (the rendered Reply Plan, as the channel user received it) is owed too, or nothing more when it ended without one. Each mirror is recorded in the receipt once it is posted, and is never sent twice.
- **Answered first.** A poll of a finished run returns `finished` with `text` and `plan` at once, whether its mirror succeeded, is still in flight, or failed. A mirror failure never fails or delays a turn or a poll, and the admission lock is never held across a Matrix call.
- **Retried, then abandoned.** A failed mirror is retried by the user object's alarm with backoff (1 minute, doubling, at most an hour), with the same transaction ID. It is abandoned after 8 failed attempts (about 3 hours), or at once when the homeserver refuses the oracle in the room (`M_FORBIDDEN`/403). Each failure logs one counter line, `[channels] channel_mirror_failed=1 author=… run=… session=… attempt=n retry_at=…: <error>`, and an abandoned mirror logs `[channels] channel_mirror_abandoned=1 … reason=room_forbidden|attempts_spent: <error>`.
- **In order per session, eventually.** Within a session the mirrors are posted in the order they became due (each user message before its reply), and a failed mirror holds the session's later mirrors back until it succeeds or is abandoned. Qi.Space can therefore lag the WhatsApp conversation, and, after an abandonment, miss a message, but never shows it out of order. Portal mirrors of the same session are not held back by a failed channel mirror.

Both mirrors use the gateway's encrypted timeline event path (`sendEvent`, which carries the `org.ixo.qi.origin` content). That path, in `@ixo/matrix-bot-workers-sdk` 0.7.0, sends at the `interactive` priority and keeps no outbox of its own: the receipt is the outbox. Sending channel mirrors at the `background` priority needs a `priority` option on the SDK's `sendEvent`.

Whether a room is end-to-end encrypted is asked from the homeserver once per room: encryption cannot be turned off in Matrix, so a "yes" is kept in the user object (memory and storage). The user's oracle room is resolved once per object instance.

The `org.ixo.qi.origin` content contains only `v`, `transport`, `binding_id`, and `remote_ref`. This metadata is inside the encrypted event. It contains no phone number, raw message ID, contact ID, or profile name. Human messages also expose the same envelope through `metadata` in both session-history APIs.

## Validation limits

The focused workerd tests exercise real UCAN signatures, negative authorization cases, concurrent duplicate admission, SQLite close and reopen, an abrupt Durable Object abort immediately after admission, session reuse, ownership rejection, and required mirror failures. They also cover a session released by its deletion, a reply mirrored once across the run end and repeated polls, the missing-delegation refusal, and receipt pruning. `src/channels/turns.test.ts` also proves that a turn is admitted and a finished reply answered while the mirrors hang or fail, that a hanging mirror does not hold up another request or a poll, that failed mirrors are retried from the alarm in order and abandoned on `M_FORBIDDEN`, that a request naming a deleted session answers `409 session_conflict` without a receipt and its resend without `sessionId` opens a new session, and the 7-day pruning of receipts and tombstones; `src/shell/channel-route.test.ts` that a poll of an existing run makes no Auth Hub call (also while Auth Hub is down), that active verdicts are cached for 60 s and refusals never, and that channel requests have their own rate-limit key; `src/do/user-object-lifecycle.test.ts` that a poll answers under a delegation inside the margin while a new request is refused, that a delegation inside the margin re-reads the deposited room state, that VFS 401/403 answers `403 storage_unauthorized` and a homeserver 403 `409 room_unavailable`, and that the encryption check is cached. A channel run driven by the run coordinator over the real SQLite store keeps its reply. Run coordinator tests cover enqueue order and deferred attempts. `src/channels/turns.test.ts` proves that repeated polls make no extra dirty mark or session check, `src/shell/channel-route.test.ts` that an over-limit request gets `429` without an Auth Hub call and that two concurrent identical requests under one invocation are both admitted, and that every refusal carries `{ code, message }` while an unexpected failure answers `503 unavailable` and is logged, and `src/do/user-object-lifecycle.test.ts` that the binding is not checked again after the shell did, that a missing or expired delegation is refused with `428` before the object boots, that a boot failing with `NO_VFS_DELEGATION` answers `428` while any other unclassified failure propagates, that a delegation deposited after a refusal is admitted at once, and that a missing Companion room answers `428 room_not_ready`. These tests do not contact a live model, Auth Hub, WhatsApp, or Matrix homeserver.

Companion's `feat/workers-runtime` deployment must adopt the released runtime and configure these bindings. Live onboarding, revocation, encrypted Matrix event inspection, and provider delivery remain deployment acceptance checks. `pnpm test:e2e:channels` in the example app is the operator-run acceptance harness for them ([testing](testing.md#harness-end-to-end-minutes-local); its variables and checkpoints are in [`docs/testing/channels-acceptance.md`](../../../docs/testing/channels-acceptance.md)).

## Quoted replies and conversation controls

`ChannelTurnBody.replyTo` is optional. A known reference carries `kind: "known"`, the originating `requestId`, `author` (`user` or `oracle`), and optionally a reply `partId`; an unresolved reference carries `kind: "unavailable"`. The runtime reads canonical content from that binding's request receipt only when it belongs to the selected session. With routing off or in shadow, this is the current session. With routing on, a verified quote can first select an older owned session within the same binding and consent revision. A split-bubble suffix resolves to its parent reply part. Unavailable references prompt clarification. Quoted text is untrusted context and never changes action authority. Canonical user messages and encrypted room mirrors retain the typed `org.ixo.qi.reply` reference; the model-only quotation note is hidden from the visible transcript and indexing.

`POST /channels/control` uses the same exact-body UCAN validation, channel rate limit, and Auth Hub binding check as a new turn. The body contains `provider`, `bindingId`, `bindingRevision`, `requestId`, up to 64 `cancelRequestIds`, and `command`:

- `{kind: "stop"}` cancels the named requests and returns the binding's current session.
- `{kind: "status"}` returns the current session; its cancellation list must be empty.
- `{kind: "new"}` cancels named work and creates an idempotent session marker under the user's existing encrypted oracle room.
- `{kind: "resume", sessionId}` validates the destination before cancelling work, then binds the owned session.

The response contains `requestId`, `sessionId` (nullable before the first session), and the command kind. Controls use durable receipts separate from turn receipts. An altered body under the same control ID returns `request_conflict`; identical retries return the original result. Cancellation tombstones reserve even not-yet-admitted turns. Admission, queued attempts, and recovery check that reservation. A run still winding down returns `503 unavailable`, so the gateway cannot acknowledge a completed stop prematurely. Matrix I/O and stopping runs happen outside the SQLite admission lock. A later control can cancel an older session switch while its Matrix call is outstanding; the older switch cannot subsequently rebind the channel. Cancelling never undoes completed external effects.

Finished channel runs trigger incremental session-history indexing without waiting for an upload. A completion during an upload schedules another pass for the final tail. The existing watermark, scoped memory invocation, cache invalidation, failure backoff, and task exclusions apply. Channel turns adopt the room cache's current gathered context on subsequent turns, including empty slots; other clients retain their first-contact policy. A failed or timed-out gather leaves the prior checkpointed context usable. This provides bounded freshness rather than synchronous memory extraction.

Deploy this runtime before the matching gateway. No additional Auth Hub grant or room topology is introduced. Control receipts and cancellation reservations use `CHANNEL_RECORD_RETENTION_MS`; they are pruned in bounded housekeeping batches.
