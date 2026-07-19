# Phase 6 — Billing, provisioning, and production operations

Status: **specification**. Builds on the Foundation kernel (`LedgerPort`
reserve→commit/release on TokenLimiter, `TurnBudget`, AuditSink) and the
Phase 5 adapter.

## 1. Reservation ledger as a single-writer state machine

One Durable Object per (oracle, user) ledger — the single writer. Port
mapping from today's Node implementation (`token-limiter.ts` holds):

- `reserve(idempotencyKey, estimate)` → hold created; duplicate keys return
  the existing hold (idempotent).
- `commit(actual)` → delta settled through the same atomic path (negative
  deltas are refunds); shortfalls floor at zero with a warning record.
- `release()` → hold dropped.
- Every transition appends an audit record; the ledger is reconcilable
  against audit history.
- Markup/pricing constants move from source to operator config (within the
  signed envelope).

## 2. Settlement

Idempotent settlement job on a Workers cron: aggregates committed holds,
submits chain settlement (SECP/Ed25519 signing feasibility in workerd to be
proven — else the narrow Node signer service performs submission), records
receipts. Re-runs must be no-ops for already-settled batches.

## 3. Provisioning ceremonies

Operator-facing, auditable, and reversible:

1. Oracle entity creation (DID document as domain document; controllers per
   entity policy).
2. Signed config publication (envelope v1, hash-chain start).
3. Hostname→DID mapping registration (trusted mapping, never Host-derived).
4. BYOK ceremony: per-oracle gateway or broker-enforced key alias mapping —
   an oracle's config can never select another tenant's alias.
5. Matrix account ceremony (oracle identity, room policies).
6. Runtime channel selection (`stable` / `pinned@<version>`).

## 4. Key management

- Operator-owned rotation for the secrets service (the single-key TODO in
  `modules/secrets` is in scope here): versioned keys, re-encryption
  migration, revocation.
- Signing keys never leave the operator's custody boundary; the platform
  holds capability-scoped delegations only.

## 5. Operations

- SLOs per oracle (availability, turn latency, settlement lag) with error
  budgets; fault-injection suites for Matrix outage, model-provider outage,
  ledger DO migration, config-rollback.
- Fleet telemetry is an **operator-authorized inventory** (versions, health,
  policy digests) — no mandatory phone-home; the audit trail remains
  operator-owned.

## 6. Gates

- Ledger idempotency + concurrency suite (parallel reserves cannot
  overspend; commit/release races settle deterministically).
- Settlement replay suite (idempotence across restarts).
- Provisioning end-to-end rehearsal on testnet, including BYOK alias
  enforcement and hostname-mapping validation.
- Key-rotation drill with zero data loss and audited cutover.
