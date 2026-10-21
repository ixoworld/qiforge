---
'@ixo/action-interactions': minor
'@ixo/oracle-runtime-workers': minor
'@ixo/oracles-client-sdk': minor
---

Add private, revision-bound Companion action interaction drafts. `@ixo/action-interactions` is the portable wire contract and client (published as compiled JavaScript). The Workers runtime stores drafts per user behind `ACTION_INTERACTIONS_ENABLED`, reserves one reviewed claim operation, and checks every claim dispatch; a manual form submission supersedes a card whose operation never reached the claim service, so an abandoned card can no longer lock a step. Drafts are indexed per session and retained for 30 days after expiry. The client SDK re-exports the contract at `@ixo/oracles-client-sdk/action-interactions`.
