---
'@ixo/oracle-runtime-workers': patch
---

Runtime wiring for the hardened `@ixo/ucan` and the cross-component fixes.

- UCAN authentication (the shell and the channel route) reuses one did:ixo resolver per Blocksync URL per isolate, with a 60 s resolution cache and the library's default lookup timeout, so repeated invocations from one user no longer query Blocksync each time. A key rotated out of, or removed from, a DID document on-chain stays trusted for up to 60 s.
- The shell keeps no replay marks: an auth invocation is a bearer token reusable until it expires, so concurrent requests carrying one token all authenticate (they share one verification) and a token whose cached verdict was evicted re-validates. The channel route caches its did:web service identity for 60 s, failures excluded.
- The channel route keeps accepting identical concurrent retries of one request: a poll may reuse its invocation, and the durable receipt keeps every repeat on one run.
- A user object passes the 60 s attachment download deadline to the gateway's Matrix media downloads (`MatrixGatewayObject.downloadEventMediaStream` / `downloadMxcMediaStream` take an optional `{ timeoutMs }`). An aborted turn cancels the media stream it is reading, which stops the gateway's download.
- A request-time tool or sub-agent whose name is already taken this turn (a boot-time tool or sub-agent, a meta-tool, `read_result`, a runtime turn tool, or an earlier request-time entry) is dropped with a warning. A browser-declared tool or AG-UI action can no longer shadow a server tool, overwrite its effect classification or make it repeatable. The "Browser tools this turn" prompt block names only the browser tools actually bound.
- A tool result with the editor's `write_not_saved` code counts as an uncertain write, so its claim is kept and an identical write is not run again in the same turn. The stale `flush_timeout` code is no longer listed.
