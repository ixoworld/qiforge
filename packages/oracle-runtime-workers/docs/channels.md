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

The validator records no replay marks: a poll repeats its exact body and may reuse an invocation, also concurrently, and the durable receipt makes every repeat return the same run. Once the invocation proves the user, the request spends one unit of that user's channel budget in `RATE_LIMIT` (key `<ORACLE_DID>|channel|<userDid>`, separate from the Portal's `<ORACLE_DID>|user|<userDid>`, so channel polls never push the user's Portal requests into `429` or the other way round); over the limit it returns `429` before Auth Hub is called. `POST /channels/control` spends its own budget (`<ORACLE_DID>|channel-control|<userDid>`), so a gateway polling hard cannot turn a stop into `429`.

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

Files ride by reference in an optional `attachments` list (1 to 10 entries): each is `{ url, filename, mimetype, size, sha256, kind }`, where `url` is the gateway's signed link to its own copy (`https://<gateway host>/media/<binding id>/<object id>?exp=…&kid=…&sig=…`, valid 30 days; the runtime checks the origin and the path, never the query; never the bytes), `sha256` the lowercase hex digest of what it serves, `size` at most 52,428,800 bytes (the gateway's own 50 MiB bound) and `kind` one of `image`, `video`, `document` or `audio`. A `filename` is never a reason to refuse a turn: one longer than 200 code points is cut to 200, an empty one is named by its kind (`photo`, `video`, `document`, `audio`). `message` still carries the caption or the gateway's placeholder (`[photo]`, `[video]`, `[document: name.pdf]`).

The link is a bearer capability and stays on the server: it is kept on the run's request (`channel.attachments`, for the owner object and for tools) and, for `view_attachment` on later turns, in the user's SQLite table `channel_attachment_links` until it expires or its session is deleted. The model, the hidden notes, the stored message metadata and traces know a file only as `channel:<first 16 hex digits of its sha256>`, which the owner object resolves server-side. A link is fetched only when its origin is the host of a `did:web` in `CHANNEL_SERVICE_DID` and its path lies under `/media/<the binding the file came on>/`, without following redirects, and its bytes are used only when their SHA-256 is the one sent. The file goes to a model as those bytes (a native block, or inline to the helper model), never by URL. One the gateway no longer serves, refuses or serves with other bytes becomes the note `[File "…" (…) could not be downloaded: …]`, without the link, and the turn runs. Files share the turn's 50 MB download budget: a file that does not fit is noted, never the whole turn refused. A file above 25 MB (only a channel video or document can be one) is archived to the sandbox and noted, never handed to a model. Channel files are archived as `<name>-<first 12 hex digits of the digest>.<ext>` (`photo-0123456789ab.jpg`), so two photos the gateway names alike never overwrite each other. A resumed attempt downloads nothing again (the message and its files are in the checkpoint). With semantic routing on, a message with files and only the placeholder is not classified and stays in the current conversation, and a message with files is never answered with a clarifying question (that would drop the files). Tools read the raw list as `ctx.session.channel.attachments` for this turn, for example to keep a photo as claim evidence. Runtimes before this field answer a body that carries it with `400 invalid_request`, so a gateway sends files only to oracles on a runtime that accepts them.

Topic deliverables (Matrix topics), provider identifiers, and caller-supplied user identities are not accepted. The body limit is 64,000 bytes. Text is limited to 16,000 characters.

## Responses and retries

An admitted turn returns `202` with `requestId`, `runId`, `sessionId`, and a `queued`, `running`, or `recovering` status. Every turn response also carries `sessionTitle`, the title of `sessionId` at response time (null while untitled), so a gateway can tell the person when a turn ran in a different session than the one it sent. A terminal turn returns `200` with its terminal status. A `finished` turn also contains `text` and, when available, `messageId`.

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

`ChannelTurnBody.replyTo` is optional. A known reference carries `kind: "known"`, the originating `requestId`, `author` (`user` or `oracle`), and optionally a reply `partId`; an unresolved reference carries `kind: "unavailable"`. The runtime reads canonical content from that binding's request receipt only when it belongs to the selected session. With routing off or in shadow, this is the current session. With routing on, a verified quote can first select an older owned session within the same binding and consent revision. A split-bubble suffix resolves to its parent reply part. Unavailable references prompt clarification. The turn's `replyContext` then says why: `reason: "other_conversation"` when the quoted message is this binding's but belongs to a conversation other than the one the turn runs in (its text is not copied across), `reason: "unknown"` when nothing quotable was found (no receipt, no run, a run that did not finish, an unknown reply part, or a reference the gateway sent as `unavailable`). Quoted text is untrusted context and never changes action authority. Canonical user messages and encrypted room mirrors retain the typed `org.ixo.qi.reply` reference; the model-only quotation note is hidden from the visible transcript and indexing.

