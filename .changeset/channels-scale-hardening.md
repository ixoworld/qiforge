---
'@ixo/oracle-runtime-workers': minor
---

Channel turns (`POST /channels/turn`) no longer wait on Matrix: a finished run is answered at once, and the Companion room mirrors (user message, then reply) are owed by the request's receipt, sent in the background, retried from the alarm with backoff and abandoned on `M_FORBIDDEN`; the admission lock is never held across a Matrix call.
A new request naming a deleted session drops its receipt and answers `409 session_conflict` (resend the same request ID without `sessionId`); the 900 s delegation margin applies only to new requests and run starts, never to polls, and a held delegation inside the margin re-reads the deposited room state.
Polls of an existing run are answered by the warm object without an Auth Hub call; active binding verdicts are cached per isolate for 60 s; channel requests have their own rate-limit key (`<oracle>|channel|<did>`).
New final refusals `409 room_unavailable` (homeserver refuses the oracle) and `403 storage_unauthorized` (VFS 401/403); receipts that never started a run and run tombstones are pruned after 7 days; the room-encryption check is cached; manifest lint logs one summary line unless `BOOT_LINT_VERBOSE=true`.
