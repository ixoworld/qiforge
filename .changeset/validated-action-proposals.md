---
'@ixo/ixo-transaction': minor
'@ixo/common': patch
'@ixo/oracle-runtime-workers': minor
---

Add an opt-in durable action proposal contract and owner lifecycle for conversational token transfers. Bind Portal consent to immutable values, deliver friendly channel action links and scoped verified outcomes, and reuse one canonical Decision-subject hashing implementation across browser and Workers consumers.

The card's id is the transaction memo (`inputs.memo`, required by the contract) and chain verification accepts no other memo, so one signed transaction confirms exactly one card; a hash is recorded for one card per owner. The owner object enforces the card policy itself (owner, signer, non-mainnet, configured chain id, 15-minute expiry) and refuses cards asked for in group rooms. Evidence checks match whole addresses, amounts with their unit and whole token ids, and ignore the turn-time note. Unconfirmed transactions are re-verified from the alarm with a doubling cooldown, receipts back off and are abandoned or quarantined instead of retrying for ever, finished cards are pruned after 90 days, and the action-card settings are validated at boot. A recorded hash the verifier proved is another transaction may be replaced; a transaction carrying the card's memo with other messages blocks the card (`lifecycle.executionBlockedAt` on the `unknown` card; revoke is the one command it still takes). The field is additive, but the lifecycle schema is strict: a consumer pinned to an earlier build rejects a blocked card, so the Portal must pin a build with this field (this branch or the published 0.2.0) before a runtime with this change serves its cards. `MsgSend` joins the shared message catalogue.
