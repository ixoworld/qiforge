---
'@ixo/ixo-transaction': minor
---

Batches in the `sign_transaction` contract: several catalogued messages signed in one wallet transaction, through the same action and the same Portal handler.

- **Batch form.** `SignTransactionActionArgsSchema` takes `intent.source: 'batch'` with 1 to `MAX_BATCH_MESSAGES` (16) messages; `intent` carries the batch `summary` and each message's route in order (it must match `messages`), and a batch carries no `testnetReceipt`. The single-message form is unchanged and still exactly one message; conversational drafts (`TransactionDraftSchema`, `validateTransactionDraft`) stay single.
- **Validation and builder.** `TransactionBatchSchema`, `validateTransactionBatch` (every message through `validateMessage`; risks are every message's catalog risks, each once; the level is the highest; with the risk gate every risk must be accepted word for word; mainnet needs `allowMainnet`) and `buildBatchSignTransactionActionArgs`. `buildSignTransactionActionArgs` now returns the narrowed `SingleSignTransactionActionArgs`.
- **Portal.** `signIxoTransactionWithWallet` / `useIxoTransactionSigningAction` validate every message of a batch and sign them in one `transactSignX` call; one message outside the catalog refuses the whole request. No catalog entries were added: the POD Creator's messages (`MsgCreateEntity`, `MsgCreateEntityAccount`, `MsgCreateCollection`, `MsgCreateClaimAuthorization`, `MsgGrantEntityAccountAuthz`) were already catalogued and SDK-checked.
