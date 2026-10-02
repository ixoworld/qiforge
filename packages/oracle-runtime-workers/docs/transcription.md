# Billable live dictation

Status: implementation for review, disabled by default. The billing-engine reservation extension is a proposal for its owner, Michael, and must be reviewed and released there before this feature can be enabled. No customer price is created or activated by this change.

## Runtime boundary

This targets `@ixo/oracle-runtime-workers` 0.14.0 on QiForge commit `2be6e43d7785f49f453e9bd8921f2a6800a5e730`. The deprecated Nest runtime is unchanged. Companion main at `abf051d70706b814f95a7996a9c884bf0ee14f84` still pins Node 1.93.0, while its `feat/workers-runtime` branch pins Workers 0.13.0. Repository contents do not establish the production deployment. Select and verify the active Workers host with the deployment owner; do not silently migrate companion main or bump a published package to an unpublished version.

## Wire flow

1. The Portal disclosure is confirmed before requesting microphone access. `POST /transcription/sessions` uses the normal oracle UCAN invocation, origin allowlist and per-user request limiter. Bare-delegation fallback is rejected for this billable endpoint. The billing engine verifies the original user invocation against the authenticated subject and reserves the maximum session cost using the configured existing tariff.
2. The per-user Durable Object serializes admission and issues `{ sessionId, ticket, websocketUrl, maxDurationMs, billing }`. The browser opens `/transcription/socket?userDid=...&sessionId=...` on the same oracle origin. The query contains only routing identifiers. The single-use ticket appears only in the first frame: `{ type: "authenticate", ticket }`. Only a digest is stored.
3. On `ready`, the browser sends bounded binary little-endian PCM16, mono, 24 kHz. The relay fixes `gpt-live-transcribe`, rejects arbitrary provider events and model changes, and enforces single-session concurrency, sample count, realtime pacing, wall-clock, idle, handshake and finalization deadlines.
4. `delta.text` is the cumulative provisional preview. `{ type: "stop" }` explicitly commits one upstream input item; `completed.text` is authoritative and replaces the preview. The Portal appends it to the editable draft once. Only the existing Send action invokes the agent.
5. `{ type: "cancel" }`, navigation or disconnect discards text. Audio already processed can still be billable: the relay commits silently to obtain actual duration usage before closing. Empty sessions release their hold without a charge.

## Provider contract

The server connects to `wss://api.openai.com/v1/realtime?intent=transcription` with its own project API key, not Codex OAuth and not a browser client secret. It sends `session.update` with session type `transcription`, `audio.input.format={type:"audio/pcm",rate:24000}`, `audio.input.transcription.model="gpt-live-transcribe"`, and `turn_detection:null`. It validates the returned `session.updated` before accepting audio. It only sends `input_audio_buffer.append` and one `input_audio_buffer.commit`; it never sends `response.create`.

The adapter accepts duration-based `usage.seconds` from the completed transcription event, correlates `item_id`, and bounds duration against server-observed samples and the reservation ceiling. It does not invent usage from elapsed socket time. Missing, malformed, token-based or excessive usage enters reconciliation rather than creating a guessed charge or refund.

Official references checked 2026-10-02:

