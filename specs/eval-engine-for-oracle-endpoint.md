# Engine endpoint request — `GET /v1/agents/contracts/for-oracle`

**For:** the eval-engine owner · **Consumer:** `@ixo/oracle-runtime` `oracle-payments` plugin
**Consuming code (authoritative on parsing):** `packages/oracle-runtime/src/plugins/oracle-payments/contract-record.service.ts` + `types.ts` (`ContractRecordSchema`), gate logic in `contract-gate.service.ts`.
**Why:** without this endpoint the oracle cannot map a Matrix sender to their claim collection or learn which services they contracted, so the contract gate answers `not_contracted` for everyone and no work engagement can ever start. It is the critical path for the whole Matrix-commerce feature.

---

## Request

```http
GET {EVAL_ENGINE_URL}/v1/agents/contracts/for-oracle?subscriberDid=did%3Aixo%3Aixo1user...
Authorization: Bearer <ucan invocation>
X-Auth-Type: ucan
```

- **`subscriberDid`** — the Matrix sender's DID (`did:ixo:ixo1…`), URL-encoded. This is the user whose contract is being asked about.
- **Auth** — an **oracle-signed UCAN invocation**: audience = the engine's did:web (from `EVAL_ENGINE_HOSTNAME`), resource `ixo:eval-engine`, signed with the oracle's Ed25519 claim-signing key (`setupClaimSigningMnemonics` → `createUcanTokenProvider`), i.e. the same minting path the oracle already uses for the claim bot and the same verification lane as `POST /v1/dev/link` (§G.3): verify on-chain that the invoker is the oracle entity's authorized `#orz` account.
- **The invoker identifies the oracle** — do **not** accept an oracle identifier in the query string. The pair is (invoking oracle, `subscriberDid`), so an oracle can only ever read its own contracts and a user can only be resolved against the caller.
- No body. Read-only. Safe to cache.

## Response — `200`

Exact shape the runtime validates with zod (unknown extra fields are ignored, so you can add to this freely; **every field below is required**):

```jsonc
{
  "collectionId": "42", // string — the user's oracle claim collection
  "adminAddress": "ixo1admin…", // string — collection admin (the authz granter)
  "serviceIds": ["tax-report"], // string[] — contracted service ids
  "rubricId": "sha256hex…", // string
  "cardProof": "bafk…", // string — card version the contract was approved against
  "status": "active", // string — free-form; the runtime does not branch on it
  "authz": {
    "granted": true, // boolean — a live SubmitClaimAuthorization exists
    "agentQuotaRemaining": 3, // number — claims the oracle may still submit
    "maxAmount": { "amount": "20000000", "denom": "uixo" }, // NOTE: amount is a STRING (micro-units)
    "intentDurationNs": "604800000000000", // string OR number — escrow window from the grant
  },
}
```

**Type notes that will silently fail validation if missed:**

- `authz.maxAmount.amount` is a **string** (micro-units, e.g. `"20000000"` = 20 USDC), `denom` is a string. The runtime does `Number(amount)` and compares against `Math.round(priceUsd * 1e6)`.
- `agentQuotaRemaining` is a **number**, not a string.
- `intentDurationNs` accepts **string or number** (nanoseconds).
- `collectionId` is a **string** even though it's numeric on chain.

**The `authz` block is the chain read you do on our behalf.** Query the `SubmitClaimAuthorization` grant where `granter === adminAddress`, `grantee ===` the oracle's own account address, constraints covering `collectionId`, and project out quota / `maxAmount` / `intentDurationNs`. Cache it engine-side (~5 min is fine, it matches our own TTL). This is what saves every oracle from doing its own chain query on the hot path.

- `granted: false` is a valid, useful response (contract row exists, grant revoked/expired) — the runtime reports `not_contracted` and prompts re-contracting. Prefer this over a 404 when you have a row.
- `denom` must match the collection's payment denom the portal granted in (USDC IBC on mainnet, `uixo` on devnet/testnet). A denom mismatch reads as `max_amount_too_low` on our side.