`POST /channels/control` uses the same exact-body UCAN validation, channel rate limit, and Auth Hub binding check as a new turn. The body contains `provider`, `bindingId`, `bindingRevision`, `requestId`, up to 64 `cancelRequestIds`, and `command`:

- `{kind: "stop"}` cancels the named requests and returns the binding's current session.
- `{kind: "status"}` returns the current session; its cancellation list must be empty.
- `{kind: "new"}` cancels named work and creates an idempotent session marker under the user's existing encrypted oracle room.
- `{kind: "resume", sessionId}` validates the destination before cancelling work, then binds the owned session. The destination must be a session this binding used at its current consent revision (`channel_session_bindings`, written whenever a turn, `new` or `resume` binds a session); a Portal conversation, another binding's, or one this binding used under an earlier consent revision is `404 session_not_found`. Sessions bound before that table existed are not copied into it: one is accepted when the binding's latest request receipt in it was sent under the current revision, so a session opened by `new` before the upgrade and never written to since cannot be resumed.
- `{kind: "topics"}` lists the binding's sessions; it is read-only for the conversation (it cancels nothing, creates nothing and does not change the bound session) and its cancellation list must be empty. The only thing it writes is bookkeeping: the `channel_session_bindings` rows of sessions the user has deleted are dropped. It returns the sessions recorded there for the binding at its current consent revision plus the bound one (the result's `sessionId`, the same id the list was built from), most recent activity (`sessions.last_updated_at`) first, at most 20; the bound session is always among them. A deleted session is skipped. Each topic is `{sessionId, title, createdAt, updatedAt, lastUser, lastReply}`: `title` is null while untitled, the times are epoch ms, and the two last lines come from the newest request receipt of the session for this binding that is not a routing question (what the person typed, and the reply when its run finished). Titles and lines are normalised to one plain line (whitespace runs become one space; control, format and line-separator characters are removed), and every length is counted in Unicode code points, never UTF-16 units: lines are clipped to 200, titles to 200. Lines are null when nothing is available, when the receipt was sent under an earlier consent revision, or when its stored request cannot be read. `topics` lists at most the 20 most recently active of them and has no age cutoff: an old session is listed as long as it is among the binding's 200 most recently bound. Only those 200 sessions are read (a turn, `new` or `resume` that binds a session refreshes its time), so a session not bound for a long time while 200 others were may be absent even if it was recently active.
- `{kind: "rename", title}` sets the bound session's title, replacing a generated one. The title is normalised as above and must be 1 to 80 code points; the placeholder `Untitled` (any case) is `400 invalid_request`, since the automatic titler would overwrite it. No bound session is `404 session_not_found`, and a refused rename leaves no receipt, so a corrected retry under the same id is accepted. Its cancellation list must be empty.

The response contains `requestId`, `sessionId` (nullable before the first session), the command kind, and `title`: the title of `sessionId` after the command, null when it is untitled, unknown or there is no session (a session still named `Untitled` counts as untitled). A `topics` response adds `topics`. A receipt stored before `title` existed replays with `title: null`. Controls use durable receipts separate from turn receipts. An altered body under the same control ID returns `request_conflict`; identical retries return the original result. A control refused while its destination is checked (`resume` to a session it may not use, `new` without a usable delegation) removes its receipt, so a corrected body under the same ID is accepted. `new` stores the session it created on its receipt; a retry after a later failure reuses it instead of creating another. Cancellation tombstones reserve even not-yet-admitted turns. Admission, queued attempts, and recovery check that reservation, so once the tombstones are written nothing named can start. A request whose run already exists is still answered from that run: a stop that arrives after the run finished does not hide its reply. A stop signals every named run first and then waits once, at most the run supersede grace for all of them together; it answers success even when a run is still winding down (a tool call in flight cannot be interrupted, and retrying the stop would not end it sooner). Matrix I/O and stopping runs happen outside the SQLite admission lock. A later control can cancel an older session switch while its Matrix call is outstanding; the older switch cannot subsequently rebind the channel. Cancelling never undoes completed external effects.

A channel session's history is indexed into the memory engine once the session has been quiet for `CHANNEL_HISTORY_INDEX_DEBOUNCE_MS` (default 3 min) after its last finished run; each finish restarts the wait, so a burst of messages is one upload and one invalidation of the room's prefetch cache. The wait is an in-memory timer: it keeps the user object resident until it fires, and an instance that ends before then (a deploy, a crash) drops it, leaving the tail to the session's next trigger (its next finished run, the next new session, a deletion). Only the tail after the session's `lastProcessedCount` is read, page by page from a cursor the object keeps (a fresh object scans the transcript once), and it is uploaded in chunks of at most 200 messages or 256 KiB of content, the count advancing after each accepted chunk. A run that finishes while the session is being indexed, at any stage, gets one more pass for its tail. After a failed pass the session is not tried again for 1 min, doubling to at most 1 h and reset by a success; a deletion is indexed regardless. The scoped memory invocation and the task exclusions apply as for other sessions.

