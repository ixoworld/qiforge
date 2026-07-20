---
'@ixo/ucan': minor
---

Fix a proof-chain forgery in the validator under wildcard root issuers (`rootIssuers: ['*']`).

Previously, wildcard mode made ucanto's `canIssue` return `true` for the invocation's own issuer, so an invocation was authorized on its own signature alone and the attached delegation proofs were never walked or cryptographically verified — yet `proofChain[0]` (which callers use for row ownership/attribution) was read from those unverified proofs. An attacker holding any valid DID could attach a forged delegation naming any victim as root and have the request attributed to that victim.

Two complementary hardening changes on the `validate()` path:

1. Wildcard mode now accepts only the structural root of the invocation's proof chain as a root issuer, forcing ucanto to walk and verify the entire chain (signatures + expiration + caveat attenuation) up to that root. Forged, expired, or over-broad proofs are rejected. Self-issued invocations (no proofs) are unaffected — their root is the invoker.

2. The returned `proofChain` is now derived from ucanto's cryptographically verified authorization result rather than from the invocation's raw attached proofs. This guarantees a forged proof can never be reported as the row-owning root even when a `canIssue` short-circuit (e.g. the resource-scoped self-issue path, where the resource URI contains the invoker DID) stops ucanto from walking the stapled proofs.

Non-wildcard configs (`rootIssuers: [did, ...]`) and `validateDelegation()` were already sound and are unchanged.
