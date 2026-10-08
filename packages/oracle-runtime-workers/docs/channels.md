# Channels ingress

`POST /channels/turn` lets IXO Channels submit a text turn to the user's existing Companion. The route has its own UCAN policy. The generic Portal authentication policy is unchanged.

## Configuration

| Binding or variable            | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `CHANNEL_SERVICE_DID`          | The one channel service DID allowed to invoke this deployment. |
| `AUTH_HUB`                     | Optional Cloudflare service binding to Auth Hub.               |
| `AUTH_HUB_URL`                 | Auth Hub HTTPS URL when no service binding is configured.      |
| `AUTH_HUB_CHANNEL_SERVICE_KEY` | Dedicated credential for Auth Hub channel validation.          |

An unset `CHANNEL_SERVICE_DID` disables the route: it answers `503` with `Channels are not configured`. Binding validation needs the key and either `AUTH_HUB` or `AUTH_HUB_URL`; the service binding is used when both are set. The validation credential is separate from operator credentials. Neither the channel service nor its grant receives a Matrix access token. Required-ness and wrangler syntax are in [configuration](configuration.md#channels-ingress).

## Authorization

The `Authorization` header contains `Bearer <base64 UCAN CAR>`. The `x-auth-type` header is `ucan`. The invocation uses `@ixo/ucan` 2.2.0.

The proof is a direct delegation from the user DID to `CHANNEL_SERVICE_DID`. Its sole capability is `ixo:channel/invoke` on `ixo:channel:<bindingId>`. Its caveats contain the provider, binding revision, and this deployment's `ORACLE_DID`. Its expiration is at most five minutes away.

The service invokes the same capability for `ORACLE_DID`. Its expiration is at most 60 seconds away. Its sole fact is `{requestId, requestHash}`. `requestHash` is the lowercase SHA-256 hex digest of the exact UTF-8 JSON request body.

The validator checks both signatures, the exact two-member chain, the resource, the caveats, both audiences, and both lifetimes. Wildcards and additional delegation hops are rejected. The channel proof is never deposited as generic downstream tool authority. Existing tool authorization remains responsible for each consequential action.

The validator records no replay marks: a poll repeats its exact body and may reuse an invocation, also concurrently, and the durable receipt makes every repeat return the same run. Once the invocation proves the user, the request spends one unit of that user's `RATE_LIMIT` budget (key `<ORACLE_DID>|user|<userDid>`); over the limit it returns `429` before Auth Hub is called.

Auth Hub receives `POST /api/internal/channels/validate-binding` with the dedicated `x-channels-service-key` header. The body contains `userDid`, `bindingId`, `bindingRevision`, `provider`, and `oracleDid`. Only `{active:true}` allows admission. The shell makes this check once per request, before the user's Durable Object is called. It runs again only before a queued or recovered attempt executes (`LiveRun.attemptSource` is `dequeue` or `recovery`); an attempt that starts right after admission is not checked twice. An unavailable validator fails closed.

At admission, an unavailable validator returns `503` and nothing is recorded. Before an attempt, the two outcomes differ. An inactive binding ends the run as `failed`. An unavailable or unconfigured validator defers the attempt: the run becomes `recovering` and is retried on the recovery backoff (`RUN_RECOVERY_DELAYS_MS`, default 5 s, 15 s, 30 s, 60 s). It fails only once `RUN_RECOVERY_ATTEMPTS` deferrals are spent. Whether a retry resumes or starts fresh is derived from the run row, so it holds across an object restart. Each run records the session checkpoint it started from (`start_checkpoint_id`, set at begin and again when a queued run is dequeued). A recovery attempt resumes only when the session's checkpoint has advanced since then, meaning the graph persisted part of the run. It then continues with the reply text so far. Otherwise the graph never saw the input, and the attempt runs fresh with it, without a `resumed` frame. Every retry, fresh or resumed, counts against the recovery cap. Rows written before the column existed always resume, as before. An unreadable checkpoint counts as "not advanced", the same as in the recovery-progress check.

## Tool authority

A channel turn runs with the user's full stored delegation to this oracle: the same delegation, and therefore the same tool authority, as a Matrix turn in the Companion room. This is a product decision. The channel grant itself never becomes tool authority, and a channel request that carries a delegation is refused with `403`.

A channel cannot recover a missing delegation. The `delegation_required` re-authorization prompt is posted only for Matrix turns. A new channel turn is therefore refused, before it is recorded as a run and before the user's object boots, unless the user's stored delegation is usable: present, with a known expiry, and with more than `CHANNEL_DELEGATION_MIN_REMAINING_SECONDS` (900 s) left, so that a turn never outlives the delegation its tools, memory, files and owner-copy flush run under. The response is `428` with code `delegation_required` and `Companion delegation required: the user must authorize this oracle again`. The same answer comes back when the delegation exists but cannot load the user's owner copy because it lacks the `ixo:filesystem` grant over `/.oracles` (the boot's `NO_VFS_DELEGATION`). The gateway should tell the user to open the Companion and authorize it. Retrying the same request ID after re-authorization admits it: `POST /delegation` hands the new delegation and its expiry to the user's object at once. A run already admitted keeps answering polls after the delegation is revoked. If the delegation is gone or inside the margin when a queued or recovered attempt starts, the run ends as `failed`.

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
  "context": { "kind": "companion" }
}
```

`sessionId` is optional on the first request. An existing session must belong to this user and the canonical encrypted Companion room. The session is checked when a request is bound to it, and once more before a request starts a run; a poll of an admitted request checks nothing and writes nothing, so it does not mark the user's database dirty. Subsequent messages reuse the binding's session. Deleting that session releases the binding: its next message opens a new session. A request that still names the deleted session returns `404`. Topics, attachments, provider identifiers, and caller-supplied user identities are not accepted. The body limit is 64,000 bytes. Text is limited to 16,000 characters.

## Responses and retries

An admitted turn returns `202` with `requestId`, `runId`, `sessionId`, and a `queued`, `running`, or `recovering` status. A terminal turn returns `200` with its terminal status. A `finished` turn also contains `text` and, when available, `messageId`.

`finished` is the only successful terminal status. Its `text` may be empty after a tool-only completion; the gateway must complete delivery without sending an empty provider message. An absent `messageId` does not mean the turn should be retried.

Polling repeats the original POST body exactly. A fresh UCAN invocation can authorize the same body. Adding the returned session ID to a pending request changes the body and returns `409`. The returned session ID belongs on a later message.

### Admission order

1. The shell reads the body (`400 invalid_request`, `413 request_too_large`), parses it, and verifies the channel invocation (`401 unauthorized`, `403 scope_mismatch`).
2. The user's rate limit (`429 rate_limited`), then the Auth Hub binding check (`403 binding_inactive`, `503 binding_check_unavailable` / `not_configured`).
3. The user's object refuses a request that carries a delegation header (`403 channel_grant_not_tool_authority`), then loads the stored delegation if it holds none (or holds one that no longer passes) and checks it (`428 delegation_required`). Nothing has booted yet.
4. The object boots, importing the owner copy on a cold start. `NO_VFS_DELEGATION` becomes `428 delegation_required`; any other boot failure is a `503 unavailable`.
5. Admission: the receipt (`410 response_expired`, `409 request_conflict`), the session (`409 session_conflict`, `404 session_not_found`, `409 room_not_encrypted`, `428 room_not_ready`), and, before a new run starts, the delegation check again.

### Errors

Every refusal has the body `{ "code": "<code>", "message": "<text>" }`. A gateway maps it by `code` first and by status second. `428` (Precondition Required) means a precondition on the user's side is missing: the gateway tells the user what to fix and retries the same request once it is fixed; it is never treated as a transient outage. `503` is transient and may be retried with backoff.

| Status | `code`                             | Meaning                                                                                                                                                   |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_request`                  | Body missing, not UTF-8, not JSON, or not the request shape.                                                                                              |
| `401`  | `unauthorized`                     | No valid user-rooted channel invocation (header, chain, grant or lifetime).                                                                               |
| `403`  | `scope_mismatch`                   | The invocation does not cover this binding, provider, revision, oracle or body.                                                                           |
| `403`  | `binding_inactive`                 | Auth Hub reports the binding inactive.                                                                                                                    |
| `403`  | `identity_required`                | The binding check got no channel identity.                                                                                                                |
| `403`  | `identity_mismatch`                | The channel identity does not match the request.                                                                                                          |
| `403`  | `channel_grant_not_tool_authority` | A channel request carried a delegation.                                                                                                                   |
| `404`  | `session_not_found`                | The session is not this user's session in the Companion room (or was deleted).                                                                            |
| `409`  | `request_conflict`                 | The request ID already belongs to another message body.                                                                                                   |
| `409`  | `session_conflict`                 | The binding already has another session.                                                                                                                  |
| `409`  | `room_not_encrypted`               | The Companion room is not end-to-end encrypted.                                                                                                           |
| `410`  | `response_expired`                 | The run was pruned; the request cannot execute again.                                                                                                     |
| `413`  | `request_too_large`                | The body is over 64,000 bytes.                                                                                                                            |
| `428`  | `delegation_required`              | No usable delegation: none, unknown expiry, under 900 s left, or no file-storage grant. Re-authorize.                                                     |
| `428`  | `room_not_ready`                   | The user has no Companion room yet. Finish Companion setup.                                                                                               |
| `429`  | `rate_limited`                     | Over the user's rate limit.                                                                                                                               |
| `503`  | `not_configured`                   | Channels or Auth Hub binding validation are not configured (or `AUTH_HUB_URL` is not HTTPS).                                                              |
| `503`  | `binding_check_unavailable`        | Auth Hub could not be reached or answered badly.                                                                                                          |
| `503`  | `unavailable`                      | Anything else. The shell logs `[channels] turn failed unexpectedly: <name>: <message>` (the message bounded to 300 characters, nothing from the request). |

