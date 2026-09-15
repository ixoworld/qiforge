# Transcript paging

**Status:** built Sep 14 2026 (runtime, client SDK, Portal), uncommitted.

## Why

The Portal loaded a session's whole transcript on open and again after every
turn, then kept only the last 100 messages in memory, and re-rendered every
message on every streamed chunk. A two-page reply in a 120-message session
was 2,000 chunks × 60 markdown renders: the tab froze. Three changes, each
useful on its own:

1. **Paging** — the transcript is read one turn-aligned page at a time.
2. **Coalesced streaming** — the SDK notifies React at most every 50 ms.
3. **Memoised, virtualised rows** — a chunk re-renders one turn; the DOM
   holds only the turns near the viewport, however far back the reader goes.

## Runtime

`GET /sessions/:sessionId/messages?limit=20&before=<cursor>&after=<cursor>`
(`packages/oracle-runtime-workers/src/do/transcript.ts`, the shell route in
`src/shell/app.ts`, `SqliteSaver.listThreadMessageRows` /
`findThreadMessageAnchor`). The legacy `GET /messages/:id` is unchanged.

- A **turn** is a user message with everything the agent did until the next
  one. Pages align to turns, so a tool result is never separated from the
  reply that called it (the transcript folds tool rows into their reply's
  DTO, which only works inside one page).
- No cursor → the newest `limit` turns. `before=` → the `limit` turns older
  than the cursor. `after=` → what follows the cursor, oldest first: the turn
  the cursor sits in, re-sent whole from its start when the cursor split it
  (a reply and its tool results land row by row), then up to `limit` newer
  turns. A client folds an `after` page in by message id.
- A **cursor** is the message id of a boundary row (opaque to clients).
  Rowids move when a checkpoint rewrites the thread's rows; message ids do
  not, so the cursor is resolved to its `(created_at, rowid)` position at
  query time. An unknown cursor is a 400; an unknown session is an empty
  page (a 404 from this route means the runtime does not page).
- Response: `{ messages, prevCursor, nextCursor, hasOlder, hasNewer }`.
  `limit` is 1–100 (default 20).
- Cost: one indexed range read per 80 rows, plus one row lookup per cursor.
  The summarizer's bookkeeping row is skipped and never a turn boundary.

## Client SDK (`@ixo/oracles-client-sdk`)

`useChat` loads the history as an infinite query
(`src/utils/transcript-pages.ts`, `src/hooks/use-chat/v2/use-chat.ts`):

- The newest page first; `loadEarlier()` fetches the page before the oldest
  loaded one (`hasEarlier`, `isLoadingEarlier`). `historyPageSize` (default 20) sets the page.
- **Invariant: `pages[0]` is the newest page** (`history-query.ts`); older
  pages are appended with TanStack's `fetchNextPage`, never prepended with
  `fetchPreviousPage`. TanStack refetches an infinite query from
  `pageParams[0]` and walks the rest with `getNextPageParam`, so a remount
  refetch (leave the page, come back) starts at the newest turns again and
  re-walks the older pages that were loaded. With the newest page last, the
  refetch started at the oldest loaded `before=` cursor and stopped there:
  the session came back showing only old turns until a reload.
  `flattenPages` reverses the pages into an oldest-first transcript;
  `appendTail` folds an `after=` page into `pages[0]`.
- After a turn, or a cache invalidation from the socket, only what came
  after the newest loaded row is fetched (`after=`) and folded into the
  newest page — never the whole transcript again.
- **Backwards compatible both ways.** Against a runtime without the paged
  route (Node, older Workers builds) the 404 falls back to the legacy whole
  transcript as one page, and refreshes refetch it whole. Old SDKs keep using
  the legacy route. The hook's existing fields are unchanged; the three
  paging fields are additions.
- The chat store no longer caps itself at 100 messages: it holds exactly
  the loaded pages. While a reply streams, the turn in flight stays on top of
  whatever history arrives (`mergeHistory`); idle, the runtime's copy of a
  turn replaces the streamed one.
- **Streamed reasoning is its own message** (`reasoning-message.ts`, id
  `<requestId>-reasoning`). It used to be filed under the answer's id, which
  flagged the answer `isReasoning` as soon as a reasoning frame arrived; the
  UI hides reasoning-only messages, so a model that thinks before it speaks
  (the ChatGPT lane streams its summary first) showed nothing until the
  finished turn came back from the transcript — "the whole reply jumped in
  at once". The transcript DTO still carries `reasoning` on the answer, so
  the reopened session looks as before.
- `streamingMode: 'throttled'` (+ `streamingThrottleMs`, default 50):
  the first chunk renders at once, later chunks inside the window fold into
  one trailing render; status, error, run and tool changes always render at
  once. `immediate` stays the default, so existing clients see no change.

## Portal

`components/Pages/Workspace/HomeChat/HomeChatConversation.tsx` (+
`HomeChatTurnRows.tsx`, `turnActivity.ts`):

- `reuseTurns` keeps a turn object's identity unless one of its messages
  changed; `HumanTurnRow` / `AiTurnRow` are memoised on it, so a chunk
  re-renders the streaming turn only. Props to the rows are stable across
  chunks by construction.
- The list is a TanStack virtualizer over turns (already a Portal
  dependency): rows measure themselves; a row above the viewport that
  measures differently from its estimate shifts the scroll offset by the
  difference, which is what keeps the reader's place while older pages land.
  A conversation opens at its end; reaching the top loads the previous page
  (a short history keeps loading until the viewport is filled or the first
  message is in), and a "Load earlier messages" button does the same.
- `HomeChat` passes `streamingMode: "throttled"`. The side panel renders
  `HomeChat`, so it gets all of this; the standalone QiSpace `/chat` page
  gets the throttle and a memoised row (it caps itself at 20 messages).

## Tests

- Runtime: `src/do/transcript.test.ts` (pager over an in-memory row source:
  alignment, cursors, `after` re-sends, summaries skipped, bad cursors),
  `src/sqlite/sqlite.test.ts` (row listing around an anchor, both
  directions, inclusive, tie-break), `apps/qiforge-workers-example/test/e2e-transcript.ts`
  (`pnpm test:e2e:transcript`, local and devnet: pages tile the legacy
  listing exactly, `after` after a new turn, 400s, clamping).
- SDK: `src/utils/transcript-pages.test.ts` (paged fetch, legacy fallback,
  merge, tail folding), `oracle-chat-state.test.ts` (throttle timing,
  immediate flush on state changes, no cap), `oracle-chat.test.ts` (history
  merge idle vs streaming).
- Portal: `__tests__/unit/homeChat/turnActivity.test.ts` (turn identity
  reuse).

## Not done (deliberately)

Tool outputs stay inline in the transcript DTOs (no previews + lazy fetch):
a page holding several large results is a bigger download than it could be,
once per page. Deep links to a message would need an `around=` mode.