A later channel turn takes the room cache's gathered context (empty slots included) only when the cache holds a live answer; it never waits for one. On a miss — right after an upload invalidated the room, after the cache TTL, or after a failed gather — the turn keeps its checkpointed context and the room is refreshed in the background (one gather per room at a time), so the refreshed answer reaches a later turn. Only a channel thread's first contact waits, as on other clients; Portal and Matrix threads keep their first-contact context. This is bounded freshness, not synchronous extraction: a fact said in a channel reaches the prompt after the quiet period, the engine's own extraction, and a refresh that a later turn starts.

Deploy this runtime before the matching gateway. No additional Auth Hub grant or room topology is introduced. Control receipts and cancellation reservations use `CHANNEL_RECORD_RETENTION_MS`; they are pruned in bounded housekeeping batches (both tables are indexed on `created_at`). A session's `channel_session_bindings` rows are removed with the session.

# Auth Hub action review (disabled by default)

`HUB_ACTIONS_ENABLED=true` adds the on-demand `request_hub_action`,
`request_chain_transaction` and `hub_action_status` tools plus read-only
`hub_action_capabilities`, `hub_action_options` and
`describe_chain_messages`.
Discover capabilities first: Auth Hub returns enabled kinds, exact registered
form field descriptors, transfer limits, the chain-transaction message types
(`chainTx`) and the configured network. The request tool
accepts a strictly typed candidate operation from
`@ixo/action-protocol`; the runtime adds the authenticated owner, current
channel binding/revision, session, run, request and tool invocation. It checks
the active binding again before calling Auth Hub. The model cannot supply those
identity fields or approve an action. The existing `prepare_action` Portal card
path remains available independently.

