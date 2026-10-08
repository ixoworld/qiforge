---
'@ixo/oracle-runtime-workers': minor
---

Add observe-only domain context, off by default (`createOracleWorker({ domainContext: { mode: 'observe', … } })`). A turn resolves the oracle's and the selected subject's `domain.md` from their IID `#dom` anchors on Blocksync, verifies them by CID and static validation, and appends one `<verified_domain_context>` block to the system prompt of the main agent and its sub-agents, with the `read_domain_document` and `refresh_domain_context` tools. Anchors, public bytes and parsed indexes are cached per user object; pass-1 documents load in parallel under a 3 s budget; a durable run keeps the anchors it started with on resume. Provenance goes out on `router_update` and into the user's `domain_context_runs` table (deleted with the session). Nothing grants a capability or activates a capsule. Request metadata `currentEntityDid: null` now clears the selected subject; omitting it keeps the previous one.
