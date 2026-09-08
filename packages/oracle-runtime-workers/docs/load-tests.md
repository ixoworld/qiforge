# Load tests and what they taught us

All numbers are from the deployed devnet worker (one `UserOracleDO` per
user, the gateway in its own script) between 2026-09-01 and 2026-09-07.
Absolute latencies include a real LLM round-trip, so compare rows within a
table rather than against other systems.

## Single user

300 new sessions (paced at ~85/min under the 100 per 60 s per-DID limit),
then 20 turns spread over them, 22 MB working copy:

| Operation                                        | Result                                   |
| ------------------------------------------------ | ---------------------------------------- |
| `POST /sessions` × 300                           | 300/300, p50 449 ms, p95 1.1 s, 0 errors |
| non-streaming turn × 20 (1,100 sessions on file) | p50 2.3 s, p95 5.1 s, 0 errors           |
| `GET /sessions` / page 3 / `GET /messages/:id`   | 477 / 117 / 91 ms                        |
| flush 27 MB to the VFS / reload cold             | 11.0 s / 5.1 s                           |

## Five users at once

| Phase                                                               | Result                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| 5 users × 5 sequential turns, all users in parallel                 | 25 turns in 20 s wall, p50 1.9 s, p95 5.0 s, 0 errors     |
| 3 synchronized bursts                                               | p50 1.8–2.1 s, 0 errors                                   |
| isolation (each user lists / reads / turns on the others' sessions) | 0 leaks: foreign ids absent, transcripts empty, turns 404 |

## Twenty users at once

| Phase                                 | Cold objects                                                                 | Warm objects         |
| ------------------------------------- | ---------------------------------------------------------------------------- | -------------------- |
| grants for 20 users in parallel       | 6 s, 0 errors                                                                | —                    |
| 20 × 5 session creates at once (100)  | p50 6.1 s, p95 15 s (paced at 3/s)                                           | p50 6.9 s, p95 7.9 s |
| 20 users × 4 turns in parallel (80)   | p50 1.8–2.1 s, p95 4.9–5.4 s                                                 | same                 |
| 3 bursts of 20 simultaneous turns     | p50 2.2–2.7 s                                                                | same                 |
| 120 list + transcript reads           | p50 111–118 ms, p95 267–305 ms                                               | same                 |
| `/health` polled every 2 s throughout | p50 15 ms, 0 errors                                                          | same                 |
| after                                 | 400/400 responses 2xx, 20 distinct objects, 0 active turns, 0 pending timers |                      |

Per-user objects do not contend: the parallel p50 is no worse than the
single-user baseline. The per-DID rate limit is the first ceiling a single
client hits.

## Session creation is the one funnel

A new session is a Matrix event: the new-conversation marker is sent into
the user's room through the one gateway object, and its event id becomes the
session id (Node parity). Turns and reads never wait on the gateway (the
per-turn room replay is fire-and-forget), so creates are the only operation
whose latency grows with the number of simultaneous creators across all
users.

| Concurrency (warm objects)                         | Create latency                        |
| -------------------------------------------------- | ------------------------------------- |
| 1 user, sequential                                 | 223–308 ms                            |
| 2–4 users at the same instant                      | 227–593 ms, occasional 1.1–1.2 s      |
| first create after the object was idle (cold boot) | 2.3–3.4 s, once per idle period       |
| 20 users × 5 at once                               | p50 6–7 s (paced at the server's 3/s) |

The ceiling is the homeserver's per-sender limit (3 messages/s on devnet):
ten simultaneous creators wait ≥ 3 s by arithmetic. Two ways down: raise
`rc_message` for the bot with Synapse's per-user override and
`MATRIX_SEND_RATE_PER_SECOND` to match (see configuration), or stop waiting
for the marker at all — create the session row locally and send the marker
asynchronously (ORA-410, not built).

**Mixed load** (10 users creating 3 sessions each while 10 others run 3
turns each) is the sensitive case, because every chat turn queues two
replay sends on the same bot ahead of the next marker:

| Gateway build                                                 | Creates              | Turns                |
| ------------------------------------------------------------- | -------------------- | -------------------- |
| single serial send queue (matrix-js-sdk default)              | p50 28 s, p95 44 s   | p50 1.7 s            |
| per-room priority scheduler (markers before replays)          | p50 9.6 s, p95 17 s  | p50 2.0 s            |
| + durable outbox, gates, patched SDK (2026-09-04 final)       | p50 2.6 s, p95 3.9 s | p50 1.8 s, p95 2.5 s |
| `@ixo/matrix-bot-workers-sdk` 0.1.0 (2026-09-07, 9 + 9 users) | p50 18 s, p95 35.6 s | p50 2.1 s, p95 3.1 s |
| `@ixo/matrix-bot-workers-sdk` 0.1.3 (2026-09-08, 8 + 8 users) | p50 2.2 s, p95 2.7 s | p50 1.9 s, p95 4.5 s |

The 0.1.0 row was the SDK taking its encryption gate before its priority
scheduler saw the event, so background replays holding gate slots delayed
interactive markers first-come-first-served; 0.1.3 releases the room lock
and the gate as soon as the scheduler holds the encrypted event. The gateway
tags markers `interactive` and replays `background`; nothing changed on its
side.

## Restart safety and memory (2026-09-04, 20 users)

| Measure                             | Result                                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| 80 turns, 20 users in parallel      | 11 s wall, p50 1.9 s, p95 4.3 s, 0 errors                            |
| room mirror of all 140 turns        | 142 outbox rows drained in ~90 s at the 3/s server limit, 0 failed   |
| planned recycles during the drain   | 2, same device before and after, ~5 s gap each                       |
| one-time-key uploads during the run | 0 (the unpatched SDK did 50 uploads / 2,500 keys in 40 s)            |
| `exceededMemory` kills              | 0 in ~6,000 invocations (hundreds per five minutes before the fixes) |
| gateway device                      | one throughout (rotated at every restart before)                     |

## The SDK gateway (2026-09-07)

Feature matrix: every runtime step green (the memory-engine recall step
returned an older memory on an account with a long stress history — the
engine's ranking, not the runtime). Quick stress, 18 users, phases 2 + 2b:

| Measure               | Result                                                                               |
| --------------------- | ------------------------------------------------------------------------------------ |
| 72 turns in parallel  | 14 s wall, p50 2.1 s, p95 5.2 s, 0 errors                                            |
| mixed phase           | creates p50 18 s / p95 35.6 s (see above), turns p50 2.1 s                           |
| `/health` during load | p50 17 ms, p95 963 ms, 0 errors                                                      |
| gateway               | one instance throughout, 243 sends, 0 failed, 0 rate-limited, 753 invocations all ok |
| boot                  | fresh device 1.2 s; token-resumed restart 0.23 s                                     |

## Findings that shaped the gateway

These are the reasons the SDK behaves the way it does; the code for all of
them now lives in `@ixo/matrix-bot-workers-sdk`.

- **Encryption is the memory hazard.** matrix-js-sdk encrypts an event the
  moment `sendEvent` is called; without a gate, dozens of replays in the
  "encrypting" state at once pushed the object over 128 MB (`exceededMemory`
  in `wrangler tail`, ~35–42 s each). Bounding concurrent encryptions (the
  send gate, the turn gate) removed the kills. Measured in Node with the
  same SDK, the heap is ~60 MB before the first sync and barely moves with
  the number of rooms; the SDK plus the crypto WASM is a ~80 MB floor, so
  the 128 MB limit leaves ~40 MB for bursts.
- **The per-send leak.** With every other cause removed the gateway still
  died about every 55 s under sustained load. fake-indexeddb 6.2.5 never
  removes a finished transaction from its database's transaction list, and
  each keeps its rollback closures — ~250 KB retained per encrypted send
  (38 → 114 MB over 300 sends). The SDK hooks the transaction list; the heap
  is flat (38.7 → 42.4 MB) and `cryptoStoreTransactions` in the status is the
  guard. Not the cause, tried on the way: thread objects, per-send crypto
  snapshots, early-acknowledged sends, SDK debug logging.
- **Runaway one-time-key uploads.** matrix-js-sdk 42.x calls the crypto
  machine's `receiveSyncChanges` with an empty one-time-key count map on
  every sync carrying a to-device message; the crate reads that as "the
  server holds zero keys" and queues 50 fresh keys each time — thousands per
  device within minutes, and no snapshot cadence could keep the account's key
  counter current across a kill, so every restart rotated the device. The
  SDK's runtime shim defaults the count to the last one seen. The same shim
  clears the per-request timeout timer matrix-js-sdk arms and never cancels
  (110 s for `/sync`), which kept objects resident. The Node runtime pins
  matrix-js-sdk 37.x and still carries both bugs.
- **Restart timing mistakes worth not repeating.** Arming the alarm 1.5 s
  before a reset let it land during the isolate teardown, and Cloudflare
  only re-delivered it after ~30 s; snapshotting the crypto store before
  in-flight key uploads had settled produced a store older than the last
  upload and started the conflict loop. A device rotation next to the old
  crypto machine's WASM memory tipped rotations into the memory limit under
  load; rotations therefore run from a fresh instance.
- **Poison sends.** A replay threaded on a non-event-id session id made
  `OutboundGroupSession::encrypt` panic and the stuck send held a gate slot
  forever. Three layers now hold: room resolution fails a request instead
  of minting a local session id on a transient error, `sendText` rejects a
  thread id that is not an event id, and the send watchdog charges the row
  that hung and drops it after three attempts.
- **Early acknowledgement hides failures.** Acknowledging background sends
  before the homeserver answered only hid kills (fewer invocations were in
  flight when the object died); every send waits for its event id again.
- **Recycling under load is unnecessary.** A forced reset at a send
  threshold was tried; once the leak was fixed, one instance carried 1,873
  sends across four 20-user stress sets with 0 kills, and the forced reset
  was the only user-visible blip. The recycle is idle-only now.