The contract is `@ixo/action-protocol` 0.7.0 from npm. This runtime
declares protocol version 5 on its Hub calls (see below). Outcomes still
arrive as `ixo.auth-outcome/2`, so it needs a gateway that parses that
envelope (gateway PR 20); the bank receipts it hands the gateway keep the
0.4.1 shape (see [coin sends](#coin-sends-any-token)).

The oracle uses `AUTH_HUB_URL` (an HTTPS origin) and
`AUTH_HUB_CHANNEL_SERVICE_KEY` to create and read operations; both are
required (the `AUTH_HUB` binding alone is not enough), and the plugin's tools
are offered only when the flag, the URL and the key are all set.

Only a run an inbound channel message started may prepare a review (its run
record carries the channel's `remoteMessageRef`; a scheduled or background run
is refused): that is provenance, not a usage cap, and there are no per-run or
per-user prepare caps (every action still needs the owner's review in Auth
Hub). A retry of the same tool call is the same prepare. A refusal reaches the model
as `{ status: 'unavailable' | 'expired', reason }`. Auth Hub's capabilities
are cached per owner object for 60 s. The Hub's idempotency key is the
SHA-256 hex of `runId:toolCallId` (fixed length). A retry whose reserved
expiry has passed returns the reference recorded for it, or `expired`, and
never POSTs a past expiry. The owner object
reserves the canonical request and stable expiry before the Hub POST, so an
interrupted response can be retried with the same key and bytes. It stores each
immutable initial reference with its original turn in SQLite. The
finished run's Reply Plan contains a `hub-action` part with a typed
`actionReference` and short summary (the plan takes it only from a
`prepared` result whose `summary` equals the reference's title). On a chat
surface (`ctx.session.surface.kind === 'chat'`, which every channel turn is)
the `prepared` result of `request_hub_action` and
`request_chain_transaction` also carries `note`: the user is shown the action automatically as a card
with its title and a "Review action" button, so the model must not repeat
the link or the title, must not say it has not executed or signed anything,
and replies with one short line or nothing. The gateway renders the part as
that card; gateways that predate plans and the Companion room mirror get the
title linked to the review (`planText`). A result on the Portal stream has
no plan and no card, so it carries no note (today both tools refuse anything
but a channel turn). The model's text is delivered as written; the note is
the only guard against a reply that repeats the card. Polling the original
`/channels/turn` request retrieves `hubActionOutcomes` from SQLite first (callback-delivered
outcomes included, so an Auth Hub outage hides nothing already known). A poll
then refreshes at most ONE action that has no terminal outcome (`succeeded`,
`failed`, `declined`) from Auth Hub's authenticated status, with a 3 s timeout
and a per-action backoff of 15 s doubling to 10 min (the attempt is spent
before the read), and stops refreshing an action 24 h after its review
expired. The newer outcome by `sequence` wins; outcome sequences never move
backwards on write (an older one is ignored), and the object is marked dirty
only when an outcome is new or a refresh was scheduled (the backoff is
owner-copy state); a poll that refreshes nothing marks nothing. This read also recovers a callback that was lost.
The callback does not count as user access. Hub rows (requests, references,
outcomes) are pruned from the alarm, at most hourly, 30 days after their
review expired.

Auth Hub can post the same typed event to `/api/internal/actions/outcomes`,
signed with its service DID key: `x-auth-hub-timestamp` (unix seconds),
`x-auth-hub-key-id` (`did:web:<hub host>#key-0`) and `x-auth-hub-signature`
(base64url Ed25519 over `${timestamp}.${audience}.${sha256hex(rawBody)}`).
The route is on when `HUB_ACTIONS_ENABLED=true`, `AUTH_HUB_URL` and
`AUTH_HUB_CHANNEL_SERVICE_KEY` are set, and answers `401` otherwise. The Hub
DID comes from `AUTH_HUB_URL` (never from the request); its document is read
from `${AUTH_HUB_URL}/.well-known/did.json` (https only, at most 64 KB, no
redirects, through `AUTH_HUB` when bound), must carry that exact DID and the
`#key-0` key; only such a document's key is cached, for one hour per isolate.
The checks that need no key run first: all three headers present, the Hub's
key id, a well-formed timestamp within 300 s either way, a signature that
decodes to 64 bytes; a callback failing them causes no Hub read. The document
is read at most once a minute per isolate, whatever the read's outcome (a Hub
`503`, a network error, a document for another DID), and concurrent callbacks
share one read. A signature the cached key does not verify reads it once more
under the same limit (a key rotation). The audience is the origin of
`ORACLE_PUBLIC_URL` when it is set (a Worker reachable under several
hostnames), else the origin of the incoming request URL, so a callback signed
for another oracle, or for another hostname, fails. There is no shared callback secret
any more (`AUTH_HUB_ACTION_OUTCOME_KEY` is removed); an
`x-auth-hub-outcome-key` header the Hub still sends during its transition is
ignored, never required. A valid signature is not trusted on its own: the
receiver checks the event against its stored original reference and confirms
it through Auth Hub's authenticated status API before storing it. A replay of
an outcome already stored at that action id and sequence, with the same
content, is acknowledged without a Hub read. Outcomes are compared in the
0.4.1 receipt shape: an action prepared at protocol version 2 (runtime
0.23.0) gets its callback without the bank `denom`/`amountBaseUnits`, while
the confirming status read (version 3) carries them.
Neither a callback nor a model turn executes a transfer. Hub-owned native
transfer events remain status only. A resource open is not treated as
acceptance or submission.

The operation registry and owner review live in Auth Hub. Enabling this runtime
flag requires compatible Hub routes, registered account and binding policy,
separate inbound/outbound service credentials, and gateway support for typed
`hub-action` parts and `hubActionOutcomes`. Local tests do not establish live
channel, wallet, provider or form-owner acceptance.

Other HTTP hosts can import the framework-independent
`@ixo/oracle-runtime-workers/hub-actions/client` subpath. Pass a registered
oracle key and HTTPS Hub origin to `HubActionClient`, call `capabilities()` to
construct only supported operations, then `request()` with a stable request key
and expiry in Unix **seconds**. Persist both before POST. The same key must
reuse identical bytes on retry. `status(reference.id)` is an authenticated
owner-scoped recovery read; an operation reference alone is never completion.
The `@ixo/oracle-runtime-workers/hub-actions/request` subpath implements these
checks for hosts with a durable `reserve`/`record` store. Envelope versions
are `ixo.auth-action/1`, `ixo.auth-capabilities/2`, `ixo.auth-outcome/2` and
`ixo.auth-options/3`; unsupported kinds and versions fail closed.

The runtime declares protocol version 5 (`?version=5`) on the capabilities,
prepare, status and options calls. Version 5 is the 0.7.0 contract: version 4
plus the application card (`ixo.bid.submit.v1`) and the claim card
(`ixo.claim.submit.v1`), with their receipts `ixo.bid.submission.v1`,
`ixo.claim.submission.v1` and `ixo.submission.failed.v1`; options still
answer `ixo.auth-options/3`. Auth Hub lists and accepts those kinds only at
version 5 (a 0.6.0 parser cannot read them), so Auth Hub must accept version
5 before this runtime is deployed: this runtime needs Auth Hub PR 86 (the
version 5 Hub) deployed on every network it runs on first. An Auth Hub
without version 5 reads `?version=` against its closed list (1 to 4) and
answers each capabilities, prepare, options and status call that declares 5
with `400 invalid_request`: the runtime then tells the model, in fixed
words, that Auth Hub must be updated (`HUB_UPDATE_REQUIRED`), and keeps
every action and outcome it holds; polls keep answering from SQLite and a
Hub callback that cannot be confirmed is refused (`409`), so Auth Hub
retries it. Version 4 is the 0.6.0 contract: version 3
plus chain transactions (capabilities list `ixo.chain.tx.v1` with `chainTx`,
the Hub accepts its prepare, receipts carry `steps`); options still answer
`ixo.auth-options/3`. Auth Hub lists the kind only to version 4 callers (a
version 3 runtime parses capabilities with the 0.5.0 exact-key parser and
would fail on it) and refuses an `ixo.chain.tx.v1` prepare from an older
caller with `400 protocol_version_required`, so Auth Hub must accept version 4
before this runtime is deployed.

Deploy order: Auth Hub (accepts version 5) → channel gateways on @ixo/action-protocol 0.7.0 → runtimes.

Version 3 is the 0.5.0 contract:
capabilities with per-denom `transfer.limits`, any-denom bank sends, receipts
with `denom` and `amountBaseUnits`, options with the owner's tokens. Version 2
callers (runtime 0.23.0) keep the 0.4.1 shapes; without a version Auth Hub
answers v1 (the three P1 kinds only, v1-filtered outcomes) and refuses a P2
prepare with `protocol_version_required`. The Hub stores the version per
action for the outcomes it pushes. Pairing: this runtime must run with gateway PR 20 (it accepts the v2
envelopes and the P2 receipt kinds); gateway PR 19 understands only
`ixo.auth-outcome/1` and must never run against this runtime (a v2 outcome
fails the whole turn). Outcomes arrive as `ixo.auth-outcome/2`; `expired` and
`cancelled` (never executed, receipt null) are terminal like `succeeded`,
`failed` and `declined`, so a poll stops refreshing them. Gateways that read
`hubActionOutcomes` must accept the v2 envelope.

Protocol package `0.5.0` supports bank sends of any listed token, exact signed
statements, Gmail connection/removal and one reviewed plain-text email, Google
Calendar connection/removal and one reviewed event, document read-access
requests, and new private text files. `hub_action_options` requests
`ixo.auth-options/3` and obtains confirmed connections, requestable document
identifiers, existing action resources and the owner's bank tokens for the
current owner and channel binding; an older options version is refused. The
runtime adds `ownerAddress`, the IXO account address read off the owner's
`did:ixo:ixo1…` DID (`null` for any other DID), beside the Hub's `ownerDid`. Each connection carries its `gmail` or `calendar`
service; do not use a profile-only Gmail connection for sending. Old Hub clients
still receive Calendar-only options version 1 by default. The tool accepts no
model-supplied identity. The shared
`operationJsonSchema` is the tool schema source; there is no second runtime
operation catalogue. Capability and options reads may be used by any registered
oracle account with the compatible channel adapter.

## Coin sends (any token)

A coin send is a `cosmos.bank.send` message of `request_chain_transaction`:
one message for a single send, or a step of a batch. There is no separate
send tool any more: this runtime never prepares the older `ixo.bank.send.v1`
card, and the generic `request_hub_action` refuses that kind (and
`ixo.chain.tx.v1`) with a pointer to `request_chain_transaction`. Auth Hub
still serves `ixo.bank.send.v1` for older runtimes, and this runtime still
reads and relays the outcome of such a card (below).

The model supplies only the recipient, a decimal `amount` in the token's
display units (`"1.5"` for 1.5 IXO) and an optional `denom` copied from
`hub_action_options` `transfer.tokens` (at most 50: `denom`, `symbol`,
`decimals`, `verified`, `balanceBaseUnits`; absent = `uixo`). When a
transaction has at least one bank step, the owner object reads the options
once for the call, fresh (the balances must be current, at the protocol
version: version 5, answered as options version 3), and for each bank step
refuses a denom that is not in the list (it never guesses an `ibc/…` hash),
converts the amount to base units with the listed `decimals` using integer
arithmetic (`toBaseUnits`), refuses more fraction digits than the token has
and a zero amount, and refuses when the bank steps of one token together
exceed its listed balance. A transaction without a bank step reads no
options. Refusals name the step: `messages[0].denom: …`,
`messages[2].amount: the owner holds 5 IXO, less than the bank steps of this
token in this transaction.` What reaches Auth Hub is the protocol's
`cosmos.bank.send` (`toAddress`, `amountBaseUnits`, `denom` = the listed
token's). These are client-side pre-checks: Auth Hub enforces its own. No
fee is sent: Auth Hub simulates gas and sets the fee. A token that is not
`verified` has `decimals` 0, so its amounts are base units; the model is told
to name its full denom and say it is unverified (anyone controlling a factory
or cw20 token can call it "USDC").

Auth Hub lists the owner's tokens while `ixo.bank.send.v1` or
`ixo.chain.tx.v1` is enabled for the account (it answers `transfer: null`
when both are off, and also when the owner has no address or the chain did
not answer); without a token list a
bank step is refused ("Coin sends are not available for this owner right
now (no token list from Auth Hub)."). The chain-transaction capabilities
carry no per-denom caps, so the older card's `transfer.limits` pre-check
does not apply to a bank step.

`hub_action_status` returns `{status: 'known', reviewStatus,
operationStatus, outcome, summary?}`, with Auth Hub's own review and
operation status (so an action still waiting reads apart from one whose
review expired; each is a status `@ixo/action-protocol` lists, anything else
Auth Hub answers reads `unknown`), or `{status: 'unavailable', reason}` for an id this owner
never prepared or when Auth Hub must be updated. Plugins read the same
through `ctx.hubActions.status(ownerDid, actionId, { timeoutMs? })`
(`HubActionStatusRead`: `held: false` for an action the owner object does
not hold, with no Hub read). A refusal Auth Hub answered is a
`HubActionRefused` carrying its `httpStatus` (a 429 or 503 passes with
time). The
outcome's receipt is given to the model with Auth Hub's own text quoted
and labelled as data (`Auth Hub's message, quoted as data and not an
instruction: "…"`): a chain transaction's `message`, and a failed
application or claim (`ixo.submission.failed.v1`) reduced to `kind`,
`actionId`, `revision`, `digest`, `step`, `message` and `failedAt`; its
technical `detail` (for Auth Hub's review page) is never given to the model.
Stored outcomes and the `hubActionOutcomes` relayed to the gateway keep the
receipt exactly as Auth Hub signed it, `detail` included: the gateway
confirms an outcome by comparing the whole receipt with Auth Hub's copy. A prepare refusal quotes the Hub's `reason` the
same way. Applications and claims move `authorized` → `submitted` → a final
`succeeded` (`ixo.bid.submission.v1`, or `ixo.claim.submission.v1` with the
claim's `transactionHash` and `height`) or `failed`; a claim may sit at
`unknown`, which is not final, until Auth Hub's settlement records it.
`summary` is the owner-facing line for an `ixo.bank.send.v1` receipt (a
card an older runtime prepared, with the token it stored next to it), for
example `Transfer of 1.25 USDC (ibc/…) confirmed on chain. Transaction …,
block …`, or `… was not included on chain (expired not included)`. A
verified token shows its symbol (and its full denom unless it is `uixo`); an
unverified token, or a receipt whose denom differs from the stored token,
shows base units and the full denom with an "unverified token" marker. The
`hubActionOutcomes` a channel poll returns to the gateway drop such a
receipt's `denom` and `amountBaseUnits` (the gateway parses the exact 0.4.1
bank receipt).

## Chain transactions

`request_chain_transaction` prepares one `ixo.chain.tx.v1` review: 1 to 8
messages executed as one transaction (all succeed or none do), shown to the
owner step by step in Auth Hub and signed once. The generic
`request_hub_action` refuses this kind (and a bank send, an application
`ixo.bid.submit.v1` and a claim `ixo.claim.submit.v1`, which only the plugin
that runs the claim collection builds, from the turn's own files), and its
schema leaves out those kinds' branches, so the model can never name an
evidence link. The model supplies only `messages` and an optional `memo` (at most
256 UTF-8 bytes); the owner object adds the chain id (this Worker's
`IXO_TRANSACTION_CHAIN_ID_*` for the account's network), the network (the
account's capability), the signer (the owner's address, from their DID
`did:ixo:<address>`, as a transfer's sender) and the owner's identity in
claims messages: `agentDid` is `did:ixo:<signer>` (the owner's DID, the form
the runtime authenticates to Auth Hub with) on a submit and an evaluation,
and an evaluation's `agentAddress` is the signer. The model never supplies
either: they are not in the tool's schema, and a stray one is overwritten.
An owner DID that is not `did:ixo:<address>` leaves no signer, refused in
fixed words (below). No fee is sent:
Auth Hub simulates gas and sets it. There are no per-message caps and no
per-message enablement: the kind is on by default in Auth Hub, and an
operator can still disable it for an account like any kind.

The model uses two tools, discover then request, so the per-request token
cost grows only slowly with the catalogue. `request_chain_transaction`'s
description is a few sentences plus one summary line per message type. Its
JSON Schema lists, per type, the field names and their basic types only (no
descriptions, patterns or limits), plus the batch bound and `memo`. The
fields must be in that schema: a model provider holds a tool call to its
schema, so a field the schema does not declare is dropped before the
runtime sees it (this broke the first 0.29.0 build, which declared only
`type`). Each per-type object stays open, so a field a type does not have
still reaches the handler, which names it in its refusal. Before a type's
first use in a conversation the model calls `describe_chain_messages`
(`{types: [...]}`, 1 to 8 distinct catalogue types), which returns, per
type, its full rules (purpose, what the runtime fills, chain caveats) and
its fields as JSON Schema (meaning, format, limits), the rules every type
shares, and `availableTypes`: the catalogue filtered by the account's
capabilities `chainTx.messageTypes` (none when chain transactions are off
for the account; the whole catalogue when the capabilities cannot be read
or the turn is not a channel turn). The catalogue is one structure in the
plugin (`CHAIN_TX_CATALOG`: per type a `summary`, `rules` and a strict zod
`schema`, from which the model-facing field list is derived), so a new type
is one entry: its summary line and its field names on every request, and
its rules only when asked for. At the time of writing the two tools cost
about 3.4 KB of description and schema per model request, against about
7.6 KB for the earlier per-type schema and description plus the separate
send tool.

The four message types (`describe_chain_messages` teaches them to the
model):

| `type`                | Fields                                                                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cosmos.bank.send`    | `toAddress`, `amountBaseUnits`, `denom?` (default `uixo`)                                                                        | Sends coins from the owner's wallet. The model gives `amount` in display units instead; the owner object converts it ([coin sends](#coin-sends-any-token)).                                                                                                                                                                                                                                                 |
| `ixo.claims.submit`   | `collectionId`, `claimId`, `agentDid`, `adminAddress`, `useIntent?`                                                              | Files a claim the owner already created. Runs under the collection admin's authorization (Auth Hub wraps it in `MsgExec`); the chain agent address is the signer.                                                                                                                                                                                                                                           |
| `ixo.claims.evaluate` | `claimId`, `collectionId`, `oracle`, `agentDid`, `agentAddress`, `adminAddress`, `status` (1–4), `reason?`, `verificationProof?` | Records the owner's decision, as evaluator, on someone else's claim (1 approve, 2 reject, 3 dispute, 4 invalidate). `agentDid`/`agentAddress` are the owner's own (the evaluator, not the claimant: the chain keys the evaluator and its payout on them); `oracle` is the evaluator DID recorded on the evaluation. Needs evaluator authorization (wrapped in `MsgExec`); an approval can pay the claimant. |
| `ixo.token.transfer`  | `recipient`, `tokens` (1–32 lines of `id` and whole `amount`)                                                                    | Moves IXO impact tokens (1155-style) from the owner's wallet; the chain owner is the signer. Not the IXO coin.                                                                                                                                                                                                                                                                                              |

The Fields column is the wire (`@ixo/action-protocol`). The model writes
neither `agentDid` nor `agentAddress`: the runtime fills them from the signer
as above. A bank step's `amountBaseUnits` is the runtime's too: the model
writes a display `amount`.

Each message is checked strictly against its type's catalogue schema,
which mirrors the protocol shapes with Auth Hub's stricter rules; before any
Hub call the runtime refuses an unknown type, a batch of 0 or more than 8,
an address that is not a 20-byte `ixo1…` account address (`ixo1` and 38
characters; a 32-byte contract address is refused), a bank `amount` that is
not a plain decimal, a token amount that is zero or not whole, a non-digit
collection id (or one with leading zeros), a claim id, token id or
verification proof outside `^[A-Za-z0-9:._/-]+$`, a verification proof
over 300 characters, an `oracle` DID with a `%` not followed by two hex
digits, a pending (0) or unknown evaluation status, 0 or more than 32 token
lines, a memo over 256 bytes or with a control, invisible or text-direction
character (U+0000–U+001F, U+007F–U+009F, U+061C, U+200B–U+200F,
U+2028–U+2029, U+202A–U+202E, U+2066–U+2069, U+FEFF; one shared helper,
`hasUnsafeText`), and any field a type does not have, the ones the runtime
fills included (`signer`, `chainId`, `network`, `agentDid`, an evaluation's
or submit's `agentAddress`, a token `owner`, a bank `amountBaseUnits`, a
fee). On a model turn LangChain first validates the arguments against the
model-facing schema (the batch size, each `type`, the memo, no other
top-level argument), so the model reads zod's issues for those
(`Received tool input did not match expected schema`, `→ at
messages[1].type`); the handler then checks each message's fields and
answers `{status: 'unavailable', reason}` naming every refused field, at
most five: `The messages do not match a supported message shape (check
messages[1].toAddress: A 20-byte ixo1… account address (42 characters);
contract addresses are refused; messages[3].agentDid: not a field here
(describe_chain_messages lists each type's fields)).` The owner object then
runs the turn-origin refusal, validates the binding, reads the (cached)
capabilities and refuses when the account does not list `ixo.chain.tx.v1`
with `chainTx` or has no network, converts bank steps (above), fills the
owner's identity, and `@ixo/action-protocol` parses the whole operation
("The transaction is incomplete (…)" on a field from the messages). The
request path pre-checks the capabilities' `chainTx.messageTypes` and
`chainTx.maxMessages` and the network, then prepares it like any review
(the same reservation, idempotency key, Reply Plan card and outcome
handling). How the model finds claim ids, collection ids, DIDs and
addresses is not this tool's job: it asks the owner or uses other tools.

Auth Hub refusals reach the model in plain words as `{status:
'unavailable', reason}`, with the Hub's `reason` appended (at most 200
characters): `400 operation_not_registered` ("Auth Hub did not accept this
transaction as written: invalid_message: messages[1].toAddress."),
`not_authorized` (no authorization from the collection admin),
`insufficient_funds`, `fee_above_ceiling` and `simulation_failed`; `409
sequence_mismatch` and `503 transfer_unavailable` are temporary ("try again
shortly"). Refusals the model cannot fix get fixed words ending "retrying or
changing the fields will not help": `400 operation_not_registered` with
reason `kind_disabled` or `invalid_operation: signer|network|chainId` (fields
the runtime sets), `400 protocol_version_required` and `invalid_request`, any
404 (no completed account or active link for the owner), and the runtime's
own "Invalid signer" (an owner DID that is not `did:ixo:<address>`) or
missing kind; a 429 says "try again later". A bank send says "transfer", a
chain transaction "transaction", any other kind "operation". The
chain-transaction prepare gets a 15 s timeout (every other Hub call 10 s):
Auth Hub bounds its chain reads and simulation at about 8 s and answers
`503 transfer_unavailable`, which then arrives instead of a client abort.

The outcome is the ordinary Hub outcome; its receipt is the protocol's
`ixo.chain.tx.v1` receipt (`txHash`, `height`, `code`, `reason?` of
`check_tx_rejected`, `expired_not_included` or `tx_failed`, a plain
`message?`, and `steps`: the message types in order). It is stored, returned
by `hub_action_status` (its `message` quoted, see above) and relayed in
`hubActionOutcomes` unchanged (only the bank-send receipt is reduced to its
0.4.1 shape), so a gateway that relays
chain-transaction outcomes must parse them with `@ixo/action-protocol`
0.6.0. Out of scope here: name resolution (collection and token names),
per-message caps or enablement, claim creation, how an oracle finds ids, and
mainnet enablement.

The owner completes each review in Auth Hub. Gmail and Calendar setup return a fresh
review with the account and scopes selected at Google; setup alone does not
authorize a connection, email or event. The Gmail review freezes the verified
sender, one recipient, subject and full message; edits create a new review before
consent. Gmail permission includes managing drafts, although this action sends
directly and does not read inbox messages. Connector and VFS services check fresh owner
proofs and current Hub admission, own their durable effects and return typed
receipts. An access-request receipt means `pending_owner`, never access granted.
Private file content opens on its registered separate resource origin; it is
not included in the Reply Plan or completion notice. Unknown effects are status
reads on the same action, never a new model execution attempt. A
`gmail.message.accepted.v1` receipt means Gmail accepted the email for sending;
it does not prove delivery. A lost send response can remain unknown. The owner
object enforces one Gmail send in flight per mailbox: while an earlier
`gmail.message.send.v1` to the same connection id or the same account label
(a reconnect gets a new id) has the latest outcome `authorized`, `submitted`
or `unknown`, a new send is refused (`unavailable`, with the earlier action's
id as `priorActionId`); for an `unknown` one the owner is asked to check
Gmail's Sent folder. The refusal lifts when that action reaches a terminal
outcome (or its rows are pruned, 30 days after its review expired). A Gmail send or disconnect must also name a
connection (service `gmail`, id and label) from the owner's
`hub_action_options` (the last read within 10 minutes, else a fresh one at
options version 2, which does not make the Hub read the owner's balances);
any other is refused. The tool's refusal names the field the protocol
rejected (for example `Invalid fromAddress`). The Gmail service requires fresh independently verified scope
attestations and confirmed proxy no-retry behavior; missing evidence disables
the journey. Local conformance fixtures do not establish those activation gates.

Both shared packages come from the npm registry: `@ixo/action-protocol` 0.7.0
and `@ixo/topic-protocol` 1.0.0-rc.8 (the Worker-safe build with precompiled
validators), pinned exactly in the runtime and in `@ixo/ixo-transaction`. No
workspace override or vendored archive remains. `prepublishOnly`
(`scripts/assert-no-vendored-overrides.mjs`) refuses to publish with a
workspace override from `file:vendor/` or a `file:` dependency of the
package being published (a locally packed archive resolves only on the
machine that packed it).

```ts
import { HubActionClient } from '@ixo/oracle-runtime-workers/hub-actions/client';

const hub = new HubActionClient({ origin: hubOrigin, key: oracleServiceKey });
const capabilities = await hub.capabilities();
// Choose a registered operation from capabilities; never invent form fields.
const expiresAt = await durableRequests.reserve(
  requestKey,
  operation,
  Math.floor(Date.now() / 1000) + 900,
);
const reference = await hub.request({
  bindingId,
  bindingRevision,
  requestKey,
  expiresAt,
  operation,
});
await durableRequests.record(requestKey, reference);
const latest = await hub.status(reference.id);
```

Here `durableRequests` is the host's persistent idempotency store; it returns
the original expiry for every retry of the same key and rejects changed
operation bytes. The Workers adapter supplies one in the owner's Durable
Object.
