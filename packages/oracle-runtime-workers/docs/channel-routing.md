# Experimental conversation routing for channels

One continuous WhatsApp history can contain several durable QiForge sessions. The optional router assigns a channel message to an existing session, starts a separate session for a clear independent goal, or asks which conversation the user means. A new action within an existing goal stays in that conversation.

The feature is **off by default**. It is called only by authenticated `/channels/turn` admission. Companion's Portal and Matrix turns continue in their explicitly selected sessions, even when this flag is on. The `context.kind: companion` legacy value on a channel request does not turn that request into a Portal turn. Sessions remain canonical and can appear in the Portal's session list; the Portal's active conversation is never switched by this router. The existing capability router is an independent feature.

## Enable a channel pilot

Configure these vars on the **oracle Worker**, after adopting the matching runtime package. They are not gateway vars or user message fields.

```jsonc
{
  "vars": {
    "CHANNEL_SEMANTIC_ROUTING": "shadow",
    "CHANNEL_SEMANTIC_ROUTING_BINDINGS": "chb_pilot_binding",
    "CHANNEL_SEMANTIC_ROUTING_MIN_PROBABILITY": "0.9",
    "DECISION_PROVIDER": "openrouter-jev",
    "DECISION_MODEL": "typesafe/jev-1.13",
  },
}
```

Retain the deployment's existing Decision provider when one is configured. The OpenRouter adapter uses the existing `OPEN_ROUTER_API_KEY` secret. `cloudflare-jev` uses the Worker's `AI` binding when available, or its existing account/token configuration. The model override can select a compatible hosted decision model such as `@cf/cloudflare/clef-flash` on Workers AI; conformance and live routing quality must be tested for the selected model. This change does not certify a live provider or model.

