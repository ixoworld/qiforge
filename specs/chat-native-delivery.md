# Chat-native delivery: concise replies, multi-message turns and browser artefacts

**Status:** Accepted; phases 1 and 2 implemented · **Date:** 2026-09-25 · **Revised 2026-10-30: WhatsApp-first.** Ordinary answers stay in chat; only document-length output or a file the user asked for becomes an artefact ([§2](#2-principles), [§4](#4-surfaces-and-delivery-profiles)–[§7](#7-artefacts)).
**Scope:** `packages/oracle-runtime-workers`, `ixoworld/ixo-channel-gateway`, `ixoworld/ixo-portal` (the shared viewer), `ixoworld/companion` (configuration only)
**Builds on:** `packages/oracle-runtime-workers/docs/channels.md`, `docs/plans/durable-runs.md`, the gateway's `docs/engineering-spec.txt`

**Decisions taken on the proposal:**

| Question                          | Decision                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp eligibility              | Provider rendering stays behind the gateway adapter, so Telegram, Slack and Matrix never depend on it.                                                                                                          |
| Who can open an artefact link     | Anyone with the link, until it expires (30 days by default). The repository README records the decision and recommends reviewing it.                                                                            |
| Where the viewer lives            | A shared Qi.Space page (`ARTIFACT_VIEWER_URL`). The runtime's built-in page at `/a/:id` works without it.                                                                                                       |
| Progress lines                    | None. The typing indicator is the liveness signal.                                                                                                                                                              |
| Matrix rooms                      | Chat style opt-in (`MATRIX_CHAT_DELIVERY=true` or `OracleConfig.delivery.matrixChat: true`); off, a room reply is one plain message as before. Third-party oracles are used through Matrix rooms in the Portal. |
| Empty channel replies (finding 9) | Fixed separately, outside this work.                                                                                                                                                                            |

---

## Summary

The Companion replies on WhatsApp, Matrix and (later) Telegram and Slack the same way it replies in the Portal: one long Markdown document, sent only after the whole run has finished. The Portal renders that well, because it streams tokens into a rich view. Chat apps do not render it well.

This spec makes chat a **delivery profile**, chosen per turn, inside the same runtime. It has four pieces:

1. **A surface section in the prompt.** On chat surfaces the model is told it is texting: lead with the answer, prefer two or three messages (more when the answer needs them), and don't use headings or tables.
2. **Reply Plans.** A run on a chat surface finishes as an ordered list of **parts**: short text messages and artefact links. Every part has a stable ID and is delivered exactly once, extending the idempotency that channel runs already have.
3. **Artefacts.** Document-length output (a long report, long code, several screens of text) or a file the user asked for becomes a document the user opens in a browser, while the conversation keeps its conclusions, decisions and next actions. The model creates one with `create_artifact`, and a deterministic shaper creates one automatically when a step is document-length anyway. The user's own database holds the canonical copy. The link serves only ciphertext, and the key sits in the URL fragment, so link unfurlers never see the content.
4. **Rendering stays at the edge.** QiForge decides what the parts are. IXO Channels decides how each provider renders and paces them. The Matrix gateway does the same for Matrix rooms. The Portal is unchanged.

**Recommendation: do not run a separate instance of the Workers runtime for chat.** Everything chat needs is a per-turn decision the runtime can already key on (`TurnRequest.client`, `channel.provider`). A second instance would either create a second Companion, which breaks the one-identity invariant of IXO Channels, or put two writers on each user's owner file. See [§9](#9-recommendation-one-companion-no-separate-runtime-instance).

---

## 1. What happens today

| #   | Finding                                                                                                                                                                                                                                                                                           | Where                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | WhatsApp receives the raw model Markdown (`##`, `**bold**`, table pipes) as a single message, and the gateway **silently cuts it at 4,096 code points**.                                                                                                                                          | gateway `packages/whatsapp/provider.ts`: `body: Array.from(text).slice(0, 4096).join('')`                            |
| 2   | There is exactly one provider message per inbound message: `outbound_delivery.request_id` is `UNIQUE` and the ID is `del_<remote_id>`.                                                                                                                                                            | gateway `src/binding-do.ts` (`queueDelivery`)                                                                        |
| 3   | There is no liveness signal. The gateway polls every 2 s and sends nothing (no read receipt, no typing indicator) until the run finishes, so the user sees silence for the whole agentic run.                                                                                                     | gateway `src/binding-do.ts` (`next_attempt_at = now + 2`)                                                            |
| 4   | Headless turns deliver **only the last AI message**. Text the model writes before a tool call never reaches WhatsApp or Matrix, and that includes substantive content, not only narration.                                                                                                        | `user-oracle-do.ts` `runAttempt`: `text = completed ? lastAiText(capture) : outcome.fullText`                        |
| 5   | No prompt knows the surface. `client: 'channel'` reaches the graph, but nothing branches on it. The only style rule is "Be concise". Node's Slack formatting fragment never fires, because the Slack path never sets `clientType`.                                                                | `core/prompt-composer.ts:408`; Node `graph/main-agent.ts:590-593` versus `modules/messages/agent-builder.ts:204-205` |
| 6   | Matrix room replies are sent without `formattedBody`, so Element shows raw Markdown. Node rendered them with `formatMsg`. Portal and channel _mirrors_ do render, through `formatReplay`. A reply over Matrix's 64 KiB event limit fails outright.                                                | `matrix/gateway-do.ts:598-607`; `matrix/replay-format.ts`                                                            |
| 7   | Nothing in either repository splits a reply into several chat messages, or converts Markdown to WhatsApp or Telegram syntax.                                                                                                                                                                      | repo-wide                                                                                                            |
| 8   | No browser-openable artefact exists for a chat user. `vfs_share` makes a file public with no expiry. The sandbox's `artifact_get_presigned_url` only covers sandbox files. `present_files` exists only as documentation (the SDK's `components/index.ts` re-exports a missing `ArtifactPreview`). | `plugins/vfs/vfs-tools.ts`; `plugins/sandbox`; `packages/oracles-client-sdk/src/components/index.ts`                 |
| 9   | **Bug, separate from this design:** a finished channel run returns empty `text`. `toRecord` reads `client = 'channel'` back as `'portal'`, so `finalize` never stores the answer. The WhatsApp gateway then sends nothing, and the Matrix mirror is skipped.                                      | `do/run-store.ts:258` → `do/run-coordinator.ts:355-359` → `channels/turns.ts`                                        |

Finding 9 blocks any live channel acceptance run and should be fixed first. The tests miss it because they run on `MemoryRunStore`.

---

## 2. Principles

1. **One Companion, many surfaces.** The conversation, memory, runs and transcript are canonical and shared. A surface is a rendering. This is the invariant of IXO Channels: "WhatsApp never becomes their identity, their agent, or their source of truth".
2. **Write for the surface, then enforce it deterministically.** The model is told where it is speaking. A cheap, deterministic shaper guarantees the contract whatever the model does. By default, no extra LLM call is made to shape a reply.
3. **Semantics in QiForge, syntax at the edge.** QiForge decides the messages and the artefacts. The gateway decides provider syntax, UI primitives, pacing and whether a send is allowed at all. The policy kernel stays in the gateway, per its spec §14: "The Companion must never decide whether a channel operation is legally or operationally permitted."
4. **Exactly-once per part.** The `(userDid, bindingId, requestId)` idempotency extends to `(…, partId)`. It is still better to lose a message than to send a duplicate.
5. **Private by default.** Artefact links are safe against link unfurlers. No plaintext is stored in R2; the operator still holds each share key (see the runtime's `docs/chat-delivery.md`). The canonical copy belongs to the user.
6. **The Portal's streaming is untouched.** Its SSE streaming, frames and tools do not change. The Portal gains only the shared artefact viewer.
7. **Chat first; a link is never the only copy of an ordinary answer.** Many users have WhatsApp-only data plans and cannot open a general browser. Most answers stay in the conversation, split into two or three coherent messages where that helps; three is a presentation preference, never a reason to drop content. Small tables and lists are rewritten for chat, not exported. An artefact is reserved for necessarily long output or a file the user asked for, and even then the conversation keeps the conclusions, decisions and next actions. The prompt, the `create_artifact` description and the shaper state this policy together and must change together.

---

## 3. Design overview

```mermaid
graph LR
    WA[WhatsApp / Telegram / Slack] -->|webhook| GW[IXO Channels gateway]
    GW -->|POST /channels/turn, polled| Shell[Oracle Worker shell]
    Element[Matrix clients] -->|/sync| MGW[MatrixGatewayDO]
    MGW -->|runTurn| UDO
    Portal[Portal / Qi.Space] -->|HTTP + SSE| Shell
    Shell --> UDO[UserOracleDO]
    UDO -->|profile = stream| SSE[SSE frames, unchanged]
    UDO -->|profile = chat| Plan[Reply Plan: parts]
    Plan -->|parts in poll response| GW
    Plan -->|one event per part| MGW
    UDO -->|create_artifact / auto-spill| Art[(Artefact: user DB + ciphertext in R2)]
    Art -->|"link: /a/id with key in fragment"| Viewer[Browser viewer]
```

A turn resolves a **delivery profile** from its surface. The profile feeds four consumers:

| Consumer         | What the profile changes                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Prompt composer  | Adds the `surface` section ([§5](#5-writing-for-the-surface))                                                   |
| Tool surface     | Binds `create_artifact` on chat surfaces only ([§7](#7-artefacts))                                              |
| Run completion   | Projects the run into a Reply Plan, running the shaper per model step ([§6](#6-reply-plans))                    |
| Delivery drivers | The gateway renders and paces parts. The Matrix gateway posts one event per part ([§8](#8-delivery-by-surface)) |

---

## 4. Surfaces and delivery profiles

The runtime already knows the surface of every turn:

| Ingress               | `TurnRequest.client` | Extra                           | Profile                                                                                         |
| --------------------- | -------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Portal HTTP           | `portal`             | none                            | `stream`: today's behaviour, no shaping                                                         |
| `POST /channels/turn` | `channel`            | `channel.provider`              | `chat` with that provider's limits (`whatsapp`, `telegram`, `slack`), else `generic`            |
| Matrix room message   | `matrix`             | `roomKind` (`direct` / `group`) | `chat` `matrix`; a group room gets 1–2 messages, 3 parts per reply, spill over 2,400 characters |
| Scheduled task run    | `matrix`             | `task:` session                 | `stream` on every surface: a stored result keeps the model's whole text, never a chat rendering |

```ts
// src/delivery/types.ts
export type DeliveryProfile =
  | { kind: 'stream' }
  | { kind: 'chat'; surface: string; label: string; limits: ChatLimits };

export interface ChatLimits {
  bubbleTarget: number; // soft size of one message, characters; the prompt asks for it
  bubbleMax: number; // hard size before a sentence split
  minBubble: number; // shorter fragments merge into the next message
  maxBubbles: number; // preferred messages per answer: the prompt asks for it, packing merges toward it; never a spill trigger
  maxPartsPerRun: number; // across the whole reply
  spillChars: number; // a step's rendered text longer than this → spill
  maxListItems: number; // a longer list, or a table with more rows → spill with a preview
  previewItems: number; // list items kept in the lead message
  maxCodeLines: number; // a longer code block → spill
  tables: boolean; // may a table stay inline as a table? Otherwise one line per row; never a spill trigger
}
```

These are the defaults. An oracle overrides them per surface in `OracleConfig.delivery.limits`; a count must be a whole number of at least 1, or the default stays. Matrix rooms get the `stream` profile unless `MATRIX_CHAT_DELIVERY=true` or `OracleConfig.delivery.matrixChat: true`, and scheduled task runs always do. Artefacts are available on every chat surface whenever artefact storage is configured.

| Field                       | `whatsapp`  | `telegram`  | `slack`       | `matrix`      | `generic`   |
| --------------------------- | ----------- | ----------- | ------------- | ------------- | ----------- |
| bubbleTarget / bubbleMax    | 600 / 1,500 | 800 / 2,000 | 1,200 / 3,000 | 1,200 / 4,000 | 600 / 1,500 |
| minBubble                   | 60          | 60          | 60            | 60            | 60          |
| maxBubbles / maxPartsPerRun | 3 / 8       | 3 / 8       | 3 / 8         | 3 / 8         | 3 / 8       |
| spillChars                  | 4,500       | 4,500       | 6,000         | 8,000         | 4,500       |
| maxListItems / previewItems | 15 / 3      | 15 / 3      | 15 / 3        | 15 / 3        | 15 / 3      |
| maxCodeLines                | 40          | 40          | 40            | 40            | 40          |
| tables inline               | no          | no          | no            | no            | no          |

A Matrix group room overrides `maxBubbles` to 2, `maxPartsPerRun` to 3 and `spillChars` to 2,400, so a group never hears a long answer in chat.

The defaults keep an ordinary answer in chat: a 4,500-character answer is three full WhatsApp messages at `bubbleMax`, a 15-item list and a 40-line code block are still readable on a phone, and a table is rewritten as lines. Message sizes stay deliberately far below the provider hard limits in the [appendix](#appendix-provider-limits-that-shape-the-design) (WhatsApp 4,096 per message against a `bubbleMax` of 1,500). The gateway enforces those limits a second time.

The profile also appears on `RuntimeContext` as `ctx.session.surface`: `{ kind: 'stream' }` or `{ kind: 'chat', surface, label }`. Plugins can then adapt their output, for example a tasks plugin returning a compact list on chat. This is a public API addition, so it needs a matching update to the public docs.

---

## 5. Writing for the surface

This is a new framework-owned slot in `core/prompt-composer.ts`, after `COMMUNICATION_STYLE`. `renderSurfaceSection` (`src/delivery/prompt.ts`) fills it only on chat turns.

```text
## Where this conversation is happening

You are replying in {label}. The user reads your reply as chat messages, often on a phone with a chat-only data plan and no browser, so the answer itself belongs in the messages.

- Lead with the answer. Write like a sharp person texting: short sentences, no preamble, no sign-off.
- Prefer {two or three messages}. A blank line marks where a message may break; short paragraphs are grouped so the reply reads as {two or three messages}. Keep each paragraph under about {bubbleTarget} characters. Use more messages when the answer needs them; never leave content out to fit.
- Ordinary answers stay in chat, including explanations, comparisons, short plans and step-by-step instructions. No headings or horizontal rules. Lists up to {maxListItems} items, code up to {maxCodeLines} lines and **bold** for the key fact are fine in chat. Write a small comparison as one short line per item, not a table.
- Use `create_artifact` only when the user asks for a document or file, or when the output is genuinely document-length: several screens of text, long code, a long report. Even then, its message carries the conclusions, decisions and next actions, and the document holds the detail. Call it last: the user gets the message, a link to the document, then at most one follow-up question.
- The user sees a typing indicator while you work. Do not narrate your steps or announce tool calls.
- End with at most one question.
```

`{two or three messages}` is `maxBubbles` in words: "one message", "one or two messages", "two or three messages", else "up to N messages". Without artefact storage, the `create_artifact` line reads instead: "Everything you write is delivered as messages; when something is genuinely long, put the essential part first." (Nothing is withheld there: the shaper never spills without storage.)

Why a composer slot rather than a plugin middleware: the surface belongs to the framework, like Node's Slack slot, not to any plugin. The Companion's own `communicationStyle` ("Match energy: one-liners back when terse…") is consistent with the slot and needs no change.

---

## 6. Reply Plans

### 6.1 Parts

```ts
// Shared by the runtime, the channel contract and the gateway.
export type ReplyPart =
  | { partId: string; kind: 'text'; text: string }
  | { partId: string; kind: 'artifact'; artifact: ArtifactRef };

export interface ReplyPlan {
  v: 1;
  parts: ReplyPart[];
}

export interface ArtifactRef {
  artifactId: string;
  title: string; // ≤ 120 characters; a gateway shortens it where it must (a WhatsApp CTA header takes 60)
  url: string; // viewer URL, including the #k= fragment
  mime: 'text/markdown';
  bytes: number;
  expiresAt: string; // ISO 8601
}
```

`text` carries **chat Markdown**, a CommonMark subset: `**bold**`, `_italic_`, `~~strike~~`, inline code, fenced code, `-` and `1.` lists, `>` quotes, and links. The shaper produces nothing outside this subset. Each gateway maps it to provider syntax.

A `choices` part (tappable options: WhatsApp reply buttons, Telegram inline keyboards, Slack buttons) is a later phase.

### 6.2 From a run to a plan

The plan is built **once, when the run finishes** (`src/delivery/plan.ts`). There are no progress lines to release early: the typing indicator is the liveness signal. So one plan per run is the simplest thing that is also idempotent. Streaming a message while it is written stays possible later without changing the contract.

1. The turn's **model steps** are its AI messages after the last human message. Each step can write text and call tools.
2. Text of 200 characters or less that precedes a tool call, in one paragraph with no list or code, is **narration** and is dropped. Once the answer arrives, "Checking your calendar" adds nothing.
3. Any other step text is **content**. It goes through the shaper ([§6.3](#63-the-shaper)). This fixes finding 4: a plan the model writes before calling tools is no longer lost.
4. A `create_artifact` call adds three parts in order: its `message` as a text part, its `artifact` part, then its optional `followUp` question. This is the same lead → artefact → closing shape as an automatic spill.
5. The reply is capped at `maxPartsPerRun` by merging the shortest adjacent pair of text parts, as long as the result fits `bubbleMax`. If that is not enough, a spill's lead and closing go, because its artefact holds both; the reply's last part stays as long as possible. Text found nowhere else is never dropped, so a reply with several documents, or a long reply without artefact storage, can stay over the cap.
6. A resumed run puts back the text it had streamed before the reset, minus the steps the checkpoint kept, in front of the first step after them.

The model's checkpointed messages are **never rewritten**. The model remembers what it actually wrote, and the plan is a projection of it for one surface.

### 6.3 The shaper

This is a pure function, `shape(markdown, profile) → ReplyPart[]`. It uses the `marked` lexer, already a runtime dependency, and `Intl.Segmenter` (locale pinned to `en`, so a rebuilt plan splits the same way on every runtime) for sentence and grapheme boundaries. No message, lead or closing it produces is longer than `bubbleMax`.

1. **Lex** the step text into blocks: paragraph, list, code, table, heading, quote, rule.
2. **Decide whether to spill**, before packing. A step spills only when it is document-length: its rendered text (the blocks joined by blank lines) is longer than `spillChars`, it has a code block over `maxCodeLines` lines, or a list with more than `maxListItems` items or a table with more than `maxListItems` rows. Nothing else spills it: a small table is rewritten as one line per row (unless `tables`), and the number of messages a step packs into never counts, because `maxBubbles` is a packing preference (step 3) and the run's cap is applied later, by merging ([§6.2](#62-from-a-run-to-a-plan)).
3. **Pack**, when not spilling:
   - A heading becomes a bold line attached to the block that follows it.
   - A paragraph ending in `:` stays with the list, table or code block after it.
   - Either starts the message that holds what follows it. When joining would pass `bubbleMax`, the next block is split with the room left (`bubbleMax` minus the heading or lead-in), so the heading rides on its first piece. Only a lead-in longer than half of `bubbleMax` is sent ahead as message(s) of its own, and those are never joined onto the message before them.
   - A fragment shorter than `minBubble` merges into the next one, when the result fits `bubbleMax`.
   - Anything over `bubbleMax` is split at paragraph, line, sentence, then word boundaries, and as a last resort between graphemes (never inside an emoji or a surrogate pair). A code block is re-fenced per piece.
   - **Toward `maxBubbles`:** a step with no more units than `maxBubbles` keeps the model's own message breaks. Otherwise the units are filled left to right into messages of at most `bubbleTarget` (joined by a blank line). If that still leaves more than `maxBubbles`, the original units are filled again, left to right, up to `bubbleMax`. A unit holding a code block is never joined to another here: a code block of at least `minBubble` characters keeps its own message; a shorter one merges forward like any fragment (the `minBubble` step above). Greedy filling gives the fewest messages for the order given; a step that cannot fit stays at more messages, and nothing is dropped or spilled on count. Five 250-character paragraphs become 3 messages; ten 432-character paragraphs become 4.
   - Each resulting unit is one bubble.
4. **Spill**, when needed. The output is **lead → artefact → closing**, so the conversation keeps the substance even when the document is never opened:
   - The lead is the first block after any heading. A leading code block is skipped (the artefact holds it, so a spill caused by long code never repeats it in chat); the lead comes from the block after it, or is empty. When that block is a paragraph and the step's last block ("Want me to apply it?"), it is the closing instead, after the link, and there is no lead. A paragraph or quote is kept whole when it fits `bubbleMax`, else cut at a sentence boundary. A list or table, or a lead-in that ends in `:` followed by one, is previewed: its first `previewItems` items or rows (as chat lines) plus "…and N more". A preview that does not fit `bubbleMax` keeps fewer items (down to one), then cuts that item and, if needed, the lead-in with "…"; the trailer and its count always stay.
   - The artefact is the whole step text, titled by its first heading or else its first sentence (cut at 60 characters without splitting a grapheme).
   - The closing is the step's last block, when the lead did not use it. A list or table (with its `:` lead-in, if the block before it is one) is previewed the same way, so "Next steps:" and its first items stay in chat. A last paragraph is joined to the paragraph before it when both fit `bubbleMax` (a conclusion and its question), else kept alone when it fits, else its last sentences that fit. It is kept whether or not it is a question, and never equals the lead.
   - Lead and closing are spill framing: when a run is over `maxPartsPerRun` and merging text is not enough, `capParts` drops them, the reply's last part last ([§6.2](#62-from-a-run-to-a-plan)). The artefact holds both. A Matrix group room (3 parts per run) reaches that point soonest.
5. **Normalise** to chat Markdown. Headings become bold, rules and raw HTML are dropped, and a table becomes one line per row (`- **first cell** · Header: value · …`) unless `tables` is set.

Example (a golden test): "plan my week", 789 characters with a table and a 3-step list, is what the model writes for the Portal. Before the 2026-10-30 revision it spilled because of its table; it now stays in chat as one message: its four blocks are more than the preferred three, and together they fit `bubbleTarget`:

| Today on WhatsApp before chat delivery (one message)                                                                                     | With this design (one message, no link)                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `## Your week at a glance` ↵ `You have **14 meetings**…` ↵ `### Deadlines` ↵ `\| Item \| Due \| Status \|` ↵ `\|---\|---\|---\|` … (raw) | **Your week at a glance** ↵ You have **14 meetings** this week… ↵ **Deadlines** ↵ - **Board deck** · Due: Wed 1 Oct · Status: Draft 60% ↵ … ↵ **Suggested plan** ↵ 1. **Monday 08:00–10:00**: focus block for the board deck. ↵ … ↵ Want me to add the focus blocks and move the 1:1 with Sam? |

More results from the golden tests:

- A 190-character flight answer stays as 2 messages.
- A 10-item restaurant list stays in chat: the lead-in with the list, then "Should I book one of these?". A 20-item list spills as the lead-in, the first 3 items and "…and 17 more", then the artefact, then the question.
- A 5,000-character step spills with its whole first paragraph before the link and its last two paragraphs (ending "Next step: take the signed form…") after it.

With the §5 prompt the model should usually write the chat form itself. The shaper is the safety net.

### 6.4 Durability and idempotency

- **Stable IDs.** Parts are `p1` … `pn` in delivery order. The plan is stored with the run, so a re-poll, a replayed Matrix event and a recovered run all read the same plan.
- **Persistence.** `turn_run_plans(run_id, plan)` holds the plan. It is pruned with the run after the seven-day retention, and the channel tombstone rules (410 after pruning) are unchanged.
- **Artefact IDs are deterministic.** An ID is the first 128 bits of a SHA-256 over `(runId, source)`. The source is the `create_artifact` call's tool call ID, or the step key of an automatic spill. Creation is idempotent per ID. So the tool is declared read-only for recovery, and a recovered run converges on the same artefact rather than being answered "outcome unknown" by `ToolMarksMiddleware`.
- **Channel contract.** A finished response carries the plan next to the existing fields. `text` becomes the plan rendered as one Markdown message, with artefacts as links, so gateways that predate plans keep working:

  ```ts
  interface ChannelTurnResponse {
    // …existing fields: requestId, runId, sessionId, status, messageId?, text?
    plan?: ReplyPlan; // finished turns of chat runs
  }
  ```

  Polling still repeats the exact request body. Artefact content never travels in the plan, only its link.

---

## 7. Artefacts

### 7.1 `create_artifact`

The runtime binds this tool on chat turns when artefact storage is configured (`src/artifacts/tool.ts`). It is a turn tool of the runtime, not a plugin tool: whether it exists depends on the delivery profile, which the runtime owns.

```ts
create_artifact({
  title: string,        // ≤ 120 characters
  content: string,      // full Markdown, ≤ 200,000 characters
  message: string,      // the chat message sent before the link: conclusions, decisions, next actions; ≤ 1,000
  followUp?: string,    // at most one question, sent after the link, ≤ 300
}) → { ok: true, artifactId, title, url, mime, bytes, expiresAt }
```

The tool's description carries the same policy as the prompt: use it **only** when the user asked for a file or document, or when the output is genuinely document-length (a long report, long code, several screens of text). Ordinary answers, comparisons, short plans and lists stay in chat as messages. `content` holds the full Markdown; `message` holds the conclusions, decisions and next actions, so the user has them without opening the document. `message` allows 1,000 characters for that. It is delivered as its own text part before the link, which a gateway splits at its provider's limit (4,096 on WhatsApp); it is never put inside the link card.

- **Return-direct.** It ends the run without another model call, which saves a full-context round trip for every artefact.
  - LangChain 1.4's `createAgent` exits only when the **last** tool result of a step comes from a return-direct tool. So the tool description asks for `create_artifact` as the final call, on its own.
  - When the model calls it alongside other tools anyway, an `afterModel` hook in the core (`middlewares/return-direct-first.ts`) moves it to the front of that step's tool calls. The loop then continues, and the model sees every result.
- **Read access.** A second tool, `read_artifact`, would let the model quote from or update an earlier artefact. Later.

### 7.2 Storage

| Copy          | Where                                                                                                                         | Why                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Canonical** | `artifacts` table in the user's SQLite                                                                                        | It is exported with the rest of the working copy to `/.oracles/<oracleDid>/state.db.gz`, so **the user owns it** and needs no new grant. |
| **Share**     | R2 object `art/<artifactId>` in `ARTIFACT_BUCKET`: AES-256-GCM ciphertext of `{v, title, mime, content, createdAt}`, IV first | Serves the browser link without waking the user object. The operator bucket never holds plaintext. Custom metadata: `expiresAt` only.    |
| Library copy  | `/Qi/Artefacts/<date> <title>.md` in the user's VFS                                                                           | Later: visible in Qi.Space's Library when the user has granted the vfs plugin library access.                                            |

The share copy needs one R2 binding, `ARTIFACT_BUCKET` (its own binding, separate from the page tier's `TIER_BUCKET`), a public origin (`ORACLE_PUBLIC_URL`) and a lifecycle rule on `art/`. Without them, artefacts are off: long replies are split into messages, and `create_artifact` is not offered.

### 7.3 Links and the viewer

```
https://<oracle>/a/<artifactId>#k=<key>                                   built-in page
https://<viewer>#a=<encoded https://<oracle>/a/<artifactId>>&k=<key>      ARTIFACT_VIEWER_URL (Qi.Space)
        artifactId: 128 bits · key: 256-bit AES-GCM key, base64url
```

- **`GET /a/:artifactId`** serves a static viewer page, identical for every artefact. It is mounted ahead of CORS and auth.
  - Headers: `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `nosniff`.
  - CSP: `default-src 'none'`; only the page's own hashed script and style; `connect-src 'self'`; `frame-ancestors 'none'`.
  - In the browser, the page reads the key from `location.hash` and decrypts with WebCrypto. It renders the Markdown through DOM APIs only: no `innerHTML`, only `http(s)` and `mailto` links, and images as links. It offers Copy and Download `.md`.
- **`GET /a/:artifactId/data`** returns the ciphertext.
  - It answers any origin (`Access-Control-Allow-Origin: *`), because the shared viewer fetches it from another host.
  - `Cache-Control: private, max-age=60`, so a revocation takes effect within a minute.
  - It is rate-limited per client IP.
  - An expired object answers `410` and is deleted.
- **The shared viewer** is the Portal's `/artifact` page, set as `ARTIFACT_VIEWER_URL`.
  - It fetches only `/a/<id>` paths over https, on hosts in `NEXT_PUBLIC_ARTIFACT_SOURCE_HOSTS` (default `ixo.earth`).
  - It decrypts in the browser, renders with the Portal's Markdown component with images as links, and states that an agent wrote the document.
  - The Portal's product analytics and error reporting remove the fragment from every URL they record, so the key never reaches either.
- **Expiry and revocation.**
  - Links default to 30 days (`ARTIFACT_LINK_TTL_DAYS`). No setting makes a link live longer than 365 days.
  - `DELETE /artifacts/:id` (the owner, authenticated) deletes the share copy. The canonical copy stays, and asking Qi again mints a fresh link with a new key.
  - `GET /artifacts/:id` returns the canonical copy, with `url` only while the link works.
  - Deleting a session deletes its artefacts, share copies first.
  - Revoking a channel binding does not yet revoke the links created through it. Later.
- **Origin.** The built-in page runs on the oracle's API origin. That origin holds no cookies or stored credentials (auth is a UCAN header per request), and the page runs only its own hashed script. A dedicated hostname on the same Worker script remains an option.

### 7.4 Security properties

| Threat                                                                     | Outcome                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link unfurlers: WhatsApp and Telegram clients or servers, Slack's unfurler | They fetch the path, never the fragment, and get only the generic page. On top of this, the WhatsApp gateway sends artefacts as buttons and turns link previews off.                                             |
| Server, proxy and CDN logs                                                 | The path holds a random ID. The key is in the fragment and is never sent.                                                                                                                                        |
| An operator or bucket leak                                                 | The bucket holds AES-GCM ciphertext only. Keys live in the user's own database and in the link.                                                                                                                  |
| The shared viewer's telemetry                                              | PostHog events and Sentry reports from the Portal have the viewer's fragment removed before they are sent.                                                                                                       |
| A forwarded message                                                        | Bearer-link semantics, by decision: anyone holding the link can read the document until it expires or is revoked. The repository README records the decision and recommends reviewing it.                        |
| A document used for phishing                                               | Anyone can have an agent write a document and share its link. The shared viewer fetches only from allowlisted oracle hosts, and says that an agent wrote the document.                                           |
| Prompt injection leaking data through an artefact                          | No new channel: the link goes only to the user who asked. Both viewers render images as links, so opening a document fetches nothing on its own. Sending it elsewhere still needs a tool with its own authority. |

---

## 8. Delivery by surface

### 8.1 IXO Channels (WhatsApp now; Telegram and Slack later)

These are changes in `ixoworld/ixo-channel-gateway`. The authority model, admission and polling do not change.

```mermaid
sequenceDiagram
    participant U as WhatsApp user
    participant G as IXO Channels (ChannelBindingDO)
    participant Q as Companion (UserOracleDO)
    U->>G: "Plan my week"
    G->>U: mark read + typing
    G->>Q: POST /channels/turn
    Q-->>G: 202 running
    G->>U: typing (renewed every 20 s while polling)
    G->>Q: poll, same body
    Q-->>G: 200 finished, plan: p1 message, p2 artefact, p3 question
    G->>U: CTA card: title, the message, "Open document"
    G->>U: Want me to add the focus blocks?
    Q->>Q: mirror the reply to the Companion room
```

| Area                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/qiforge.ts`              | Parses `plan` next to `text`. A plan that does not parse is dropped (counted as `qiforge_plan_invalid_total`), and `text` is sent instead.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `outbound_delivery`           | One row per part: `part_id`, `UNIQUE(request_id, part_id)`. The ID is `del_` + HMAC(`delivery \0 requestId \0 partId`): still 64 hex characters, so the receipt regex and `biz_opaque_callback_data` reconciliation still work. Existing objects rebuild the table in place.                                                                                                                                                                                                                                                                    |
| Ordering and pacing           | Parts go out strictly in order, about a second apart. After an ambiguous (`unknown`) send, the rest of the reply waits ten seconds so the receipt can land first. Graph API pacing errors (pair rate limit 131056; throughput 4, 80007, 130429) are retried without spending the part's attempts.                                                                                                                                                                                                                                               |
| Ambiguous sends               | A part in `unknown` is never resent. This keeps the gateway spec's rule: "prefer one missing response over multiple user-visible duplicate replies".                                                                                                                                                                                                                                                                                                                                                                                            |
| Policy                        | The binding check and `channelPolicy` run again before **every** part. A binding revoked in the middle of a reply suppresses the rest. The 24-hour window is checked per part. A document link is allowed only as an outbound reply.                                                                                                                                                                                                                                                                                                            |
| Liveness                      | While the turn runs, the message is marked read and the typing indicator is shown, renewed every 20 seconds while polling. The raw inbound message ID this needs is sealed in the pending payload and removed with it.                                                                                                                                                                                                                                                                                                                          |
| `packages/whatsapp/render.ts` | Maps chat Markdown to WhatsApp syntax: `*bold*`, `_italic_`, `~strike~`, monospace, lists, quotes; `label (url)` for links. An artefact becomes a **CTA URL** card: the title as its header (≤ 60), "Link valid until <date>" as its body (with the full title first when the header cuts it), and "Open document" as its button. The `create_artifact` message and a spill's lead go before the card as text parts of their own. Anything over 4,096 characters is split at paragraph, line, sentence and word boundaries. **Never truncate.** |

Later adapters use the same parts:

- **Telegram:** HTML parse mode, URL inline keyboards for artefacts, `sendChatAction` for typing.
- **Slack:** the `markdown` block and a URL button.
- **Streaming:** both now support native streaming (Telegram's `sendMessageDraft`, Slack's `chat.startStream`). A later phase can stream the message currently being written, without any change to the plan contract.

### 8.2 Matrix rooms

Matrix rooms get the chat profile when it is turned on (`MATRIX_CHAT_DELIVERY=true`); it is off by default so a deployment without artefact storage does not turn a long reply into many events. This is how third-party oracles are used from the Portal.

- `MatrixGatewayDO` posts one `m.text` per part in the thread.
  - Each is rendered to HTML with raw HTML from the model escaped, which fixes finding 6 for chat-style rooms.
  - An artefact part is its title and an "Open document" link.
  - Transaction IDs are `reply-<eventId>-<partId>`, so the homeserver still deduplicates a replay.
- There are no progress parts. The typing notification and the `work_status` card show liveness.
- `MatrixTurnLedger` stores the plan with the reply, so a replayed turn re-delivers the same parts.
- A `stream` reply (the default, chat style off) is one plain message without `formattedBody`, exactly as before.
- Task runs keep the `stream` profile, so a task delivery posts the model's whole text and a stored result never depends on an expiring link.
- An `org.ixo.qi.artifact` content key, which would let Qi.Space render a card, is later.

### 8.3 Portal / Qi.Space

- The `stream` profile leaves SSE, frames, browser tools and AG-UI as they are, and `create_artifact` is not bound.
- The shared viewer is the `/artifact` page ([§7.3](#73-links-and-the-viewer)). It is public: the person may not be signed in on that device.
- History from chat surfaces shows the canonical message. A reply that ended in `create_artifact` lists as the message, the link and the question the user received.
- An artefact card that opens the canonical copy through the authenticated `GET /artifacts/:id` is later. It would replace the dead `present_files` / `ArtifactPreview` remnants in the SDK.

### 8.4 Canonical transcript and the Companion room

- The model's checkpointed messages are unchanged ([§6.2](#62-from-a-run-to-a-plan)).
- The channel mirror still posts **one** event per run into the canonical encrypted room. It holds the plan's text: the delivered content joined in order, with artefact links. So Qi.Space and Element show what the user actually received.
- An `org.ixo.qi.delivery` key recording how the reply was split, next to the existing `org.ixo.qi.origin`, is later.

---

## 9. Recommendation: one Companion, no separate runtime instance

**We should not run a separate instance of the QiForge Workers runtime for chat.** A separate instance could mean any of three deployments:

| Option                                                                                                                     | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **A. A second oracle for chat** (new `ORACLE_DID`)                                                                         | This creates a second Companion.<br><br>- Its user objects, sessions, checkpoints, tasks and preferences are separate.<br>- The Rooms Appservice keys the room on (user DID, oracle DID), so it gets a separate room, which breaks Qi.Space continuity.<br>- It needs a second delegation from every user.<br>- Auth Hub grants bind `oracleDid` in their caveats, so it needs a second consent.<br><br>This contradicts the IXO Channels invariant: "one authenticated route to the same DID, Matrix identity, Companion, memories". | ✗                                                       |
| **B. Same `ORACLE_DID`, a second deployment with its own `UserOracleDO` class**                                            | - Each user gets **two working copies** of one database, both exporting to the same owner file (`/.oracles/<oracleDid>/state.db.gz`). The last writer wins over the user's system of record.<br>- The per-user object is the serialisation point for turns. Two of them lose the ordering between a WhatsApp message and a Portal message.<br>- A second Matrix gateway on the same bot account means a second device and sync loop for one identity.                                                                                 | ✗                                                       |
| **C. A thin ingress-only script** bound across scripts to the Companion's existing `UserOracleDO` (like the gateway split) | This is safe: one user object, one owner file. But turns still run in the same user objects, so chat load, prompts and tools are not isolated. It separates only a stateless handler that already has its own UCAN policy, rate-limit hook and off switch (`CHANNEL_SERVICE_DID` empty). The cost is a third script per network, with its own deploy order and secrets.                                                                                                                                                               | Not now; this is the fallback if a trigger below is hit |
| **D. Chosen:** the same deployment, with chat as a delivery profile                                                        | Every chat difference is a per-turn decision (table below). Isolation that matters already exists in IXO Channels and in the Matrix gateway script.                                                                                                                                                                                                                                                                                                                                                                                   | ✓                                                       |

| Chat needs                           | Where it lives, without a new instance                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A concise, chat register             | The surface prompt section, per turn                                                                                                                |
| Different tools                      | `create_artifact` bound on chat surfaces only; browser tools already fail headless and can be unbound there                                         |
| Output shaping and artefacts         | Reply Plan and the shaper, per run                                                                                                                  |
| A faster or cheaper model (optional) | A profile `model` hint that feeds `TurnRequest.model` (already resolved and allow-listed in `prepareTurn`); BYO users keep their own                |
| Separate rate limiting               | A route-scoped limiter key (`channel:<did>`) instead of the shared per-DID bucket; channel polling uses about 30 of its 100 requests a minute today |
| An off switch                        | `CHANNEL_SERVICE_DID` (exists); `OracleConfig.delivery` flags                                                                                       |
| Provider secrets, webhooks, policy   | The IXO Channels gateway, already a separate Worker with its own Durable Objects                                                                    |
| Protecting the Matrix bot            | The gateway script split, which already exists                                                                                                      |

**What would change this:**

1. Measured contention on the oracle script's shell caused by channel traffic → move to option C, not A or B. This is unlikely, because the shell is stateless and user objects scale per user.
2. A provider's terms admit only a narrow-purpose bot → that is a **different product and oracle** with its own scope, not a copy of the Companion.
3. Channel ingress needs a release cadence independent of the Companion → option C.

---

## 10. Rollout

| Phase                         | Scope                                                                                                                                                                                                                                                                         | Status                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **0. Prerequisite**           | Fix finding 9, with a SQLite-store test.                                                                                                                                                                                                                                      | Being fixed separately                                                            |
| **1. Chat replies**           | Runtime: profiles, the surface section, the shaper, Reply Plans, `plan` on `/channels/turn`, plan delivery and HTML replies in `MatrixGatewayDO`. Gateway: per-part rows, ordering and pacing, per-part policy, the Markdown→WhatsApp renderer, no truncation, read + typing. | Done                                                                              |
| **2. Artefacts**              | Runtime: `create_artifact`, auto-spill, the `artifacts` table, share copies, the built-in viewer, owner routes. Gateway: CTA URL cards. Portal: the shared `/artifact` viewer. Companion: an artefact bucket and `ORACLE_PUBLIC_URL`.                                         | Done; the Companion's buckets and lifecycle rules must be created before a deploy |
| **3. Interaction and polish** | `choices` with interactive inbound replies, a verbosity preference, `read_artifact`, CSV and HTML artefacts, Telegram and Slack adapters, native streaming, `org.ixo.qi.artifact` / `org.ixo.qi.delivery` keys, revoking links with a binding, the Portal's artefact card.    | Later                                                                             |

---

## 11. Testing and measures

**Tests** (following `docs/testing/` conventions; no test-side retries that mask failures):

- **Shaper:** pure unit tests with golden fixtures: short answer, list with a lead-in, table, long list, code, a closing question, CJK and emoji segmentation. Every output part is checked for byte and character limits, and for staying inside the chat Markdown subset.
- **WhatsApp-first acceptance** (shaper goldens under the WhatsApp defaults). These stay in chat with no automatic artefact: a normal answer (1–2 messages); a 1,801–4,500-character answer (every message within `bubbleMax`, order kept, no text lost); five moderate paragraphs (filled into three messages, all text kept in order); an eight-item list (intact with its lead-in); a small comparison table (one line per row). These spill: a 5,000-character step (whole first paragraph as the lead, the last paragraphs as the closing without a question mark), a 20-item list (three-item preview and "…and 17 more"), a 40-row table (three-row preview) and a 60-line code block; a 30-line code block stays in chat, re-fenced where it is split. Boundaries: exactly `spillChars` stays in chat and one character more spills. Packing goldens: a three-paragraph step keeps the model's breaks, a code block of at least `minBubble` characters is never merged into a neighbour, paragraphs too large to pair stay separate, ten 432-character paragraphs become four messages, and eight paragraphs totalling 5,000 characters spill on length, not on count. Closings: a closing "Next steps:" list is previewed, a conclusion keeps its question, a last paragraph over `bubbleMax` keeps its trailing sentences, and the closing never repeats the lead. Previews keep "…and N more" when they must shrink (fewer items, then a cut item or lead-in). A leading code block that caused the spill is never the lead. A heading starts the message that holds its body. Cuts never split an emoji. Every shaper test checks that no message, lead or closing passes `bubbleMax`, including a 4,300-character lead-in and thirty headings in a row. The prompt test checks that `create_artifact` is mentioned only when bound and that its line no longer names comparisons or tables.
- **Plans:** workerd tests for the plan a finished channel turn returns, the same plan on re-poll, idempotent artefact creation, and pruning that removes the plan with the run but keeps the tombstone.
- **Gateway:** exactly one provider send per part under duplicate polls and restarts, `unknown` never resent, revocation in the middle of a reply suppressing the rest, pacing errors retried without spending attempts, the outbox migration, and never truncating.
- **Viewer:** the page never renders content without the fragment; CSP and noindex headers are present; decryption round-trips; expired and revoked links return a clear page.
- **Evaluations** (per `specs/agent-evaluations.md`): about 30 chat-surface prompts (quick facts, plans, research, lists, drafts). Deterministic checks cover bubble count and length, and headings and tables. An LLM judge scores "reads like a message", "answer first" and "long content in an artefact".

**Measures:**

- Time to first message on chat surfaces
- Messages per turn
- Spill rate, split into model-authored and automatic
- Artefact open rate (viewer data fetches per artefact)
- WhatsApp pair-rate errors (131056)
- Deliveries left in `unknown`
- Share of replies over 4,096 characters (should fall to 0% truncated)
- Median length of the user's next reply, a proxy for conversational feel

---

## 12. Risks and open questions

1. **WhatsApp eligibility.** Meta's Business terms barred general-purpose AI assistants from 15 January 2026. A March 2026 revision re-admitted them for a fee. The European Commission's interim measures of June 2026 require free access in the EEA while its investigation runs. The gateway spec already treats provider eligibility as a release gate. _Decided:_ rendering stays behind the adapter seam, so Telegram, Slack and Matrix do not depend on that outcome.
2. **Model compliance varies by model** (Companion users can pick models or bring their own). The shaper makes the contract independent of the model, and evaluations track the gap.
3. **Bearer links.** _Decided:_ "anyone with the link" with expiry is the default. The README recommends reviewing it before chat channels leave pilot: a signed-in mode through Qi.Space for sensitive content, the 30-day default, and a per-user choice.
4. **Viewer hostname.** _Decided:_ a shared Qi.Space viewer, with the runtime's built-in page as the default that needs nothing else.
5. **Progress lines.** _Decided:_ none. The typing indicator is enough.
6. **Summary quality on auto-spill.** The lead is extractive, and with the §5 prompt the model normally writes the summary itself. If measurement shows poor leads, an optional bounded Decision can pick the best lead paragraph without generating free text.
7. **Pacing under WhatsApp's pair limit.** A reply of eight parts (the WhatsApp cap since the 2026-10-30 revision) is a burst that borrows from the next 48 seconds of quota. A quick follow-up can then hit error 131056, which the gateway waits out. If that proves common, merge adjacent text parts when the quota is short.

---

## Appendix: provider limits that shape the design

| Provider       | Hard limits                                                                      | Pacing                                                                                             | Liveness                                         | Native streaming                                   |
| -------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| WhatsApp Cloud | Text 4,096 characters; CTA URL body 1,024, header and footer 60, button label 20 | 1 message per 6 s to the same user; bursts up to 45 in 6 s borrow from future quota (error 131056) | Typing indicator, cleared after 25 s or on reply | none                                               |
| Telegram Bot   | Text 4,096 characters after entities parsing                                     | About 1 message per second per chat                                                                | `sendChatAction`                                 | `sendMessageDraft` (Bot API 9.3+)                  |
| Slack          | `markdown` block 12,000 characters per message; section text 3,000               | About 1 message per second per channel                                                             | `assistant.threads.setStatus`                    | `chat.startStream` / `appendStream` / `stopStream` |
| Matrix         | 65,536 bytes per event (after encryption)                                        | Homeserver `rc_message` (devnet: 3 per second, burst 40)                                           | Typing notifications; `work_status` card         | Edits (`m.replace`), not used                      |
