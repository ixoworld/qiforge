# TASK-32 — End-to-End Smoke Checklist

QA pass for the new QiForge runtime via `apps/qiforge-example`. The goal is to verify:

1. The new runtime serves chat end-to-end (feature parity with old `apps/app`)
2. The 32b optimizations actually fire (no regressions, real wins)
3. Plugins work, state persists, errors are sane

**Mark each check with `[ ]` → `[x]` as you go. Add notes inline when something feels off.**

---

## 0. Pre-flight

- [x] `apps/qiforge-example/.env` is filled with real Matrix creds, oracle DID, `OPEN_ROUTER_API_KEY` (or `NEBIUS_API_KEY`)
- [x] `oracle.config.json` has the right `entityDid` for your test oracle
- [ ] Redis is running locally (`docker run -p 6379:6379 redis` or `docker compose up redis`) — required for credits + claim-processing
- [ ] You have a way to obtain a UCAN delegation header for an authenticated test user (CLI/portal/script — whatever your flow is)
- [ ] Pick a tool to hit endpoints: `curl`, Postman, the qiforge web portal, or `oracles-client-sdk`

---

## 1. Boot & startup (no LLM key needed yet)

```bash
cd apps/qiforge-example && pnpm dev
```

**Verify in the boot log:**

- [ ] No unhandled exceptions
- [ ] `[boot] loaded plugins: ...` lists 12-13 plugins (slack excluded if no `SLACK_BOT_OAUTH_TOKEN`)
- [ ] `[boot] excluded plugins: ...` reflects what you DIDN'T configure (e.g. slack)
- [ ] `[plugin] matrix pending → loaded` appears within ~3s
- [ ] `[MatrixListenerBridge] Matrix message listener registered` appears
- [ ] `Nest application successfully started`
- [ ] `Oracle '...' (runtime v...) listening on :PORT`
- [ ] **No warnings** about duplicate env-key ownership (we fixed `MATRIX_BASE_URL`)
- [ ] **No warnings** about `OracleRuntimeBundleHolder unavailable` (means the bundle populated)

**Verify cron is alive:**

- [ ] After ~30s: `[ClaimProcessingService] Processing held amount for 0 users` log appears
- [ ] After ~60s: `Uploading checkpoint to Matrix storage task started` appears

---

## 2. Public (no-auth) endpoints

| Endpoint | Method | Expected |
|---|---|---|
| `/` | GET | `{ status: 'ok', message: '...' }` |
| `/health` | GET | `{ status: 'ok', timestamp: '...' }` |
| `/docs` | GET (browser) | Swagger UI loads, lists all endpoints + tags |
| `/docs-json` | GET | OpenAPI JSON spec |

- [ ] `curl localhost:8888/` returns 200
- [ ] `curl localhost:8888/health` returns 200
- [ ] Browser at `localhost:8888/docs` renders Swagger
- [ ] Swagger lists: `health`, `messages`, `sessions`, `user-preferences`
- [ ] Swagger has an "Authorize" button for the `x-ucan-delegation` header

---

## 3. Auth gating

- [ ] `curl localhost:8888/sessions` (no headers) → **401 Unauthorized**
- [ ] `curl -X POST localhost:8888/sessions` (no headers) → **401**
- [ ] `curl localhost:8888/user-preferences` (no headers) → **401**
- [ ] Same routes WITH a valid `x-ucan-delegation` header → not 401 (might be 200, 404, 400 — point is they pass auth)
- [ ] Routes with an INVALID/expired UCAN → **401** with "Invalid UCAN delegation" message

---

## 4. Sessions

- [ ] `POST /sessions` (with UCAN) → 201 with a session object containing `sessionId`, `roomId`
- [ ] `GET /sessions` (with UCAN) → 200, list includes the session you just made
- [ ] Boot log shows `[Matrix]` ensuring the user↔oracle room was created/found
- [ ] `DELETE /sessions/:id` → 200, the session is gone from `GET /sessions`

---

## 5. Chat — batch (non-stream)

- [ ] `POST /messages/:sessionId` with body `{"message": "hello", "stream": false}` returns 200 JSON: `{ message: {...}, sessionId }`
- [ ] The response message has `content` that's a non-empty string
- [ ] Boot log shows the LLM was called (look for OpenRouter activity / `LLMProvider` log)
- [ ] Subsequent `GET /messages/:sessionId` returns the conversation (both user + AI messages)

---

## 6. Chat — streaming SSE (the critical path)

- [ ] `POST /messages/:sessionId` with `{"message": "Tell me a short story", "stream": true}` returns:
  - **`Content-Type: text/event-stream`** header
  - **Immediate `: heartbeat`** message (sub-100ms after request lands — the controller-level early SSE flush)
