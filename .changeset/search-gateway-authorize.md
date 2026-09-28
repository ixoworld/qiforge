---
'@ixo/oracle-runtime-workers': minor
---

Search Gateway authorization for capsule skills. `ctx.ucan.mintInvocation` and `createInvocationFromDelegation` accept extra invocation `facts` (the host still generates the `nonce`). New `ctx.ucan.listAudienceGrants(userDid, { storeUrl, audienceDid })` returns the user's active UCAN-store delegations issued by the user and addressed to a given service, checked on each token. A new bundled `search-gateway` plugin contributes the request-time `search_gateway_authorize({ requestDigest })` tool: it mints a single-use `search/authenticate` invocation on `ixo:search` bound to the request by an `rd` fact, appends the user's gateway grants, and returns a blob id for `sandbox_write_blob`, so the credential never reaches the model. `SEARCH_GATEWAY_URL` overrides the per-`NETWORK` gateway.
