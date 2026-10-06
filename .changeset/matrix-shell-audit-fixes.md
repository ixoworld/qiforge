---
'@ixo/oracle-runtime-workers': patch
---

Matrix gateway, realtime socket and HTTP shell hardening.

- A room's `m.room.canonical_alias` identifies its user only when the alias is a user↔oracle alias of this oracle and resolves to that room. Verdicts are kept per room for 30 minutes and dropped when the alias event changes. A non-DID sender is attributed to the alias's user only when it is on the alias's homeserver; otherwise the message is unmapped and wakes no user object. A homeserver lookup error keeps the inbox row and retries it after 60 s. A message still waiting in the debounce window is no longer replayed a second time when the bot starts in place (a device rotation).
- A failed turn preparation retries after 60 s instead of losing the message, and a failing typing notice no longer fails the turn. A turn counts as in flight before it waits for a slot.
- Realtime sockets: `userDid` must be a W3C DID of at most 512 characters, upgrades are rate-limited per IP, one CONNECT is validated at a time per socket, no alarm is armed before CONNECT succeeds, and a frame over the payload limit closes the socket with 1009.
- Every debug route, including Matrix stop and restart, needs UCAN authentication. With the new optional `ORACLE_OPERATOR_DIDS` (comma-separated DIDs) set, every `/debug/matrix/*` route answers 403 to any other caller; a list with an entry that is not a DID admits nobody. Unset, any authenticated caller may use them, as before.
- Request bodies are capped before they are read: 256 KiB for `POST /messages/:sessionId`, 64 KiB for `POST /delegation`, `/byo-llm/*` and `/debug/*`, 4 KiB for `POST /messages/abort`.
- `/health/matrix` answers `{running}` from memory. `/matrix/status` and `POST /matrix/start` are rate-limited per IP, and the status's storage counts may be up to 5 s old.
- An unexpected error returns a generic 500 body with a `requestId` (also in `x-request-id`); the detail is in the log under that id.
- Blocksync homeserver lookups are bounded at 5 s; a DID whose document names no homeserver is cached for 5 minutes (a DID Blocksync has no record of is not cached), and the gateway memoises its `hs:` and `alias:` keys in memory.
- Group-chat automatic compaction backs off after a failed summary (1 minute, doubling up to 30) and summarises at most the 50 oldest messages per chunk.
- Room replays use the HTML-escaping renderer, and in every room message a link or image whose URL is not http(s), mailto or mxc is shown as its text.
- Every `RATE_LIMIT` key is prefixed with the oracle DID (`<ORACLE_DID>|<scope>|<subject>`). The channel turn is rate-limited right after its invocation is validated, before the Auth Hub call.
- The gateway's media downloads (`downloadEventMediaStream`, `downloadMxcMediaStream`) take an optional `{ timeoutMs, signal }` and are bounded to 60 s by default, from the request to the last byte.
- The `listModels` option of `createOracleWorker` / `createShell` receives a second, optional argument `{ waitUntil }` (type `ListModelsOptions`, exported): `GET /models` hands over the request's `waitUntil` so a background price refresh outlives the response. Overrides that take only `env` keep working.
