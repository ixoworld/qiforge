# Work-status card — always-on liveness line

Fixes the `work_status` card disappearing mid-turn, and turns it into a
universal per-turn liveness line that updates continuously from the moment a
Matrix message arrives until the reply is sent.

Spans two repos:

- `ixo-oracles-boilerplate` — `packages/oracle-runtime/`
- `impacts-x-web` — `matrix/components/`

Supersedes the producer/consumer details in `matrix-agent-commerce.md` §3.5
(the card is no longer commerce-gated). The event envelope (§4.1) is unchanged
apart from spec-correct edit semantics.

---

## 1. What's broken today

### Bug 1 — edits omit `m.new_content`, so the anchor's content reads as `{}`

`buildOracleComponentContent` (`packages/oracle-runtime/src/matrix/oracle-component-event.ts:79`)
builds an `m.replace` edit as top-level content plus an `m.relates_to`
relation, and never sets `m.new_content`. That is a Matrix spec violation, and
matrix-js-sdk (41.9.0, `lib/models/event.js:445`) resolves an edited event's
content as:

```js
} else if (this._replacingEvent) {
  return this._replacingEvent.getContent()["m.new_content"] ?? {};
}
```

So the moment the first edit aggregates onto the anchor, `anchor.getContent()`
returns `{}`. Every dispatcher reads `getContent()`:

- `matrix/components/RoomTimeline.tsx:1568`
- `matrix/components/ThreadTimeline.tsx:563`
- `matrix/components/oracle-components/MatrixOracleComponent.tsx:25`

The anchor therefore stops identifying as `work_status`, falls through to the
generic `<Message>` branch, and renders an empty bubble. `WorkStatusCard`'s own
`effectiveContent()` helper handles the missing `m.new_content`, but it is
never reached. Element is broken by the same omission — it shows the original
`body` forever and never applies an update.

### Bug 2 — the UI dedupe counts the edits against their own anchor

`collectStatusEvents` (`WorkStatusCard.tsx:45`) gathers every `work_status`
event in the room and thread timelines **including the `m.replace` edits** —
it filters on event type and `component`, never on relation type.

`effectiveTs(anchor)` (`:39`) returns the _latest edit's_ timestamp, so the
anchor and the newest edit produce identical `ts` entries, and
`pickLatestWorkStatusEventId` (`content.ts:127`) breaks the tie by lexically
greatest event id. Roughly half the time the edit wins, the anchor renders
`null`, and the edit is filtered out of the timeline by the dispatchers —
nothing renders at all.

Bug 1 and Bug 2 are independent. Fixing either one alone still leaves the card
broken on a large fraction of turns.

### Gap 3 — most turns never get a card

`beginTurn` only runs inside `if (this.router.isActive())`
(`matrix-listener-bridge.ts:424`), and the anchor is only actually _posted_ by:

- `routing` — emitted at `message-router.service.ts:244`, which sits **after**
  the sticky/continued-engagement early return (`:202`–`:232`) and after the
  `no-services` return (`:235`–`:239`); or
- `working` — emitted only by `wrapPluginTool` (`graph/wrap-plugin-tool.ts:67`).

Net effect: a support turn with no tool calls gets no card, and a **continued
work engagement gets no card at all unless it happens to call a plugin tool**.

### Gap 4 — nothing updates while the model generates

Only `wrapPluginTool` emits. Meta-tools (`load_capability`,
`list_capabilities`), sub-agent tools and non-plugin tools are invisible, and
once a tool returns, the label stays frozen on that tool's name for the rest of
the turn. There is no beat for "the model is generating".

### Gap 5 — errored turns strand a live spinner

`flush()`'s `catch`, and both early `return`s (`:481`, `:494`), fall through to
`finally`, which calls `endTurn(requestId)` (`:513`) — unregistering the turn
**without posting a terminal phase**. The last card posted (typically
`Working…`) stays in the room spinning forever.

---

## 2. The card contract

One card per user message. One line of text. A spinner while active.

`props.label` is the **entire** line, composed runtime-side. The portal never
assembles text from parts.

The room renders exactly one status card per user message: one anchor event,
and every update an `m.replace` edit of it, so the line is rewritten in place
rather than appended:

```
t=0s    ●  Routing your request…
        ↓  (same event, edited)
t=2s    ●  Step 1 · Thinking…
        ↓
t=5s    ●  Step 2 · Search skills…
        ↓
t=9s    ●  Step 4 · Generate tax report…
        ↓
t=14s   ●  Sending your reply…
        ↓
t=15s   (card removed)
```

The step counter prefixes the action so the line visibly moves even when the
agent loops on the same tool twice in a row. The counter may skip numbers when
frames coalesce (§3.2) — that is intentional and honest.

`phase` stays in `props`: it is what drives hide-on-`done` and the italic
`superseded` variant. It is simply no longer rendered as text.

Opening and closing beats carry no counter — they are transport phases, not
agent steps:

| Phase        | Label                               |
| ------------ | ----------------------------------- |
| `routing`    | `Routing your request…`             |
| `working`    | `Step {n} · {action}`               |
| `delivering` | `Sending your reply…`               |
| `done`       | `Done` (card hidden)                |
| `superseded` | `Got your new message — restarting` |

---

## 3. Runtime changes (`packages/oracle-runtime/`)

### 3.1 Spec-correct edits — `matrix/oracle-component-event.ts`

When `replacesEventId` is set, the built content carries `m.new_content` with
the full envelope (component, props, body, sessionId, requestId, toolCallId)
and **no relation inside it**; the top-level copy stays as the fallback body
for clients that don't apply edits.

```jsonc
{
  "component": "work_status",
  "props": { … },
  "body": "Status: Step 2 · Search skills…",
  "sessionId": "…",
  "requestId": "…",
  "m.new_content": {
    "component": "work_status",
    "props": { … },
    "body": "Status: Step 2 · Search skills…",
    "sessionId": "…",
    "requestId": "…"
  },
  "m.relates_to": { "rel_type": "m.replace", "event_id": "<anchor>" }
}
```

This alone unbreaks `getContent()` for every consumer, including Element.

### 3.2 Step counter + frame coalescing — `matrix/work-status-producer.ts`

`TurnEntry` gains a `step` counter. New method:

```ts
step(requestId: string, action: string): void
```

increments the counter and emits `working` with label `Step {n} · {action}`.

`enqueue` already serializes posts on `entry.queue`. Add coalescing: a frame
arriving while a post is in flight **replaces** the pending frame rather than
queuing behind it. Only the newest pending frame is ever posted.

Why: an 8-tool turn would otherwise emit ~17 Matrix events. With coalescing the
card updates as fast as the homeserver accepts and never floods it. Because the
newest frame always wins, `finish`'s terminal phase can never be dropped.

Coalescing only ever collapses frames _waiting behind_ the in-flight post, so
the anchor — which is always the first post of a turn — is never dropped, and
the `!entry.anchorEventId && !ANCHOR_PHASES.has(phase)` guard keeps its
existing meaning. If the anchor post fails, the next `working` frame creates
the anchor instead, as today.

`emit`, `finish`, `endTurn` and the anchor rules are otherwise unchanged.

### 3.3 Universal card — `modules/messages/matrix-listener-bridge.ts`

- `beginTurn` + `emit(requestId, 'routing')` move **out** of the
  `router.isActive()` branch and run on every flush, before routing. Every
  Matrix turn on every oracle gets a card, whether or not `oracle-payments` is
  loaded.
- `finally` always calls `finish(requestId, 'done')` unless the turn was
  superseded (`abortController.signal.aborted`), replacing the bare
  `endTurn(requestId)` at `:513`. Error paths and no-reply paths now clear the
  card instead of stranding a spinner.
- The existing `emit(requestId, 'delivering')` before the reply send is
  unchanged.

`message-router.service.ts:244`'s `routing` emit is **removed** — the bridge
owns the opening beat now, and the router's emit sat behind two early returns.
`MessageRouterDeps.producer` and the `Pick<WorkStatusProducer, 'emit'>` field
go with it.

### 3.4 New always-on middleware — `graph/middlewares/work-status-middleware.ts`

```ts
wrapModelCall:  step(requestId, 'Thinking…')      → handler(request)
wrapToolCall:   step(requestId, humanizeToolLabel(name)) → handler(request)
```

`requestId` comes from `request.runtime.context.session.requestId` — verified
present on both `ModelRequest` (langchain 1.4.2,
`dist/agents/nodes/types.d.ts:94`) and `ToolCallRequest`
(`dist/agents/middleware/types.d.ts:104`), and the same value
`buildRuntimeContext` reads off `RunConfigContext.session`. Emissions for an unregistered `requestId` (HTTP
turns) are already no-ops in the producer.

The middleware returns `handler(request)` verbatim and never returns a state
channel — it is a pure side effect, so it cannot break checkpointer thread
continuity.

Registered in `graph/middlewares/index.ts` alongside the other always-on
middlewares.

### 3.5 Remove the narrower emitter — `graph/wrap-plugin-tool.ts`

The `producer.emit(…, 'working', …)` call at `:67` and the
`WrapPluginToolOptions.producer` option are deleted. The middleware supersedes
them and additionally covers meta-tools, sub-agent tools and any non-plugin
tool.

`humanizeToolLabel` stays in `work-status-producer.ts`; its consumer moves.

---

## 4. Portal changes (`impacts-x-web`)

### 4.1 `matrix/components/oracle-components/WorkStatusCard.tsx`

- `collectStatusEvents` skips events whose
  `getRelation()?.rel_type === "m.replace"`. This removes the anchor-vs-edit
  timestamp tie that nulls the card.
- Render is spinner + `props.label`, one line. The `PHASE_LABEL` map (`:12`)
  and the uppercase eyebrow `<Text>` (`:122`–`:126`) are deleted; the `<Stack>`
  collapses to a single `<Text>`.
- `phase === "done"` → `null` and the italic `superseded` variant are unchanged.