## Response — other statuses

| Status            | Meaning to the runtime                                                                 | Behavior                                            |
| ----------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **404**           | No contract for (this oracle, this subscriber) — the normal "not contracted yet" state | Cached as `null` for 5 min; gate → `not_contracted` |
| **401 / 403**     | Bad/expired invocation                                                                 | Logged, treated as `null`, **not** cached           |
| **5xx / network** | Transient                                                                              | Logged, treated as `null`, **not** cached           |

Please make **404 the "no contract" signal** (not a 200 with an empty body or `{"contract": null}`) — a 200 that fails schema validation is logged as a validation error and is much noisier to debug.

## Behavior the runtime relies on

1. **No wrapper envelope.** Return the object above at the top level — not `{ data: … }`, not `{ items: [...] }`. (The existing `/v1/agents/contracts` list endpoint returns a collection; this one is a single record.)
2. **Freshness on contract.** Right after a user contracts in the portal, the portal posts an `ixo.oracle.contracted` event into the Matrix room; the oracle treats it as an untrusted cache-buster and immediately re-queries this endpoint. So a contract registered a second ago must be visible here — don't serve it out of a long write-through cache.
3. **Idempotent + side-effect free.** It's called on the hot path of a work-classified message.

## Test vector

For a devnet oracle contracted by one user for `tax-report` at 20 USDC with unlimited quota:

```bash
curl -s "$EVAL_ENGINE_URL/v1/agents/contracts/for-oracle?subscriberDid=did%3Aixo%3Aixo1user..." \
  -H "Authorization: Bearer $ORACLE_INVOCATION" -H "X-Auth-Type: ucan" | jq
```

should yield `granted: true`, `agentQuotaRemaining: 9999999`, `maxAmount: {"amount":"20000000","denom":"uixo"}`, `serviceIds: ["tax-report"]`.

---

## Second engine change (separate, gates Wave 6 only)

**Intent support in the agent-work lane** — accept `MsgSubmitClaim{useIntent: true}` submissions end-to-end, superseding the `agent-contracts-spec.md` §C.5 "`useIntent` must be false" note and design-decision 4's no-escrow stance _for this lane_. The oracle will submit `sendClaimIntent` (escrow lock) at engagement start and then submit the claim with `useIntent: true`; approval must release escrow to the oracle and rejection return it.

**Also: pick `intentDurationNs` on the contract grant deliberately — it is the refund clock, not just a work deadline.** Verified against `@ixo/impactxclient-sdk` 2.5.1: the claims module exposes only `MsgClaimIntent` and `MsgUpdateCollectionIntents` — there is **no cancel/withdraw-intent message**. `IntentStatus` leaves `ACTIVE` exactly two ways: `FULFILLED` (a claim consumed it) or `EXPIRED` ("payments have been transferred back out of escrow"). So when a user cancels mid-job, `cancel_work` closes the engagement but **the reserved funds sit locked until expiry** — nothing can release them sooner.

That makes a long window user-hostile in the common case. Recommend roughly **2–3× the longest realistic job duration (typically 24–48 h), not a week.** The asymmetry matters: too short risks escrow lapsing mid-job on a genuinely slow task, which is recoverable (the runtime's expiry guard blocks delivery and the user can re-request); too long means a cancelled user waits days for their money back, which is not recoverable and reads as theft.

**Chain-team ask (separate, not blocking):** a `MsgCancelIntent` letting the escrowing agent voluntarily release its own `ACTIVE` intent is the only thing that makes cancellation clean. Small addition to a module that already tracks intent status.

Runtime side is already wired, and unconditionally so: the oracle always reserves at engagement start and always submits with `useIntent: true`. There is no flag — a toggle sitting between the reservation and the settlement could be flipped mid-engagement, locking escrow and then settling the claim as if none existed. That makes this engine change a **deployment prerequisite** rather than a switch to flip: an oracle running the work lane against an engine that rejects `useIntent: true` agent-work claims will strand every escrow it locks.