`DECISION_MODEL` changes the env-selected provider for all Decisions using it. To compare models without changing other Decision consumers, register a separate host provider and route only `runtime.route-channel-session` through `decisionProviderPolicy.routes`; see [provider selection](../../../docs/architecture/decisions.md#choosing-a-provider).

| Var                                        | Behavior                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_SEMANTIC_ROUTING=off`             | Default. New requests follow the existing session policy. No routing inference or candidate retrieval.                                                                            |
| `CHANNEL_SEMANTIC_ROUTING=shadow`          | Continue the existing session. Evaluate asynchronously and record what would have happened. No semantic session switch or clarification.                                          |
| `CHANNEL_SEMANTIC_ROUTING=on`              | Apply clear thread assignments; clarify uncertain, unsupported, or multiple-intent decisions without an agent or tools. A failed provider keeps the current conversation.         |
| `CHANNEL_SEMANTIC_ROUTING_BINDINGS`        | Optional comma-separated binding IDs. With an empty list the selected mode applies to all channel bindings on this oracle. A nonempty list restricts it to those test bindings.   |
| `CHANNEL_SEMANTIC_ROUTING_MIN_PROBABILITY` | Default `0.9`; accepted range `0.5..1`. The chosen option must also beat the runner-up by at least `0.2`. These are provisional experiment thresholds, not validated calibration. |

Start with `shadow`, then redeploy with `on` for the test binding. Switch back to `off` to disable routing for new messages. It does not delete threads or reset the current channel session. Already assigned requests retain their durable destination, including during retries after a flag change. In-flight work keeps its assignment.

## Assignment and controls

- The first turn opens the usual session without a classifier call. Later messages can continue, resume, create, or clarify.
- Known quotes resolve an owned session within the same channel binding and consent revision before inference, including references to an earlier session. Missing, expired, deleted, foreign-binding, or foreign-revision references cannot authorize a switch and ask for clarification in `on` mode. Reference resolution remains bounded by transport/run receipt retention.
- Explicit `/new` and `/resume` control the next admitted message. `/interrupt <correction>` carries a signed `sessionPolicy: continue` so the correction stays in the selected session. Controls use their existing cancellation semantics and never go through the classifier.
- Automatic new/resume assignments do **not** cancel other work. Session selection and cancellation remain distinct. The gateway's existing ordinary-message queue remains serialized; this experiment does not add concurrent WhatsApp agent execution.
- A separate conversation or a return to an earlier conversation adds a short visible cue to the reply (`Starting a fresh topic for this. Send /resume to go back to *{previous title}*.` or `Back to *{title}*. Send /resume to go back.`; a topic without a title is called "the previous topic" or "an earlier topic"). Titles are model output, so whitespace is collapsed, `*`, `_`, `~`, backticks and control, format and separator characters are removed, and they are clipped to 80 code points before they go inside the bold markers. This notice (the part with id `channel_thread_notice`) is the single statement of a routed switch; a gateway should not add its own announcement when it is present. The model's canonical answer is unchanged; the channel reply and its Matrix mirror carry the cue.
- An ambiguous or multiple-intent message receives a deterministic clarification in the canonical transcript. No generative agent or tools run for that response. Ask the user to quote the relevant message or resend the request with its topic; there is no invisible automatic replay of an ambiguous action.
- A provider error, invalid result, or 1.5-second evaluation timeout keeps the message in the current conversation in both modes, as with routing off, and records the observation with reason `provider-unavailable`. A classifier outage never holds a message, creates a thread, or stops work.

## Context, persistence, and boundaries

The router sees a bounded index of up to 24 recent channel sessions per binding. It offers at most eight candidates, retaining the current thread and ranking other candidates by lexical overlap with the incoming message. Each candidate includes an initial topic excerpt, the latest user excerpt, a bounded assistant reply excerpt, and current run status. These are excerpts, not generated summaries. No full-history scan or additional summarizer runs on the turn path. Matching an older or multilingual paraphrase outside this candidate set is a known limitation; quotes and explicit resume remain available.

Only sessions that still belong to this user in this oracle's canonical room become candidates. The index is separated by binding and consent revision. Message/thread text is untrusted classification evidence. A selected thread conveys no approval or extra tool authority. Existing UCAN, consent, task/group isolation, memory authority, and tool approval checks remain in force. Shared user memory remains separate from each session's checkpointed working history.

Before session creation or model execution, the request receipt stores its assignment in `channel_requests.routing_json`. Retries and polls reuse it. A stored assignment that no longer parses is treated as none (logged once as `[channels] ignoring an unreadable stored route assignment`). A crash after creating a session reuses the deterministic Matrix marker transaction. Routing/Matrix work does not hold the SQLite admission lock: explicit stops can cancel pending routing, and a later explicit session switch supersedes an earlier unstarted assignment. Such a request is not cancelled: its assignment is dropped and it runs in the session the switch bound, as with routing off. In `shadow` the assignment never switches the session, so there is nothing to supersede. Routing work is ordered per binding: a retry of a request still in its binding's lane answers with that submission instead of queueing behind it, and each submission holds the lane at most 20 s (it is then answered `503 unavailable`, and the lane moves on).

The index lives in the user's existing encrypted-owner SQLite file and is capped at 24 entries per binding across revisions; deleting a session removes its index entry even while routing is off. Routed turns index themselves as they start. Receipts written before routing was enabled, or while it was off, are read into the index on the binding's next routed turn; a watermark per binding and revision (`channel_thread_seeded`) keeps later turns from reading them again. Routing receipts and observations follow channel-request retention. Successful reply mirroring refreshes the bounded assistant excerpt for later routing after run pruning.

Structured `[channel-routing]` observations and `channel_requests.routing_observation` record request ID (logs), mode, reason, provider/model, chosen-option probability, margin, candidate session IDs, the option distribution, elapsed time, and a hash of the projected evidence. They do not log message excerpts, phone numbers, or raw provider message IDs. Shadow observations are predictions, not correctness labels.

## Test before widening the pilot

Exercise one allowlisted binding and one ordinary binding in the same deployment, and keep a Portal conversation open:

1. In `off`, send a goal followed by an unrelated question; verify the existing session remains selected and no routing calls occur.
2. In `shadow`, repeat the sequence; verify the same session and inspect the predicted new-thread decision. Portal session selection must stay explicit.
3. In `on`, start an application, ask a follow-up, then ask an independent travel question. Verify two canonical sessions, a visible fresh-topic cue, and preserved application history.
4. Return to the application by name and by quoting its earlier reply. Verify the original session, resolved reference, and return cue. Repeat with voice transcripts.
5. Send ambiguous short answers, multiple requests, unavailable quotes, and multilingual paraphrases. Verify clarification where needed; no action may execute from ambiguous approval.
6. Exercise `/new`, `/resume`, `/interrupt`, and a stop while the router is waiting. Verify explicit choices win and delayed inference starts no cancelled work.
7. Simulate provider failures, timeout, restart, duplicate delivery, and an assigned request retried after switching to `off`. Verify that a failure keeps the current conversation, one stable assignment, and no repeated effects.
8. Check false splits, false merges, old-thread returns, clarification frequency, and end-to-end p50/p95 latency against human labels. Keep live-provider quality and WhatsApp delivery evidence separate from local tests.

Local regression suites cover routing policy/SQLite recovery in `src/channels/routing.test.ts`, real UserOracleDO channel-versus-Portal admission and tool-free canonical clarification in `src/do/user-context-prefetch.test.ts`, and existing authenticated channel routes. Live model quality, billing, and deployed provider behavior remain pilot acceptance work.