- [ ] First payload event arrives within ~500ms of request: a `ReasoningEvent` with `text: "Thinking..."` (or similar)
- [ ] Subsequent events stream tokens as they generate:
  - `message` events with incremental `content`
  - Optional `ReasoningEvent` chunks (model-dependent)
- [ ] A terminal `ReasoningEvent` with `isComplete: true` arrives
- [ ] Final `event: done` arrives
- [ ] Stream closes cleanly (no hanging connection)

**Latency targets** (rough — depend on LLM cold-start):
- [ ] Time-to-first-byte (`Content-Type` header): **< 100ms** typical
- [ ] Time-to-first-event (`Thinking...`): **< 1s** typical
- [ ] Time-to-first-token: **dominated by LLM** (500-2000ms typical for OpenRouter)

---

## 7. Tool calls during chat

Ask the agent to do something that triggers a plugin tool. Examples:

- [ ] "Look up entity did:ixo:..." → `domain-indexer` tool fires
- [ ] "Remember that I prefer Spanish" → `user-preferences.set_user_preferences` fires
- [ ] "Search the web for ..." → `firecrawl` tool fires (if FIRECRAWL_API_KEY set)

**For each tool call, verify the SSE stream emits:**
- [ ] A `ToolCallEvent` with `status: 'isRunning'` when the LLM begins the call
- [ ] A `ToolCallEvent` with `status: 'done'` (or `'error'`) when the tool returns
- [ ] The tool's `output` field is populated
- [ ] The frontend renders the call (if you have a UI hooked up)

---

## 8. AG-UI actions (browser-side actions)

If you have a Portal/UI client that sends `agActions` in the request body:

- [x] `agActions` array in request body → those names get routed as `ActionCallEvent`
- [x] Server-tools (NOT in agActions) → routed as `ToolCallEvent`
- [x] Both types stream `isRunning` → `done` (or `error`)
- [x] AG-UI actions get their args sent via WebSocket (per old behavior)

---

## 9. Browser tools

Same idea — if Portal sends `tools: [{ name, schema, description }]`:

- [ ] Tools appear in the agent's available toolset
- [ ] Agent can call them; results stream back

---

## 10. File attachments

- [ ] `POST /messages/:sessionId` with `attachments: [{ eventId: '...', filename: 'doc.pdf', mimetype: 'application/pdf' }]`
- [ ] Boot log shows `Processing N attachment(s)` then `Attachment "..." processed`
- [ ] If credits plugin loaded: log shows `Deducted N credits for file processing`
- [ ] The agent's response references the file content (proves text extraction landed in the prompt)

---

## 11. Per-process sync-once (perf win)

This verifies the `syncedUsers` Set + cron lifecycle fix.

- [ ] First message from a NEW user → log shows `Syncing checkpoint for user did:ixo:...`
- [ ] Second message from the SAME user → NO sync log
- [ ] Third+ messages → NO sync log
- [ ] After 1h idle, the cron deletes the local file. Next message → sync log re-appears (only practical if you can wait 1h)

---

## 12. Subscription middleware cache (perf win)

- [ ] First chat hits `SubscriptionMiddleware` cache miss → log shows `[UCAN] Using UCAN invocation for subscription check`
- [ ] Subsequent chats within 3 min → log shows `Subscription found in cache for user: ...`
- [ ] **No `[CreditsPlugin]` setSubscriptionPayload / overrideUserBalance log** on cache-hit requests (we skip the redundant Redis writes)
- [ ] After 3 min: cache expires, next request re-hits the subscription API

---

## 13. SSE channel opens before pre-flight (perf win)

Time the controller's SSE flush vs the agent build:

- [ ] Network tab in browser (or `curl -N -v`) shows response headers + heartbeat within **~10ms** of request hitting
- [ ] First `Thinking...` event lands **after** session lookup completes (still fast, but distinct)
- [ ] If you deliberately throw in the agent build, the SSE channel ALREADY opened — you'll see the heartbeat then the error event

---

## 14. Abort

- [ ] Start a stream, then close the connection from the client (Ctrl-C on curl, close tab on browser)
- [ ] Server log shows abort handled cleanly (no unhandled rejection)
- [ ] `POST /messages/abort` with `{sessionId}` aborts an active stream
- [ ] Trying to send a NEW message on the same session while one is streaming → the previous one is aborted, the new one runs

---

## 15. Plugin auto-detect & exclusions

- [ ] Remove `SLACK_BOT_OAUTH_TOKEN` → slack excluded with reason `auto-detect precondition not met (SLACK_BOT_OAUTH_TOKEN)`
- [ ] Add `SANDBOX_MCP_URL` → sandbox + skills BOTH load
- [ ] Remove `SANDBOX_MCP_URL` → sandbox excluded → `skills cascaded off via sandbox` warning
- [ ] No `MEMORY_ENGINE_URL` → memory plugin excluded, BUT SessionManagerService still works (just no userContext enrichment)
- [ ] No `REDIS_URL` → credits + claim-processing excluded, chat still works (no credit gating)

