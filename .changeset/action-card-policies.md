---
'@ixo/action-interactions': minor
'@ixo/oracle-runtime-workers': minor
---

Action card lifetimes come from a policy table per owner kind, owned by the runtime.

- Claim, Claim block, bid and approval cards keep their 7-day action window, and lose their values 30 days after it.
- Question, artifact, task and owner-reference cards have no action window: their `expiresAt` is the new exported `NO_ACTION_WINDOW`, and they live with their chat, outside retention.
- The weekly cap of 200 cards per chat counts kinds with and without an action window apart, so a chat full of charts can still prepare a claim.
- A claim step takes many claims. A reported claim no longer closes the step: the ordinary form may submit again, and a prepare with the new `repeat` field starts another card (`/health` lists the `repeat` operation). Without `repeat`, the step returns its submitted card in its own chat and 409 `repeat_required` elsewhere. A claim sent from the ordinary form leaves no outcome in the runtime, so after it a card needs `repeat` even while that claim may still be on its way; only the person's request for another claim may set it. Bids stay one per role.
- The Portal plugin's guidance covers every card the person sees, answers, reviews or signs.
- Asking the person (`ask_question_card`, or `ask_user_question` where a chat has no cards) is bound on every turn that declares it, instead of waiting for the Portal capability to load; every other browser tool stays on demand.
