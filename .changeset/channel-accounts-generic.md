---
'@ixo/oracle-runtime-workers': minor
---

Channels ingress serves any oracle, not only the Companion. `POST /channels/turn`
accepts any provider id matching `^[a-z][a-z0-9_-]{0,31}$` (was `whatsapp`
only; an unknown provider uses the generic delivery profile) and
`context.kind` of `oracle` or `companion` (was `companion` only).
`CHANNEL_SERVICE_DID` may be a comma-separated list of channel service DIDs:
any listed service can invoke, and a user grant must be addressed to the
service that signs the invocation; an empty list still answers
`503 not_configured`. Error messages no longer name the Companion (for
example `Delegation required: the user must authorize this oracle again`,
`The user's oracle room is not ready`); error codes are unchanged.
