# Matrix-Primary Chat — Spec

**Status:** Draft for review · **Date:** 2026-07-06
**Supersedes:** `matrix-chat-parity.md` and `matrix-chat-parity-plan.md` (both archived — they assumed HTTP stays primary and "no tool events in Matrix", which is the opposite of this plan).

---

## The thesis

Make **Matrix the primary chat surface**. A user types in a Matrix room (Element, mobile, or the portal's Matrix view) and gets the full oracle experience. HTTP stays exactly as it is — a legacy/programmatic transport — but the product centre of gravity moves to Matrix.

**Why this is tractable (the one insight):** the chat is _already_ Matrix underneath.

- `sessionId` **is** a Matrix event id **and** the LangGraph checkpointer `thread_id` — same string, three roles (`session-manager.service.ts:410`, `request-preparer.ts:108`).
- Checkpointer state already syncs to Matrix media (per-user SQLite → gzipped `.db`).
- Auth/delegation already lives in Matrix room state (`ixo.room.state` / `ucan_delegation`).
- Attachments are already Matrix mxc uploads.

So this is **not an engine rewrite**. It's moving the _ingress_ and the _rendering_ onto Matrix, plus one new tracking event. The agent, checkpointer, credits, and sessions don't move.

---

## Ground rules (decided)

| Rule                                                         | Consequence                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep all HTTP endpoints as-is**                            | `/messages`, `/sessions`, `/delegation`, `/user-preferences`, `/health` untouched. Portal keeps them as a fallback.                       |
| **Keep `BatchInvoker` for Matrix turns**                     | It runs the full graph (`batch-invoker.ts:56`), so `ctx.emit`, browser tools, and credits all already fire. No streaming-runner refactor. |
| **WS is used for ONE thing: the live browser/AG round-trip** | The only thing that _physically_ needs a live client. No streaming, no reasoning, no tool-status over WS.                                 |
| **Auth = FE calls `/delegation` before chatting**            | Runtime already reads the stored delegation per turn. No new enforcement plumbing.                                                        |
| **Every tool call is persisted as a Matrix event** (new)     | One generic `ixo.oracle.tool` interceptor. This _replaces_ WS tool-visibility.                                                            |
| **Streaming is NOT migrated**                                | Token-by-token stays HTTP/SSE-only. Matrix gets the final reply; "typing…" is the liveness signal.                                        |

---

## The two channels

Everything sorts into exactly one:

| Channel                             | Carries                                                                                            | Notes                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Matrix timeline (durable)**       | user message · final reply · **tool-call tracking** · **UI components** · errors · session anchors | Source of truth. Renders on any client. Survives reload. E2EE.                                      |
| **WS side-channel (live, minimal)** | **browser-tool** round-trip · **AG-UI action** round-trip                                          | Only when the portal is open. The one thing Matrix can't do (needs the live browser). Nothing else. |

---

# Part 1 — Features, one by one

Format for each: **Today (HTTP)** → **Matrix home** → **Build** → **Plugins touched**.
Effort legend: 🟢 small · 🟡 medium · 🔴 large.

---

## F1 · Send a message 🟡

- **Today:** `POST /messages/:sessionId` with a `SendMessageDto` body.
- **Matrix home:** the user's own client posts `m.room.message` natively. The `MatrixListenerBridge` is the single ingress (`matrix-listener-bridge.ts`). The portal composer sends via `matrix-js-sdk` (it already has it — Cinny fork).
- **Build:** portal composer → native send + per-turn context keys (see F17). Bridge hardening (F11).
- **Plugins:** none directly; unlocks all.

## F2 · Receive the reply 🟢

- **Today:** SSE `message` frames + final bubble; portal renders live.
- **Matrix home:** the oracle posts the final `m.text` to the room (already happens). Native Matrix sync delivers it to every client in real time — **this is the "streaming" for the timeline; no extra infra.**
- **Build:** reply-placement fix (F4). Nothing else.
- **Plugins:** none.

## F3 · Message history 🟢

- **Today:** `GET /messages/:sessionId` reads the checkpointer.
- **Matrix home:** the Matrix room timeline **is** the history (durable, on every device). `GET /messages` stays available for programmatic use.
- **Build:** portal reads the timeline (already does, as a Cinny fork). No backend change.
- **Plugins:** none.

## F4 · Sessions & the `sessionId ↔ threadId` problem 🟡 ← the big UX fix

**The problem.** `sessionId` = the thread-root Matrix event id, and the reply is **always** sent threaded (`threadId = sessionId`, `rel_type: 'm.thread'`, unconditional at `matrix-listener-bridge.ts:346`). That single identity playing two roles causes three bugs:

1. **Every reply is buried in a thread panel.** You type in the main timeline; the bot answers inside a thread you must click open.
2. **A bare message = a new session = amnesia.** A message with no reply is its own thread-root → new `sessionId` → new checkpointer thread → the bot forgets everything (`getThreadRoot`, `bridge.ts:374`). Every plain Element message is a cold start.
3. **Portal vs Element split-brain.** Portal always threads (clean sessions); Element never threads (junk sessions + amnesia).

**The fix — decouple "checkpointer thread" from "reply placement":**

- **DM room = one rolling "room-default" session** via `setRoomSessionResolver` (the tasks plugin already proves this pattern — `tasks.module.ts:123`). Continuous memory, no cold starts.
- **Reply placement:** for a room-default session, reply in the **main timeline** (omit `threadId`); only reply threaded when the user explicitly opened a thread.
- **`sessionId` stays a real Matrix event id** — it just stops dictating placement and stops multiplying.

**Collision to resolve:** the bridge holds `setRoomSessionResolver` as a **single global slot** (`matrix-listener-bridge.ts:84`), and **tasks already owns it**. → Change the bridge to a **resolver chain** (first non-`undefined` wins): task-room resolver → room-default resolver.

- **Session create/list/delete:** keep the `/sessions` endpoints. "New conversation" in the portal = post a fresh anchor (today's `createSession`). List = threads in the room. Delete = memory-extract + hide (Matrix history isn't truly deletable; redact the anchor if needed).
- **Plugins:** tasks (resolver chain), matrix-group-chats (unaffected — group rooms stay thread/mention-gated, see F19).

## F5 · Injecting room messages into the chat 🟡

**The gap.** The checkpointer only has messages from turns the oracle _processed in that session_. It's blind to pre-existing room history, anything said while the oracle was down, other threads, and other people's messages (group rooms).

**Already built, not wired:**

- `MatrixManager.getRecentRoomMessages(roomId, {limit})` (`matrix-manager.ts:691`) — fetches + decrypts the last N messages.
- `ChannelMemoryService.buildSessionContext(roomId)` (`channel-memory.service.ts:640`) — roster + recent messages + pinned facts into a prompt block. **It has no caller inside the runtime** (only `apps/app` legacy calls it).

**Build:** wire `buildSessionContext` into the **prompt composer** as a system-prompt context block.

- **Prompt-side ONLY — never return it as `messages` from a middleware.** That mutates the checkpointer thread and breaks continuity (binding rule: `feedback_no_state_mutations_from_middlewares`; the "new thread per message" symptom came from exactly this).
- **When:** first turn of a room-default session (seed history) + group-room turns with a new speaker. After that, F4's room=session means the checkpointer carries it forward.

F4 gives memory going forward; F5 seeds the history the checkpointer doesn't have yet. They're complements.

- **Plugins:** matrix-group-chats (owns `buildSessionContext`).

## F6 · Tool-call tracking → Matrix events 🟡 ← your new requirement

**Requirement:** every tool call (name, input, output) is persisted as a Matrix event, for tracking.

**Design — one generic interceptor, not per-plugin.** Tool names are **not statically enumerable**: portal (FE-declared), agui (client agActions), composio (remote registry), memory/sandbox (upstream MCP) all generate names at call time. So this must live at the **tool-wrapping layer** (where `createMainAgent` wraps every `PluginTool`), capturing the name/args/output at execution time:

```jsonc
{
  "type": "ixo.oracle.tool",
  "content": {
    "name": "search_skills",
    "input": {
      /* args */
    },
    "output": "…", // truncated at 32 KiB; larger → mediaRef via matrix-upload-utils
    "status": "done", // done | error
    "sessionId": "…",
    "requestId": "…",
    "m.relates_to": { "rel_type": "m.thread", "event_id": "<sessionId>" },
  },
}
```

- **One terminal event per completed tool call** — **DECIDED** (matches "name + input + output" and keeps the timeline an accurate, ordered record). The "running" signal is the typing indicator — no mid-turn spam.
- **This replaces WS tool-visibility.** The portal renders the tool-process strip from these timeline events; Element shows a small text fallback (or ignores them). No WS needed for visibility.
- **Absorb the existing loggers:** portal and agui already write `ixo.action.log` per tool (`portal.plugin.ts:93`, `agui.plugin.ts:96`). Fold both into this one interceptor so nothing double-logs.
- **Size:** sandbox `sandbox_run` output and `artifact_*` payloads can be huge (>64 KiB Matrix cap). Truncate at 32 KiB; offload the full value via `matrix-upload-utils` (`mediaRef`). Reuse — don't roll new upload code.
- **Off-request coverage:** scheduled **task** runs suppress Matrix replay (`invoker.ts:73`), so their internal tool calls are invisible today. The interceptor must also wire into the off-request `AgentInvoker` path, not just live chat.

- **Plugins:** all (generic). Reconcile: portal, agui (remove their bespoke `ixo.action.log`).

## F7 · UI components in chat (charts, tables, cards) 🟡

- **Today:** `render_component` is plumbed (`scoped-emitter.ts:36`) but has **zero producers**; the FE renders components keyed by tool name from history (`transformToMessagesMap`). Only agui/editor/portal produce anything visual.
- **Matrix home:** a durable **`ixo.oracle.component`** timeline event `{ componentName, props }` with a text `body` fallback.
- **Build:**
  1. **Producer (post-turn, no streaming):** after `agent.invoke`, inspect final state for tools flagged `uiComponent: '<componentName>'` in their manifest (maps cleanly — FE already keys off tool name) + any explicit `ctx.emit.renderComponent`. Post the event.
  2. **Renderer (portal):** one `useMatrixEventRenderer` entry dispatching through the **existing `uiComponents` registry** (extract it from `SidebarAiChatMessages.tsx:50` into a shared module so HTTP + Matrix can't drift).
- **Note:** most plugins render nothing (tasks/skills/sandbox/etc. deliver plain markdown). This is mainly agui charts/tables + any manifest-flagged tool.
- **Plugins:** agui, editor (already CRDT-rendered), any that opt in via manifest.

## F8 · Browser tools (portal) 🟡 ← needs the minimal WS

- **Today:** dynamic tools from `state.browserTools` (HTTP body); `callBrowserTool` does a WS round-trip to the browser (15s timeout, `portal.plugin.ts:84`).
- **Why it breaks natively:** a Matrix message carries no `tools`, and the Matrix user never did the HTTP handshake that opens the browser socket → `getRequestTools` returns `[]` and calls would 15s-timeout.
- **Matrix home:** **the one WS use.** `callBrowserTool` already fires under `BatchInvoker` (verified) — it just needs (a) the tools registered and (b) a live socket subscribed to the session.
- **Build (F18/F19 plumbing):** WS `subscribe_session` (a socket can follow a session it didn't handshake) + `register_capabilities { browserTools }`. Portal opens a minimal background socket per oracle room → subscribe → register. Nothing else on the socket.
- **Plugins:** portal.

## F9 · AG-UI actions (agui) 🟡

- **Today:** per-request sub-agent built from `state.agActions`; each action = a WS `action_call` round-trip (15s, `agui.plugin.ts:88`).
- **Matrix home:** identical to F8 — `register_capabilities { agActions }` + the same minimal socket.
- **Build:** shares F8's WS plumbing; the agui sub-agent builds from the registered agActions instead of the HTTP body.
- **Plugins:** agui.

## F10 · Errors 🟢

- **Today:** SSE `error` event.
- **Today on Matrix:** **swallowed** — `flush()`'s catch only logs (`matrix-listener-bridge.ts:353`); the user sees nothing.
- **Matrix home:** durable **`ixo.oracle.error`** event (`m.notice` + `{ code, requestId }`); portal renders it via the existing `OracleError` component. Never leak internal strings — coarse codes.
- **Plugins:** none (bridge-level).

## F11 · "Don't silently break" bundle 🟡

Not about streaming — about the Matrix chat not dying/double-answering/freezing. Keeps `BatchInvoker`.

| Item                                 | Why                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Visible errors** (F10)             | Biggest "feels broken" fix.                                                                         |
| **Typing keepalive** (~20 s refresh) | Matrix typing expires ~30 s; long turns show "not typing".                                          |
| **Event-id dedup**                   | Homeserver resync/restart re-delivers events → double answers today.                                |
| **Per-session queue**                | **Prereq for F4** — one room = one thread means two fast messages would corrupt checkpointer state. |
| **Replay age-guard**                 | Don't necro-reply to ancient history after a token reset.                                           |
| **`matrixManager.init()` retry**     | Boot resilience.                                                                                    |

- **Plugins:** none (bridge-level).

## F12 · Reasoning / "thinking" ⚪ not migrated

- SSE `reasoning`. **Not** moved to Matrix (WS-minimal, "streaming left"). The typing indicator is the liveness signal. Available on the HTTP path unchanged.

## F13 · Token streaming ⚪ left as-is

- Stays HTTP/SSE-only. Matrix gets the durable final reply via native sync. Explicitly out of scope per your call.

## F14 · Attachments 🟢

- **Today:** mxc/eventId in the DTO; already Matrix-backed.
- **Matrix home:** native `m.image` / `m.file` sends — the bridge already handles `FILE_MSGTYPES` (`matrix-listener-bridge.ts:15`). **Free with native send.**
- **Plugins:** none.

## F15 · Auth / delegation 🟢

- **Today:** `AuthHeaderMiddleware` (UCAN invocation → delegation fallback). Matrix turns: delegation read advisorily from room state, never blocking (`agent-builder.ts:209`).
- **Matrix home:** **FE calls `GET /delegation` before enabling chat**; authorize via the existing modal (`ixo.oracle.delegation_required` → `useAuthorizeOracleForMatrix`) if missing. Runtime already reads the stored delegation per turn and mints downstream invocations from it.
- **Why it matters beyond auth:** memory, sandbox, composio, skills mint per-request UCAN invocations from that delegation. **With no stored delegation they silently contribute zero tools** (`memory-tools.ts:114`, `sandbox.plugin.ts:257`). Gating chat on `/delegation` is what makes those plugins work over Matrix.
- **Optional hardening (later):** `MATRIX_TRUSTED_HOMESERVERS` allowlist to close cross-federation localpart spoofing. Not required for v1.
- **Plugins:** memory, sandbox, composio, skills (all unblocked by this).

## F16 · Credits / 402 & rate limiting 🟢

- **Credits:** two layers, both easy on Matrix.
  - Hot-path enforcement (`TokenLimiter`) already runs as a **graph middleware** (`credits-middleware.ts`) → applies to Matrix turns automatically (`BatchInvoker` runs the full graph). Nothing to do.
  - The pre-graph 402 gate (`SubscriptionMiddleware`) is Express-only. Fix = **extract the subscription check into a service and call it in the bridge's on-message handler (`flush()`) before invoking**; on failure post an in-room notice + payment link and skip the turn. Same code path for HTTP and Matrix. Straightforward — not a refactor.
- **Rate limit:** `ThrottlerGuard` is HTTP-only. Add a **per-DID limiter in the bridge** (`MATRIX_TURNS_PER_MINUTE`), react with ⚠️ on limit.
- **Plugins:** credits.

## F17 · Per-turn context (metadata) 🟡

The DTO carries `metadata.{editorRoomId, spaceId, currentEntityDid}`, `timezone`, `mcpInvocations`. A native Matrix event carries none → **editor and flows contribute zero tools today under native Matrix** (`editor.plugin.ts:154`, `flow-doc.ts:42`).

Split by nature:

| Field                                 | Source under Matrix                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone`, `currentEntityDid`        | content keys on the sent event (`ixo.oracle.turn_context`), or user-preferences                                                                                                                                                                                                                                |
| `editorRoomId`, `spaceId`             | **derive from the originating Matrix room** — the chat room _is_ the editor room, `spaceId` from its `m.space.parent`. A room→state resolver, not the HTTP body.                                                                                                                                               |
| `mcpInvocations` (protected MCP CARs) | **nothing — the field is dead** (declared `send-message.dto.ts:243`, zero consumers). Protected MCP tools are authorized by the runtime **minting invocations server-side from the stored delegation** (`createInvocationFromDelegation`). A Matrix turn needs nothing extra once F15's `/delegation` is done. |
| `browserTools`, `agActions`           | **WS `register_capabilities`** (live functions, not data — F8/F9)                                                                                                                                                                                                                                              |

- **Plugins:** editor, flows (both need `editorRoomId` derived from the room).

## F18 · Capabilities registration (WS) 🟡

- **New WS messages:** `subscribe_session { sessionId }` / `unsubscribe_session`, and `register_capabilities { sessionId, browserTools, agActions }`. Lift the one-socket-one-session limit (`ws.gateway.ts:51`). Reuse the existing handshake UCAN check for ownership.
- `RequestPreparer` merges the live registry into Matrix turns. `callFrontendTool`'s 15s timeout already exists.
- **Plugins:** portal, agui.

## F19 · Group rooms 🟡 ← **DECIDED**

Rules for a group room (do NOT apply F4's room=session here):

1. **Mention is the 100% hard gate to _enter_.** In a group room the oracle answers a _fresh_ line **only** when explicitly mentioned. No mention → silent (`jumpTo:'end'`). Non-negotiable.
2. **Once engaged in a thread, it continues without re-mention.** A message inside an active bot thread is answered (thread continuation). Replies land **in that thread**.
3. **Push toward threads.** The bot replies in-thread and its prompt guidance nudges users to keep a topic in its thread — keeps group rooms tidy and sessions clean.
4. **But handle messy users who don't thread.** A user who _replies to the bot's message_ in the main timeline (no thread) is still answered — reply-chain resolution catches it (`isReplyToBotMessage`), and **F5 room-context injection** gives the bot continuity so a non-threaded back-and-forth doesn't lose the plot. A messy user who just types in the main timeline with **no mention and no reply-to-bot** is still ignored (rule 1 holds).

**This maps onto the existing guard** — `shouldAgentRespond` already precedence-orders: mention → reply-to-bot → active-thread → cold-cache "has bot spoken in thread" (`guard.ts:191`). The work is (a) keep mention as the sole _entry_ trigger, (b) ensure reply-to-bot works without a thread for messy users, (c) reply threaded + prompt nudge toward threads.

- **Requirement:** the bridge must populate each `HumanMessage.additional_kwargs` with `eventId`, `threadId`, `senderDid`, `senderMatrixUserId`, `senderDisplayName`, or the gate passes-through / mis-attributes (`middleware.ts:80`).
- **Plugins:** matrix-group-chats.

---

# Part 2 — Per-plugin impact (all 15 + stubs)

Status: 🟢 works as-is over Matrix · 🟡 needs rework · 🔴 breaks hard.

| Plugin                     | Status          | What it needs for Matrix-primary                                                                                                                                                                                                                                               |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **portal** (browser tools) | 🔴              | Tools come from HTTP body + need a live browser socket. → F8/F18 (`register_capabilities` + subscribe). Fold its `ixo.action.log` into F6.                                                                                                                                     |
| **agui** (AG-UI actions)   | 🔴              | Same as portal: agActions from body + live `action_call` round-trip. → F9/F18. Fold `ixo.action.log` into F6.                                                                                                                                                                  |
| **editor** (pages/blocks)  | 🟡              | `editorRoomId`/`spaceId` only arrive via HTTP body → 0 tools natively. Derive from the originating room (F17). All Matrix/CRDT plumbing already works.                                                                                                                         |
| **flows** (flow templates) | 🟡              | Flow room defaults to `metadata.editorRoomId` → `no_flow_ref` natively. Derive flow room from chat context (F17).                                                                                                                                                              |
| **memory**                 | 🟡              | Needs per-request UCAN → 0 tools without a delegation. Unblocked by F15 (FE calls `/delegation`).                                                                                                                                                                              |
| **sandbox** (exec env)     | 🟡              | UCAN-authed (F15). Large `sandbox_run`/`artifact_*` outputs → F6 truncation + `mediaRef`. No Matrix coupling otherwise.                                                                                                                                                        |
| **tasks**                  | 🟡              | Owns `setRoomSessionResolver` (single slot) → resolver chain (F4). Scheduled runs suppress replay → wire F6 into `AgentInvoker`. Preserve `requestId` stability across debounced Matrix turns.                                                                                 |
| **matrix-group-chats**     | 🟡              | Already Matrix-native. Needs bridge to populate `additional_kwargs` (F19) + `buildSessionContext` wired (F5).                                                                                                                                                                  |
| **user-preferences**       | 🟢              | Already Matrix room state (`user_prefs`). Requires `roomId` (fine on Matrix). Keep `GET /user-preferences`.                                                                                                                                                                    |
| **credits**                | 🟢              | Graph middleware already applies to Matrix turns. Add visible notice + per-DID limit (F16).                                                                                                                                                                                    |
| **composio**               | 🟢              | Transport-agnostic; needs `user.did` + UCAN (F15). Dynamic tool names → F6 captures at call time.                                                                                                                                                                              |
| **skills**                 | 🟢              | `list_skills` / `search_skills`, small I/O. UCAN optional. Nothing to change.                                                                                                                                                                                                  |
| **domain-indexer**         | 🟢              | Static 2 tools, pure server-side. Safe.                                                                                                                                                                                                                                        |
| **firecrawl**              | 🟢              | Sub-agent + 2 MCP tools, server-side. Safe.                                                                                                                                                                                                                                    |
| **slack**                  | ⚠️ out of scope | **Parallel non-Matrix transport** (`slackThreadTs`→session, no `roomId`, hardcoded DID at `slack.service.ts:172`). Slack turns never touch Matrix → their tool calls can't produce `ixo.oracle.tool` events. Flag as a known v1 limitation; don't try to Matrix-ify Slack now. |
| **calls** (stub)           | —               | Not implemented. Ignore.                                                                                                                                                                                                                                                       |

---

# Part 3 — New Matrix event types (the whole protocol addition)

| Event                     | Kind                            | Purpose                                                | Fallback for Element |
| ------------------------- | ------------------------------- | ------------------------------------------------------ | -------------------- |
| `ixo.oracle.tool`         | timeline                        | Tool-call tracking (name/input/output/status) — F6     | short text line      |
| `ixo.oracle.component`    | timeline                        | UI component (componentName + props) — F7              | `body` text summary  |
| `ixo.oracle.error`        | timeline (`m.notice`)           | User-safe error (code + requestId) — F10               | the notice text      |
| `ixo.oracle.turn_context` | content keys on the user's send | timezone / entity context — F17                        | invisible            |
| `ixo.oracle.room`         | **state**                       | Discovery: oracle DID + `apiUrl` for the FE's WS — F18 | n/a                  |

Existing events we reuse untouched: `ixo.oracle.delegation_required`, `ixo.room.state`/`ucan_delegation`, `m.ixo.media_*` (checkpointer), `FILE_MSGTYPES` (attachments).

---

# Part 4 — Build order

**Backend**

1. **F11** don't-break bundle (errors, typing keepalive, dedup, per-session queue, age-guard, init retry). _Prereq for everything._
2. **F4** resolver chain + room=session for DMs + reply-placement fix.
3. **F5** wire `buildSessionContext` into the prompt composer (first turn / group rooms).
4. **F6** generic `ixo.oracle.tool` interceptor (+ absorb `ixo.action.log`, + size offload, + off-request task path).
5. **F7** post-turn `ixo.oracle.component` producer + manifest `uiComponent` flag.
6. **F17** derive `editorRoomId`/`spaceId` from the room (unblocks editor + flows).
7. **F18** WS `subscribe_session` + `register_capabilities`; `RequestPreparer` merge.
8. **F16** per-DID rate limit + credit-exhausted notice.

**Frontend (portal)** 9. Extract shared `uiComponents` registry; add `useMatrixEventRenderer` entries for `ixo.oracle.tool` / `.component` / `.error`. 10. Composer → native Matrix send + `ixo.oracle.turn_context`. 11. Gate chat on `GET /delegation` (F15). 12. Minimal background socket per oracle room: connect → `subscribe_session` → `register_capabilities` (F8/F9). Nothing else on it.

**Docs + tests:** "Chat over Matrix" page + integration tests (send-in-room → durable events + reply; delegation-missing; credit-exhausted).

---

# Part 5 — Open decisions

**Decided:**

- ✅ **Tool-tracking granularity (F6):** one event **per tool call** — keeps the timeline an accurate record.
- ✅ **Group rooms (F19):** 100% mention-gated to enter; thread continuation without re-mention; push toward threads but handle non-threading "messy" users via reply-to-bot + F5 context. NOT room=session.

**Resolved this session:**

- ✅ **Credits (F16):** graph middleware already covers the hot path; add the pre-graph subscription check to the bridge's `flush()` (extract to a shared service) + in-room notice. Easy, not a refactor.
- ✅ **`mcpInvocations` (F17):** dead field, dropped. Protected MCP tools are authorized by server-side minting from the stored delegation — nothing extra on Matrix.

**Still open:**

1. **Slack:** confirm out-of-scope for v1 (it can't produce Matrix tool events).