---

## 16. Matrix integration

- [ ] Open the user↔oracle Matrix room (devmx.ixo.earth or wherever)
- [ ] Send a chat message via API → the user's text appears in the room as a regular message
- [ ] The AI's response also appears (replayed by the oracle bot)
- [ ] Send a message DIRECTLY from the Matrix room (as the user) → the bridge picks it up, runs the agent, replies in the same thread
- [ ] Text + file message sent within 500ms of each other → batched as one chat turn (debounce)

---

## 17. WebSocket

- [ ] Connect a WS client to `ws://localhost:8888/`
- [ ] Subscribe to `list-events` for a specific `sessionId`
- [ ] Start a chat → events stream over WS too (parallel to SSE)
- [ ] AG-UI action calls send their `args` over WS (not over SSE)

---

## 18. Memory persistence across restarts (`priorState` getTuple TODO)

This is the **flagged-for-verification** behavior from 32b:

- [ ] Send a message in session S1. Mid-conversation, ask the agent to load a capability (e.g. "Search for X" → forces `load_capability` for the relevant plugin).
- [ ] Verify it works (the lazy plugin's tools get called).
- [ ] **Restart the oracle** (Ctrl-C + `pnpm dev` again).
- [ ] Send a new message in session S1.
- [ ] Does the agent STILL have access to the previously-loaded plugin's tools? Or does it have to re-load via `load_capability`?

**Expected (per current code):** YES — `priorState` is read from the checkpoint via `getTuple` at agent-build time, so `state.loadedPlugins` carries forward.

**If this fails:** `agent-builder.ts` has 3 documented fallback options (drop the pre-read, build agent twice, move prompt inside the graph). Pick whichever fits.

Also verify userPreferences persist:

- [ ] Set a preference (agent name → "MyBot") via the agent
- [ ] Restart
- [ ] Next chat: prompt should remember "MyBot"
- [ ] `GET /user-preferences` returns the saved prefs

---

## 19. User preferences endpoint

- [ ] `GET /user-preferences` (with UCAN) → 200 with current prefs or `null`
- [ ] After setting via the agent's `set_user_preferences` tool, the GET returns the new value
- [ ] Multiple users have isolated prefs (room-scoped)

---

## 20. Error handling

- [ ] Send a `POST /messages/:sessionId` with no body → 400 BadRequest with validation error
- [ ] Send with a non-existent `sessionId` → 404 NotFound
- [ ] Trigger an LLM error (e.g. invalid API key) → SSE emits `error` event then `done`, stream closes
- [ ] Server doesn't crash

---

## 21. Boot-time error reporting

Toggle one of these on the next boot and verify the error message points at the right plugin:

- [ ] Unset `MATRIX_BASE_URL` → `Plugin 'core' env validation failed for 'MATRIX_BASE_URL'`
- [ ] Set `SUBSCRIPTION_URL=not-a-url` → `Plugin 'credits' env validation failed for 'SUBSCRIPTION_URL'`
- [ ] Misconfigure REDIS_URL → either credits skips silently OR ioredis throws (depending on URL shape)

---

## 22. Performance baselines (eyeball)

For each metric, just record the rough range you observe — we'll use this as a baseline for future regressions.

| Metric | First-time / cold | Warm cache |
|---|---|---|
| Auth header validate (no cache) | ___ms | < 5ms |
| Auth header validate (cache hit) | n/a | < 5ms |
| Subscription middleware (cache hit) | n/a | ___ms |
| `prepareForQuery` total | ___ms | ___ms |
| Checkpoint sync (per-user first-time) | ___ms | n/a (skipped) |
| Agent build (createMainAgent) | ___ms | ___ms |
| Time-to-first-token (TTFT) | ___ms | ___ms |
| Full message turn (no tools) | ___s | ___s |

---

## 23. Cleanup / shutdown

- [ ] Ctrl-C the oracle → graceful shutdown logs (matrix upload, sqlite close, etc.)
- [ ] No orphaned `.data/sqlite/*` lock files
- [ ] Restart succeeds (no port-already-in-use, no corrupt sqlite)

---

## Sign-off

When all critical sections pass (1, 2, 3, 5, 6, 7, 14, 18) — you can:

1. ✅ Mark TASK-32e complete
2. ✅ Greenlight TASK-32d (delete legacy `apps/app/src`, rename `qiforge-example` → `app`)
3. ✅ Move on to deferred work (tasks plugin rebuild, CLI updates, docs)

If anything in section 18 fails, **stop and revisit `agent-builder.ts`** — the priorState approach may need swapping out.

---

## Issues found

(Use this section to log anything weird as you test.)

- ___

