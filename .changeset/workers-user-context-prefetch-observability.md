---
'@ixo/oracle-runtime-workers': patch
---

The user-context prefetch now logs one warn line per first contact, `[user-context] first contact room=<room> session=<session> outcome=<cached|fresh|timeout|failed|skipped|aborted> waited=<N>ms`: what the thread's first turn was given and how long it waited for it, the one line to read when logs are filtered to warn and above. It was added after a live testnet first turn: a cold engine gather took 4.8 s, filled the room's cache 1.8 s after the 3 s cap, and the user's next session got the block in 269 ms.

A gather that is still unsettled 5 s past its request timeout is abandoned instead of being joined by every later turn of the room: the next turn logs `[user-context] gather for room=<room> unsettled after <N>ms; starting a new one` and gathers again, and a late answer from the abandoned gather does not overwrite the room's cache.

The MCP end-to-end drill (`pnpm test:e2e:mcp`) now covers the slow-engine path: the mock's batch endpoint answers 5 s late, the first contact ends with `timeout`, the background gather fills the room's cache, and the next session's first turn is served from it.