- [Live transcription protocol](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [OpenAI Node SDK transcription intent](https://github.com/openai/openai-node/blob/main/docs/realtime.md)
- [Official completed-event usage schema](https://github.com/openai/openai-python/blob/main/src/openai/types/realtime/conversation_item_input_audio_transcription_completed_event.py)

The model's listed provider cost is separate from the customer tariff. No provider cost is embedded as a customer price. Actual account/model availability and the duration payload still need an explicitly authorized, consented staging test.

## Central billing contract

The accompanying billing-engine proposal adds atomic reservations that participate in the same prepaid balance / auto usage-cap / offchain credit-line checks as ordinary events. It does not introduce a subscription entitlement policy. Any requirement for an active subscription must be agreed with the billing owner instead of inferred from Codex connection status.

The runtime uses a configured meter and checks the public billing catalog on admission. The approved unit price, rate card, service, product, event, metric, seconds unit, denomination and filters must match. Source invocation credentials are used only at admission, never stored in the session journal. Settlement uses a fresh oracle service invocation and the stable reservation/session identifiers. Customer attribution and rated receipt details are verified before accepting settlement.

Usage is rounded up to whole seconds for the configured integer-quantity meter. The engine freezes the quoted tariff for the reservation. Zero confirmed usage uses release. Nonzero usage uses the reserved commit path, never a separate unreserved event. This avoids a second charge if the HTTP response is lost and the same operation is retried.

The journal persists only subject/session identifiers, ticket digest, origin, admission/quote, accepted byte count, actual duration, sanitized provider session/item/request identifiers, status and retry timing. It holds no audio, transcript, OpenAI key or user/service invocation. The completed text stays only in memory until delivered to the browser's editable draft.

## Required configuration

See [configuration](configuration.md#billable-live-dictation) for the opt-in variables. All are reviewed operational configuration; this change does not provision credentials, submitter grants, services, products, meters, rate cards or tariffs.

Both the server and `NEXT_PUBLIC_ENABLE_VOICE_TRANSCRIPTION=true` in the Portal must be enabled intentionally. Missing billing configuration fails closed. There is no platform-funded, BYO-key or Codex-plan fallback. Exact HTTPS origins and the native `RATE_LIMIT` binding are required. The default recording ceiling is 60 seconds; the daily audio ceiling must be explicitly configured and must be at least one maximum recording.

## Recovery and operations

- The admission intent is durably written before the central reservation request; an authenticated retry reuses its session ID with a fresh or cached live source proof. No source credential is persisted. This is bounded lost-response recovery, not an unlimited exactly-once guarantee: the intent window is 16 minutes against the proposed 15-minute hold lifetime. An unusually late ambiguous retry can require waiting for a hold to expire; review this boundary with the billing owner.
- One per-user admitted recording is outstanding at a time. Unused tickets expire after 30 seconds and release the central hold through a durable alarm.
- Completed provider usage is persisted before final text is delivered. Transient settlement failures leave a durable pending record, retry on alarms with the same transaction, and block new sessions until settled. A 402 can retry after credits recover, within the engine's settlement window.
- Nonretryable conflicts, unexpected receipts or an expired settlement window enter `reconciliation_required`; they do not retry indefinitely. A process crash with possibly forwarded audio and no final usage enters the same state.
- A reconciliation record deliberately blocks further dictation for that user. An operator must compare the reservation/charge receipt and provider usage before clearing it. Never synthesize a duration from the recorded byte upper bound, blindly refund an uncertain hold, or delete the journal to unblock a user. The billing owner's operational reconciliation process remains a release prerequisite.
- The engine hold expiry bounds locked customer credit. Expiry is not proof that upstream audio cost was zero and does not erase the runtime record.
- The server flag is the admission kill switch. Turning it off or removing provider configuration does not disable pending billing recovery; the existing billing destination and signing service must remain available until the outbox is drained. Existing sessions have hard duration/finalization bounds. Use a dedicated provider project with spend alerts and a budget as an additional safeguard.
- Do not add audio, transcript, source-invocation, ticket or authorization-header logging. Do not promise zero provider retention; the applicable OpenAI Realtime data controls must be disclosed and checked for the deployment.

## Verification and release checklist

Focused tests cover the PCM and browser lifecycle paths in the Portal, and protocol, ticket ownership/replay, origin/config, byte/pacing/queue bounds, cancellation/disconnect accounting, unknown usage, timeout, crash recovery and idempotent durable retries in this runtime. Billing-engine tests cover central hold concurrency, ordinary-event interactions, attribution, releases, expiry and exactly-once commit.

Before enabling: approve the central API proposal and tariff with Michael; select the current Workers host; configure the trusted submitter and meter; run complete repository lint/typecheck/build suites and the Workers harness; test actual provider usage with an authorized consented clip; test desktop Chrome/Firefox/Safari and real iOS Safari/Android Chrome, including denial, Bluetooth interruption, backgrounding, navigation and keyboard-only controls. No paid provider request, charge, credential grant, price activation or deployment is part of the local test run.
