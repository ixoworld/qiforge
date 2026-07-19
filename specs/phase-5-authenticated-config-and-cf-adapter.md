# Phase 5 — Authenticated configuration + the isolated Cloudflare adapter

Status: **specification** (Foundation ships the schemas and the fail-closed
compile spike; nothing here is implemented yet). Normative baseline:
`specs/sovereignty-invariants.md`. Schemas already in
`@ixo/oracle-core/config` — `signedConfigEnvelopeSchema`, `dataPolicySchema`.

## 1. Configuration is authority-bearing state

`getSettingsResource` (oracles-chain-client) remains a lookup helper — it is
NOT the control-plane loader. The loader this phase builds:

- Accepts only `SignedConfigEnvelope` documents: schema-validated, content
  digest recomputed and compared, issuer authority derived from the oracle
  entity's controller policy (NOT mere presence in a `controller` array),
  expiry honoured.
- **Anti-rollback**: rejects any `configVersion` lower than the highest
  accepted for the oracle; keeps an auditable last-known-good and falls back
  to it (with an audit record) when a fetched document fails verification.
- Fetch hygiene: allowed schemes/origins list, response size limits,
  content-address verification before parse, timeouts.
- **Identity is never derived from an untrusted `Host` header.** A trusted
  hostname→DID mapping (provisioned in Phase 6) selects the oracle; the
  envelope's `oracleDid` must match it.
- Every turn receipt carries provenance: config digest, policy digest,
  runtime version (`model.receipt` and `turn.start` audit records reserve
  these fields today).

## 2. Tenancy: one Workers-for-Platforms user Worker per oracle DID

The production IXO-hosted default is **isolated execution per oracle DID**
(Workers for Platforms user Workers): per-tenant limits, per-tenant secrets,
outbound-Worker egress policy (hostname allowlists + centrally attached
credentials).

The shared multi-tenant Worker is a **risk-qualified exception**, permitted
only when ALL hold: stateless/read-only oracle; no root signing key; no BYOK
credential; no custom plugin code; no private checkpoint state; no write
authority. A checklist review recorded in the provisioning audit is required
to enable it.

Self-hosting stays first-class: the Node/container adapter
(`@ixo/oracle-runtime`) and an operator-owned Cloudflare deployment are both
supported exits; "operator-owned Cloudflare" alone is not the no-lock-in
story.

## 3. State: Durable Objects as cache, Matrix as durable anchor

- DO namespace keyed by **oracle + user + thread** (composite), never user
  alone. DO jurisdiction tags set from `DataPolicy.permittedJurisdictions`.
- The user's Matrix room remains the durable anchor for user state;
  DO SQLite is a cache with an export/exit story (CheckpointerPort `export`
  - `delete` are mandatory operations).
- Hibernatable WebSockets: identity + subscription state serialized into DO
  storage and REVALIDATED after wake (hibernation clears memory).
- AI Gateway logging is **off by default**; enabling it requires the
  DataPolicy's `logging` block to permit it. Zero-data-retention applies to
  unified billing, not BYOK — treat them independently.

## 4. HITL is a durable approval state machine

Not a 15-second RPC. Approvals are records with: expiry measured in minutes
to hours, replay protection (single-use nonces), explicit cancellation, and
resumption after Worker/DO restarts. The turn seam's frame sequence numbers
let a resumed client detect gaps.

## 5. Matrix-on-Workers is a feasibility spike, not an assumption

Matrix E2EE needs persistent crypto state, device keys, `/sync`, Olm/Megolm
sessions, and key recovery (WASM Rust crypto in the JS SDK). The initial
adapter is therefore a **narrow, UCAN-protected Node Matrix service** the
Worker calls; a Worker-native crypto store is adopted only after
compatibility and recovery testing decides the spike.

## 6. Gates for calling this phase done

- Envelope verification suite: signature/UCAN authority, digest mismatch,
  expiry, anti-rollback, last-known-good fallback.
- Tenant-isolation tests: two oracle DIDs on one dispatch layer cannot read
  each other's DO state, secrets, or credentials.
- workerd contract tests (vitest-pool-workers) for the adapter's ports; the
  neutral-bundle gate stays mandatory. `wrangler deploy --dry-run` is a
  smoke check, never the portability proof.
