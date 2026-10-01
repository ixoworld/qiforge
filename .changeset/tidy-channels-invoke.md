---
'@ixo/oracle-runtime-workers': minor
---

Add a dedicated channel ingress with user-rooted UCAN authorization, Auth Hub binding validation, durable turn receipts, and encrypted Matrix provenance. Channel retries reuse the same Companion session and run.

A finished channel run now keeps its reply and mirrors it into the encrypted Companion room, so polls return the answer instead of empty text. A channel attempt that finds Auth Hub unavailable is retried on the recovery backoff instead of failing; a revoked binding still ends the run. Deleting a channel's Companion session releases the binding, so the next message opens a new session instead of failing with 404. The assistant reply is mirrored once and recorded in the request receipt, so repeated polls no longer resend it. Channel receipts are dropped once their run is tombstoned, and any request for a pruned run returns 410. A new channel turn for a user without a stored delegation is refused with an explicit 409 instead of running without tool authority.
