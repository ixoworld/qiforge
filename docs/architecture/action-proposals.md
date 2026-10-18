# Validated conversational action proposals

This capability prepares a native IXO or impact-credit transfer from the authenticated conversation. It persists an immutable proposal in the owner Durable Object, returns a short Portal review link, and requires the owner to confirm and sign in their existing wallet.

The capability is default off. Set `ACTION_PROPOSALS_ENABLED=true` only after the release gates in IXO-5609 pass. Configure `ACTION_PROPOSALS_PORTAL_ORIGIN` as the existing HTTPS Portal origin. Deploying or enabling this feature is a separate operator action.

## Trust and lifecycle

The canonical `@ixo/ixo-transaction/action-proposals` contract binds the owner, session, run, invocation, action version, exact signable inputs, signer, targets, network, evidence references, and absolute expiry. It uses the existing `ixo-json-v1` canonicalization and SHA-256 implementation. `@ixo/common/ai/decisions` reexports those same primitives for compatibility. Lifecycle changes do not change the action digest.

`prepare_action` accepts only server-owned transfer schemas. It derives the signer from the authenticated account DID. It requires exact amount and recipient evidence in at most eight current-session human messages, then asks the bounded `companion.action-intent` Decision whether the latest user message requests that exact action. This supports a later confirmation referring to earlier user values. The 0.95 confidence gate is provisional policy, not calibrated accuracy or proof of intent. Missing evidence, negation, ambiguity, provider failure, and unsupported identity resolution require clarification. Mainnet preparation remains disabled.

The unique invocation identifies retries. A repeated invocation returns its original immutable proposal. A fresh invocation can prepare the same transfer deliberately. An atomic claim consumes a prepared proposal once. Reject, revoke, supersede, expiry, digest mismatch, and prior consumption refuse signing. Unknown effects remain consumed.

HTTP reads and lifecycle commands use the existing authenticated owner UCAN routes under `/action-proposals/:id`. Responses use `private, no-store`. The opaque `/a/ap_<uuid>` URL locates a proposal and grants no authority. The renderer can be cached as static assets. User-specific proposal state cannot use a shared cache.

`POST /action-proposals/:id/reconcile` accepts only an optional transaction hash. It cannot accept a claimed success, status, amount, or receipt. The server queries its configured `ACTION_PROPOSALS_RPC_TESTNET`, `ACTION_PROPOSALS_RPC_DEVNET`, or `ACTION_PROPOSALS_RPC_MAINNET` HTTPS base URL, including a `/rpc/` path when needed. It checks chain ID, included transaction hash, exact protobuf message bytes and memo, and the chain's result code and height. Missing configuration or an unindexed transaction preserves unknown status.

Completed `/channels/turn` polls expose only proposal outcomes belonging to that authenticated owner's original session and run. They retry at most one recorded transaction lookup per poll, with a persisted 30 second cooldown. They never broadcast again. Verified receipts are mirrored to the originating channel thread using a stable Matrix transaction ID and durable retry through the owner alarm. Disabling preparation keeps reads, reconciliation, outcome polling, and receipt delivery available.

## Initial scope and release gates

Native bank transfer and impact-credit transfer are supported. Topic creation and topic access grants return an explicit clarification. They need a registered adapter that resolves current Matrix state, freezes exact grants and participants, proves room authority, and executes the same confirmed subject. A browser-declared tool schema does not supply those guarantees. These acceptance cases remain open in IXO-5609.

The automated tests cover schema and digest mutation, owner isolation, expiry, concurrent claims, restart persistence, repeat intent, malformed and unavailable Decisions, current-session confirmation context, ordered channel references, chain mismatch, transaction mismatch, and verified scoped outcomes. Workerd tests exercise the actual Durable Object SQLite implementation. Provider answers and chain HTTP responses in tests are fixtures.

Before activation, record successful selected-provider verification under ORA-511, evaluate a versioned workload of conversational requests, and prove real mobile wallet and WhatsApp round trips. Record exact package and deployment revisions, cold and warm latency, operator-reviewed screenshots and recordings, duplicate-delivery recovery, delayed chain indexing, and wallet-disconnection recovery. Those live gates cannot be inferred from unit tests.
