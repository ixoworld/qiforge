# @ixo/action-interactions

## 0.2.0

### Minor Changes

- [#500](https://github.com/ixoworld/qiforge/pull/500) [`8a264d6`](https://github.com/ixoworld/qiforge/commit/8a264d63557106fda1b401248c0feecc30dc21f2) Thanks [@mykhailopronka](https://github.com/mykhailopronka)! - Action card lifetimes come from a policy table per owner kind, owned by the runtime.

  - Claim, Claim block, bid and approval cards keep their 7-day action window, and lose their values 30 days after it.
  - Question, artifact, task and owner-reference cards have no action window: their `expiresAt` is the new exported `NO_ACTION_WINDOW`, and they live with their chat, outside retention.
  - The weekly cap of 200 cards per chat counts kinds with and without an action window apart, so a chat full of charts can still prepare a claim.
  - A claim step takes many claims. A reported claim no longer closes the step: the ordinary form may submit again, and a prepare with the new `repeat` field starts another card (`/health` lists the `repeat` operation). Without `repeat`, the step returns its submitted card in its own chat and 409 `repeat_required` elsewhere. A claim sent from the ordinary form leaves no outcome in the runtime, so after it a card needs `repeat` even while that claim may still be on its way; only the person's request for another claim may set it. Bids stay one per role.
  - The Portal plugin's guidance covers every card the person sees, answers, reviews or signs.
  - Asking the person (`ask_question_card`, or `ask_user_question` where a chat has no cards) is bound on every turn that declares it, instead of waiting for the Portal capability to load; every other browser tool stays on demand.

## 0.1.1

### Patch Changes

- [#471](https://github.com/ixoworld/qiforge/pull/471) [`86d7813`](https://github.com/ixoworld/qiforge/commit/86d7813cc08706f2f4471fc869b3ea46de6e6c1e) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - First release published from CI with npm trusted publishing (0.1.0 was published by hand to create the package).

## 0.1.0

### Minor Changes

- [#377](https://github.com/ixoworld/qiforge/pull/377) [`5d9690f`](https://github.com/ixoworld/qiforge/commit/5d9690f40aeba01cccdd30397b891ace1cf7f3e6) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add private, revision-bound Companion action interaction drafts. `@ixo/action-interactions` is the portable wire contract and client (published as compiled JavaScript; stored records and responses parse leniently, requests strictly). The Workers runtime stores drafts per user behind `ACTION_INTERACTIONS_ENABLED`, reserves one reviewed claim operation and checks every claim dispatch without booting the user object. A manual form submission supersedes a card whose operation never reached the claim service and closes the step to new cards; a host can report `not-submitted` to release a step the executor refused before sending; an undispatched reservation can be cancelled. Drafts are indexed per session, removed with a deleted chat, and retained for 30 days after expiry (pruned on new drafts and on the housekeeping alarm). Card reads use their own rate-limit bucket. The client SDK re-exports the contract at `@ixo/oracles-client-sdk/action-interactions`.