### 4.2 Shared content resolution

`effectiveContent()` and `effectiveTs()` move from `WorkStatusCard.tsx` into
`content.ts` (they are already React-free), and `effectiveContent()` replaces
the bare `mEvent.getContent()` in:

- `RoomTimeline.tsx:1568`
- `ThreadTimeline.tsx:563`
- `MatrixOracleComponent.tsx:25`

Belt-and-braces once §3.1 lands, and it repairs cards already sitting in room
history that were posted with the old, spec-invalid edits.

### 4.3 Dead space

`RoomTimeline.tsx:1573` and `ThreadTimeline.tsx:566` wrap the card in
`<Box px={16} py={2}>`, which leaves 4px of padding per hidden (`done`) card.

The wrapper keeps its padding — it also carries `data-message-item` and
`data-message-id`, which back `getItemElement` (`RoomTimeline.tsx:573`) and the
edit-scroll lookup (`:925`). Instead the dispatcher returns `null` outright when
the effective `props.phase` is `done`, so a finished turn leaves no DOM at all
rather than a zero-height div. Returning `null` from a renderer is already the
established pattern there — the `m.replace` branch above it does exactly that.

`WorkStatusCard` stays padding-free and keeps its own `done` → `null` guard,
which still matters on the late-decrypt path (`RoomTimeline.tsx:1403`,
`ThreadTimeline.tsx:807`): that path renders the card inside `<Message>` chrome
and never reaches the dispatcher branch. Moving the padding into the card
instead would double-inset it there.

### 4.4 Live edits must re-render the card

Found after §4.1–§4.3 shipped: the card rendered the correct first phase and
then froze, catching up only when the thread was closed and reopened.

A Matrix edit is not a renderable timeline event. `RelationsContainer` calls
`targetEvent.makeReplaced(edit)`, which mutates the anchor **in place** and
emits `MatrixEventEvent.Replaced` on the event object
(`matrix-js-sdk/lib/models/event.js:1273`–`1289`). Nothing is appended to the
timeline, the anchor does not move, and the edit itself is filtered out of
rendering — so none of the timeline's re-render triggers fire.

Two defects compounded, each sufficient on its own:

1. **Nothing subscribed to `Replaced`.** React had no reason to re-render, so
   the card kept painting its mount-time content until something forced a
   remount.
2. **The memos would have returned stale content anyway.** `props` was
   `useMemo(..., [mEvent])` and `isNewest` was `useMemo(..., [room, mEvent,
forEventId])`. Because `makeReplaced` mutates in place, `mEvent` keeps one
   object identity for the whole turn, so neither dependency array ever
   changed.

The fix subscribes to `MatrixEventEvent.Replaced` on `mEvent` and bumps a
counter, mirroring the `MatrixEventEvent.Decrypted` precedent in
`Message/EncryptedContent.tsx`, and drops both memos so each render re-derives
from the event. Dropping them is safe precisely because §4.3 makes the
dispatcher skip finished cards before they mount, so at most one card per room
does this work.

`WorkStatusCard`'s `room` prop narrows from the `Room` class to a structural
`StatusTimelineRoom` (`getLiveTimeline` / `getThread`) — the same move
`content.ts` made with `ResolvableEvent`, and what lets the component test
supply a timeline stub without a cast. A real `Room` satisfies it.

Covered by `__tests__/components/workStatusCard.test.tsx`, which drives real
`MatrixEvent` objects through `makeReplaced` so the assertions exercise the
SDK's actual edit mechanics rather than a mock of them.

---

## 5. Testing

**Runtime**

| File                             | Adds                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `oracle-component-event.test.ts` | edit carries `m.new_content` equal to the envelope, with no relation nested inside it                                     |
| `work-status-producer.test.ts`   | step counter increments and formats; frames coalesce under a slow post; terminal phase always lands                       |
| `matrix-listener-bridge.test.ts` | anchor posted on every flush with the router inactive; `done` posted on the error and no-reply paths                      |
| `work-status-middleware.test.ts` | `Thinking…` on a model call and the humanized tool label on a tool call, over `fakeModel`; unknown `requestId` is a no-op |
| `message-router.service.test.ts` | producer dependency removed                                                                                               |
| `wrap-plugin-tool.test.ts`       | producer assertions removed                                                                                               |

**Portal**

| File                                                   | Adds                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `__tests__/unit/matrix/oracleComponentContent.test.ts` | dedupe ignores `m.replace` entries; `effectiveContent` prefers `m.new_content` and falls back to top-level |

---

## 6. Compatibility

Additive on the wire — `m.new_content` is a new field on events that already
exist. Old cards in room history keep rendering through `effectiveContent`'s
`?? rc` fallback. No config, no migration, no new env var.

The one behavioural change beyond bug fixes: **every** Matrix turn now posts a
status card, including on oracles without `oracle-payments`. That is one extra
Matrix event per turn (plus coalesced edits), scoped to the Matrix transport —
HTTP and WS turns are unaffected, since emissions for unregistered request ids
remain no-ops.
