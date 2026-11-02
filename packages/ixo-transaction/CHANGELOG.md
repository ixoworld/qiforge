# @ixo/ixo-transaction

## 0.2.0

### Minor Changes

- [#362](https://github.com/ixoworld/qiforge/pull/362) [`5bac08b`](https://github.com/ixoworld/qiforge/commit/5bac08bdf4707f36544a4b94cb02931ae9517610) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add an opt-in durable action proposal contract and owner lifecycle for conversational token transfers. Bind Portal consent to immutable values, deliver friendly channel action links and scoped verified outcomes, and reuse one canonical Decision-subject hashing implementation across browser and Workers consumers.

  The card's id is the transaction memo (`inputs.memo`, required by the contract) and chain verification accepts no other memo, so one signed transaction confirms exactly one card; a hash is recorded for one card per owner. The owner object enforces the card policy itself (owner, signer, non-mainnet, configured chain id, 15-minute expiry) and refuses cards asked for in group rooms. Evidence checks match whole addresses, amounts with their unit and whole token ids, and ignore the turn-time note. Unconfirmed transactions are re-verified from the alarm with a doubling cooldown, receipts back off and are abandoned or quarantined instead of retrying for ever, finished cards are pruned after 90 days, and the action-card settings are validated at boot. A recorded hash the verifier proved is another transaction may be replaced; a transaction carrying the card's memo with other messages blocks the card (`lifecycle.executionBlockedAt` on the `unknown` card; revoke is the one command it still takes). The field is additive, but the lifecycle schema is strict: a consumer pinned to an earlier build rejects a blocked card, so the Portal must pin a build with this field (this branch or the published 0.2.0) before a runtime with this change serves its cards. `MsgSend` joins the shared message catalogue.

  Topic cards (`ACTION_TOPIC_PROPOSALS_ENABLED`, v2 contract): discussion drafts and claim-access grants run as step journals with one-use permits. The switch gates claims and permits, not reads. The card expiry bounds the first step only and an hour-long execution window after the claim bounds the rest; a started step with no reference is re-permitted to the same executor; a second grant for the same account while one is in flight is refused; a grant is merged into an existing authorization only under its existing expiry; authority fingerprints cover the contract head, the pinned body and room policy, not thread activity; changed authority answers 409 and an unavailable read 503 (every authority read is typed on leaving its budget; 409 bodies carry the runtime's sentences, never schema dumps); a grant reference the verifier proved is another transaction is set aside so the right hash can replace it, while a transaction carrying the card's memo with other messages blocks the card; an object whose topic store failed to open still serves transfer cards, turns and the alarm; unreadable reference rows are quarantined, never retried every second; grant reads run in parallel. Step records and permits carry the identity-only executor (`TopicExecutorIdentitySchema`); the begin-step request adds `deviceId`. `@ixo/ixo-transaction` no longer bundles the chain SDK (peer dependency). The runtime requires a `@ixo/topic-protocol` build with precompiled validators (1.0.0-rc.8 or later); `src/core/topic-protocol-runtime.test.ts` fails the suite on a build that would generate code on Workers.

### Patch Changes

- [#381](https://github.com/ixoworld/qiforge/pull/381) [`02f293c`](https://github.com/ixoworld/qiforge/commit/02f293cc55da175cbc50d9de9939bad007306ed2) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add `hub_action_options` (service-tagged v2 discovery of the owner's
  connections and targets) and prepare Gmail connect, disconnect and one
  plain-text email send, plus signed-statement, Calendar, document-access-request
  and private-text operations, from verified channel turns. Derive the tool
  schema from action-protocol 0.4.1 (declaring protocol version 2 to Auth Hub;
  `ixo.auth-outcome/2` with terminal `expired` / `cancelled`) and retain the original-turn outcome and
  owner review boundaries. Only one Gmail send per mailbox is in flight at a time
  (authorized, submitted or unconfirmed), and a Gmail operation must name one of the
  owner's listed connections.

  Depend on the published `@ixo/action-protocol` 0.4.1 and
  `@ixo/topic-protocol` 1.0.0-rc.8 (Worker-safe validators) from npm in both
  consumers; no vendored archive or workspace override remains.

## 0.1.0

### Minor Changes

- [#343](https://github.com/ixoworld/qiforge/pull/343) [`b76ae15`](https://github.com/ixoworld/qiforge/commit/b76ae153427cd88498917747d7c471f89bc8c065) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - Batches in the `sign_transaction` contract: several catalogued messages signed in one wallet transaction, through the same action and the same Portal handler.

  - **Batch form.** `SignTransactionActionArgsSchema` takes `intent.source: 'batch'` with 1 to `MAX_BATCH_MESSAGES` (16) messages; `intent` carries the batch `summary` and each message's route in order (it must match `messages`), and a batch carries no `testnetReceipt`. The single-message form is unchanged and still exactly one message; conversational drafts (`TransactionDraftSchema`, `validateTransactionDraft`) stay single.
  - **Validation and builder.** `TransactionBatchSchema`, `validateTransactionBatch` (every message through `validateMessage`; risks are every message's catalog risks, each once; the level is the highest; with the risk gate every risk must be accepted word for word; mainnet needs `allowMainnet`) and `buildBatchSignTransactionActionArgs`. `buildSignTransactionActionArgs` now returns the narrowed `SingleSignTransactionActionArgs`.
  - **Portal.** `signIxoTransactionWithWallet` / `useIxoTransactionSigningAction` validate every message of a batch and sign them in one `transactSignX` call; one message outside the catalog refuses the whole request. No catalog entries were added: the POD Creator's messages (`MsgCreateEntity`, `MsgCreateEntityAccount`, `MsgCreateCollection`, `MsgCreateClaimAuthorization`, `MsgGrantEntityAccountAuthz`) were already catalogued and SDK-checked.

- [#212](https://github.com/ixoworld/qiforge/pull/212) [`a79a670`](https://github.com/ixoworld/qiforge/commit/a79a6700f037f5591ae82f104365d8a22ea6152e) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Add `IxoTransactionPlugin`: the agent prepares and strictly validates IXO chain transactions, and the user signs them in their Portal wallet. The oracle never signs, broadcasts or holds a key.

  - **Workers runtime.** The plugin ships with the runtime and is exported, but is opt-in: add `new IxoTransactionPlugin()` to the oracle's plugins (it is not in `BUNDLED_WORKERS_PLUGINS`). It is on-demand. Four tools: `list_ixo_transaction_routes`, `classify_ixo_transaction_intent`, `validate_ixo_transaction_draft` (reads) and `sign_ixo_transaction` (a write), which sends the hidden `sign_transaction` AG-UI action over the realtime channel (`ctx.frontend.callAgAction`) and returns `signed`, `failed` (included in a block with a non-zero code; hash and code kept), `rejected`, `error`, `timeout` (outcome unknown, so the write claim stays and the same request is not sent again), `validation_error` or `unavailable`. Every request names its chain id. Risks must be accepted word for word.
  - **Configuration.** `IXO_TRANSACTION_ALLOW_MAINNET` (`'false'` by default: mainnet drafts are refused; when `'true'`, a mainnet draft must cite the receipt the plugin recorded when the same message was signed on testnet by the same user, within 24 hours; there is no override), `IXO_TRANSACTION_CHAIN_ID_DEVNET` / `_TESTNET` / `_MAINNET` (`devnet-1`, `pandora-8`, `ixo-5`) and `IXO_TRANSACTION_SIGN_TIMEOUT_MS` (120 000 by default, at most 300 000). See `docs/ixo-transaction.md`.
  - **`@ixo/ixo-transaction`** (new package). The root export is runtime-neutral (`zod` only): the message catalog for entity, iid, claims, token and smart-account, checked against `@ixo/impactxclient-sdk@3.0.0`; intent routing from slash commands, Msg names, typeUrls and natural language; strict validation with the risk and mainnet gates; the `sign_transaction` action contract. Every nested message has a strict schema; entity-account grants take only allowlisted authorizations (generic, bank send) as structured JSON. `@ixo/ixo-transaction/react` has `useIxoTransactionSigningAction({ chainId })` for the Portal: it registers the hidden action, re-validates the message against the catalog, refuses a request for another chain than the wallet's, decodes proto-JSON with the SDK's `fromJSON` (encoding the authorization into its `Any`) and returns a JSON-safe result, reporting an included-but-failed transaction with its hash and code.

### Patch Changes

- Updated dependencies [[`a79a670`](https://github.com/ixoworld/qiforge/commit/a79a6700f037f5591ae82f104365d8a22ea6152e), [`6031b56`](https://github.com/ixoworld/qiforge/commit/6031b56ce57c14cd0f464019daeef997664837da), [`77012a8`](https://github.com/ixoworld/qiforge/commit/77012a8ef4ba6f2c5b7403635a1e6d232510cc69), [`1784717`](https://github.com/ixoworld/qiforge/commit/178471743ffb29423b4acd4b6ee58dc9881ffcc2), [`b4b395b`](https://github.com/ixoworld/qiforge/commit/b4b395ba8f1700f66d8fe7aa39081878cb63227e), [`d38f90a`](https://github.com/ixoworld/qiforge/commit/d38f90a06efaf641ae73d1e75e51464c187e3751)]:
  - @ixo/oracles-client-sdk@1.5.0
