# Channels ingress

`POST /channels/turn` lets IXO Channels submit a text turn to the user's existing Companion. The route has its own UCAN policy. The generic Portal authentication policy is unchanged.

## Configuration

| Binding or variable            | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `CHANNEL_SERVICE_DID`          | The one channel service DID allowed to invoke this deployment. |
| `AUTH_HUB`                     | Optional Cloudflare service binding to Auth Hub.               |
| `AUTH_HUB_URL`                 | Auth Hub HTTPS URL when no service binding is configured.      |
| `AUTH_HUB_CHANNEL_SERVICE_KEY` | Dedicated credential for Auth Hub channel validation.          |

An unset `CHANNEL_SERVICE_DID` disables the route. The validation credential is separate from operator credentials. Neither the channel service nor its grant receives a Matrix access token.

## Authorization

The `Authorization` header contains `Bearer <base64 UCAN CAR>`. The `x-auth-type` header is `ucan`. The invocation uses `@ixo/ucan` 2.2.0.

The proof is a direct delegation from the user DID to `CHANNEL_SERVICE_DID`. Its sole capability is `ixo:channel/invoke` on `ixo:channel:<bindingId>`. Its caveats contain the provider, binding revision, and this deployment's `ORACLE_DID`. Its expiration is at most five minutes away.

The service invokes the same capability for `ORACLE_DID`. Its expiration is at most 60 seconds away. Its sole fact is `{requestId, requestHash}`. `requestHash` is the lowercase SHA-256 hex digest of the exact UTF-8 JSON request body.

The validator checks both signatures, the exact two-member chain, the resource, the caveats, both audiences, and both lifetimes. Wildcards and additional delegation hops are rejected. The channel proof is never deposited as generic downstream tool authority. Existing tool authorization remains responsible for each consequential action.

Auth Hub receives `POST /api/internal/channels/validate-binding` with the dedicated `x-channels-service-key` header. The body contains `userDid`, `bindingId`, `bindingRevision`, `provider`, and `oracleDid`. Only `{active:true}` allows admission. The check runs again before a queued or recovered attempt executes. An unavailable validator fails closed.

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

`sessionId` is optional on the first request. An existing session must belong to this user and the canonical encrypted Companion room. Subsequent messages reuse the binding's session. Topics, attachments, provider identifiers, and caller-supplied user identities are not accepted. The body limit is 64,000 bytes. Text is limited to 16,000 characters.

## Responses and retries

An admitted turn returns `202` with `requestId`, `runId`, `sessionId`, and a `queued`, `running`, or `recovering` status. A terminal turn returns `200` with its terminal status. A `finished` turn also contains `text` and, when available, `messageId`.

`finished` is the only successful terminal status. Its `text` may be empty after a tool-only completion; the gateway must complete delivery without sending an empty provider message. An absent `messageId` does not mean the turn should be retried.

Polling repeats the original POST body exactly. A fresh UCAN invocation can authorize the same body. Adding the returned session ID to a pending request changes the body and returns `409`. The returned session ID belongs on a later message.

The tuple `(userDid, bindingId, requestId)` identifies one durable run. Concurrent submissions and requests after object restarts reuse it. A different request body under that tuple returns `409`. An aborted, failed, or interrupted run remains terminal. Retrying it never starts a replacement model or tool execution.

Completed channel runs follow the ordinary seven-day run retention: database boot removes their request, answer, segments, and tool marks. The same transaction retains only a run ID and terminal status tombstone. The receipt keeps the binding ID, request ID, body hash, run ID, and session ID inside the user-scoped database. No message text enters the receipt or tombstone. An identical request after pruning returns `410`; a changed body still returns `409`. Neither response permits a replacement execution. The canonical session and Matrix transcript keep their existing retention policy.

## Reply Plans

A finished turn also carries `plan`, the reply as the ordered parts to deliver. `text` stays the whole reply as one Markdown message, with artefacts as links, for gateways that predate plans. A gateway that reads `plan` ignores `text`.

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

The session marker uses a deterministic transaction ID for the binding. Message mirrors use deterministic transaction IDs for the user, binding, request, and author. A lost response therefore reuses the original Matrix event.

The user message is mirrored before model execution. A finished response is returned only after its assistant mirror succeeds. Polling retries a failed mirror without repeating the model run. Both mirrors use the existing gateway's encrypted timeline event path. The completed run also schedules its assistant mirror immediately, without waiting for the next poll.

The `org.ixo.qi.origin` content contains only `v`, `transport`, `binding_id`, and `remote_ref`. This metadata is inside the encrypted event. It contains no phone number, raw message ID, contact ID, or profile name. Human messages also expose the same envelope through `metadata` in both session-history APIs.

## Validation limits

The focused workerd tests exercise real UCAN signatures, negative authorization cases, concurrent duplicate admission, SQLite close and reopen, an abrupt Durable Object abort immediately after admission, session reuse, ownership rejection, and required mirror failures. Existing run coordinator tests cover enqueue order. These tests do not contact a live model, Auth Hub, WhatsApp, or Matrix homeserver.

Companion's `feat/workers-runtime` deployment must adopt the released runtime and configure these bindings. Live onboarding, revocation, encrypted Matrix event inspection, and provider delivery remain deployment acceptance checks.
