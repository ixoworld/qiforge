---
'@ixo/oracles-client-sdk': minor
---

Credentials refused by the oracle are renewed in two stages, everywhere.

**Type change:** `IOraclesContextProps` has a new required member, `renewOracleAuth`. Code that builds the context object itself (a test double of `useOraclesContext`) no longer compiles until it provides one.

- **Two stages.** When the oracle refuses a request for its credentials (401, or a 403 other than `VFS_AUTH_FAILED`), the SDK mints a fresh invocation and repeats the request; refused again, it mints a fresh delegation, then a fresh invocation, and repeats it a last time. The delegation stage, which asks the user for their key, runs only after a repeat with a fresh invocation was refused, never on a first refusal. A delegation that stage minted less than ten minutes ago is not replaced again; refusals that arrive together share one renewal; a caller whose refused credentials another caller already replaced repeats with the new ones without minting.
- **Where.** `authedRequest` (every hook's REST calls) now renews and repeats; it used to throw on the first refusal. The turn's `POST /messages/:sessionId` is repeated while it is refused for its credentials (a refused POST was never processed) and never once accepted; it used to fail at once. Re-joins of a running reply and the realtime socket's CONNECT gain the second stage. The socket no longer renews for refusals new credentials cannot fix (a failed session check, a failed auth check, a token of another user).
- **`run.ended === 'unauthorized'`** now means the re-join was refused after both stages. A POST still refused after both stages rejects `sendMessage` with a `RequestError` whose `status` is the refusal's (it used to carry only `statusCode`).
- **API.** `getDelegation(oracleDid, { fresh: true })` replaces the cached delegation (dropped before the mint, so readers meanwhile get the new one). The context adds `renewOracleAuth(oracleDid, stage, refused?)`, the shared renewal for a host's own requests, and the provider takes `onDelegationRenewed(oracleDid, delegation)`, called after the delegation stage minted one (for example to deposit it with `POST /delegation`). New exported types: `AuthRenewalStage`, `RefusedCredentials`.
- **`RequestError.status`** falls back to the HTTP status when the error body has no `statusCode`.
