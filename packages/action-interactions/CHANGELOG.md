# @ixo/action-interactions

## 0.1.0

### Minor Changes

- [#377](https://github.com/ixoworld/qiforge/pull/377) [`5d9690f`](https://github.com/ixoworld/qiforge/commit/5d9690f40aeba01cccdd30397b891ace1cf7f3e6) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add private, revision-bound Companion action interaction drafts. `@ixo/action-interactions` is the portable wire contract and client (published as compiled JavaScript; stored records and responses parse leniently, requests strictly). The Workers runtime stores drafts per user behind `ACTION_INTERACTIONS_ENABLED`, reserves one reviewed claim operation and checks every claim dispatch without booting the user object. A manual form submission supersedes a card whose operation never reached the claim service and closes the step to new cards; a host can report `not-submitted` to release a step the executor refused before sending; an undispatched reservation can be cancelled. Drafts are indexed per session, removed with a deleted chat, and retained for 30 days after expiry (pruned on new drafts and on the housekeeping alarm). Card reads use their own rate-limit bucket. The client SDK re-exports the contract at `@ixo/oracles-client-sdk/action-interactions`.
