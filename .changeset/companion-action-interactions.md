---
'@ixo/action-interactions': minor
'@ixo/oracle-runtime-workers': minor
'@ixo/oracles-client-sdk': minor
---

Add private, revision-bound Companion action interaction drafts. `@ixo/action-interactions` is the portable wire contract and client (published as compiled JavaScript; stored records and responses parse leniently, requests strictly). The Workers runtime stores drafts per user behind `ACTION_INTERACTIONS_ENABLED`, reserves one reviewed claim operation and checks every claim dispatch without booting the user object. A manual form submission supersedes a card whose operation never reached the claim service and closes the step to new cards; a host can report `not-submitted` to release a step the executor refused before sending; an undispatched reservation can be cancelled. Drafts are indexed per session, removed with a deleted chat, and retained for 30 days after expiry (pruned on new drafts and on the housekeeping alarm). Card reads use their own rate-limit bucket. The client SDK re-exports the contract at `@ixo/oracles-client-sdk/action-interactions`.