### Durability

The tuple `(userDid, bindingId, requestId)` identifies one durable run. Concurrent submissions and requests after object restarts reuse it. A different request body under that tuple returns `409 request_conflict`. An aborted, failed, or interrupted run remains terminal. Retrying it never starts a replacement model or tool execution.

Completed channel runs follow the ordinary seven-day run retention: database boot removes their request, answer, segments, and tool marks, set-based in one transaction. The same transaction retains only a run ID and terminal status tombstone. Until then, the receipt keeps the binding ID, request ID, body hash, run ID, session ID, and whether the reply was mirrored, inside the user-scoped database. The same boot removes the receipt of every tombstoned run. No message text enters the receipt or tombstone. Any request for a pruned run returns `410 response_expired`, whatever its body, and writes no new receipt. The response never permits a replacement execution. The canonical session and Matrix transcript keep their existing retention policy.

Storage growth: one tombstone row (run ID and status, under 100 bytes) remains for every channel request that started a run. Tombstones are never pruned, because they are what refuses a replay. A receipt whose request never started a run is not pruned either. This covers a request refused for its session or a missing delegation and never retried. Tombstones grow with message volume, at most about 10 MB per 100,000 messages per user.

## Reply Plans

A finished turn also carries `plan`, the reply as the ordered parts to deliver. `text` is then the plan as one Markdown message, with artefacts as links, for gateways that predate plans (without a plan it is the model's reply). A gateway that reads `plan` ignores `text`. The Companion room mirror shows the same rendering, posted once per run. The run record itself keeps the model's own text.

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

The runtime picks the WhatsApp, Telegram or Slack profile from `provider`, and a generic chat profile for any other provider. See [chat delivery](chat-delivery.md).

## Matrix continuity

The session marker uses a deterministic transaction ID for the binding and the request that opens the session. Message mirrors use deterministic transaction IDs for the user, binding, request, and author. A lost response therefore reuses the original Matrix event.

The user message is mirrored before model execution. The completed run mirrors its assistant reply immediately, without waiting for the next poll, and records the delivery in the request's receipt. A finished response is returned only after its assistant mirror succeeded. A poll retries a mirror that failed without repeating the model run, and never resends a recorded one. Both mirrors use the existing gateway's encrypted timeline event path.

The `org.ixo.qi.origin` content contains only `v`, `transport`, `binding_id`, and `remote_ref`. This metadata is inside the encrypted event. It contains no phone number, raw message ID, contact ID, or profile name. Human messages also expose the same envelope through `metadata` in both session-history APIs.

## Validation limits

The focused workerd tests exercise real UCAN signatures, negative authorization cases, concurrent duplicate admission, SQLite close and reopen, an abrupt Durable Object abort immediately after admission, session reuse, ownership rejection, and required mirror failures. They also cover a session released by its deletion, a reply mirrored once across the run end and repeated polls, the missing-delegation refusal, and receipt pruning. A channel run driven by the run coordinator over the real SQLite store keeps its reply. Run coordinator tests cover enqueue order and deferred attempts. `src/channels/turns.test.ts` proves that repeated polls make no extra dirty mark or session check, `src/shell/channel-route.test.ts` that an over-limit request gets `429` without an Auth Hub call and that two concurrent identical requests under one invocation are both admitted, and that every refusal carries `{ code, message }` while an unexpected failure answers `503 unavailable` and is logged, and `src/do/user-object-lifecycle.test.ts` that the binding is not checked again after the shell did, that a missing, expired or nearly expired delegation is refused with `428` before the object boots, that a boot failing with `NO_VFS_DELEGATION` answers `428` while any other boot failure propagates, that a delegation deposited after a refusal is admitted at once, and that a missing Companion room answers `428 room_not_ready`. These tests do not contact a live model, Auth Hub, WhatsApp, or Matrix homeserver.

Companion's `feat/workers-runtime` deployment must adopt the released runtime and configure these bindings. Live onboarding, revocation, encrypted Matrix event inspection, and provider delivery remain deployment acceptance checks. `pnpm test:e2e:channels` in the example app is the operator-run acceptance harness for them ([testing](testing.md#harness-end-to-end-minutes-local); its variables and checkpoints are in [`docs/testing/channels-acceptance.md`](../../../docs/testing/channels-acceptance.md)).
