# Sovereignty Invariants

Normative constraints on the QiForge harness and every runtime that executes it. They exist to make the platform's value proposition structurally true: **a specialist packages their services and expertise as an agentic oracle product for which they remain liable and in control.** Liability without control is untenable; control without evidence is unverifiable. Each invariant below names its enforcement points; a change that would violate one needs an explicit revision to this document, not a quiet exception.

The central architectural rule, adopted from the sovereignty appraisal of the Foundation plan:

> Share the harness code and control-plane artifacts across the fleet, but isolate each oracle's execution, identity, credentials, state, and authority by default. A shared multi-tenant runtime is an explicitly risk-qualified optimization — not the sovereign default.

## 1. Tenant isolation by default

One oracle DID = one execution trust zone. On IXO-provisioned Cloudflare hosting, the production default is one Workers-for-Platforms user Worker per oracle (isolated execution, per-tenant CPU/subrequest limits, outbound-Worker egress control). A shared multi-tenant Worker may host only oracles that are stateless/read-only in the strong sense: no root signing key, no BYOK credential, no custom plugin code, no private checkpoint state, no write authority. Self-hosting (Node/container, or the operator's own Cloudflare account) is a first-class deployment with the identical configuration surface.

Enforcement: deployment topology (phase-5 spec); provisioning risk-qualification checklist; the portable core never assumes co-tenancy.

## 2. Least authority, enforced by the kernel

A plugin or tool touches only what its manifest permissions declare. The authorization check, credit metering, abort propagation, resource budgets, and audit append are **kernel** functions: they run for the main agent and inside every sub-agent loop, and no configuration flag — including `inheritMiddlewares: false` — can disable them. Sub-agent conveniences are policy-gated: the automated refusal retry (`onRefusal: 'retry-once'`) is valid only for sub-agents declared `readOnly` and every retry is audited; abort is terminal (a cancelled run performs no further writes, invokes no completion callbacks, and returns no tool result).

Enforcement: `SubAgentRegistry` collection-time validation; `createSubagentAsTool` abort/refusal semantics; the authority kernel (manifest permissions, attenuated `RuntimeContext`, execution broker, budgets).

## 3. Operator authority over configuration

An oracle's behavior is defined by a configuration document that is signed, content-addressed, controller-authorized, and anti-rollback protected. The host — IXO included — serves exactly what the operator published: configuration is fetched by digest, verified against the oracle entity's on-chain controllers, and never derived from an untrusted `Host` header. Runtime upgrades are consent-based: the operator's config declares `runtimeChannel: stable` (auto-follow harness releases) or `pinned@<version>`; versions are inspectable fleet-wide, never remotely mutable.

Enforcement: `SignedConfigEnvelope` schema + verification (core); phase-5 config loader (digest/signature/anti-rollback/last-known-good); hostname→DID mapping maintained as trusted data.

## 4. Data placement is policy, not habit

A signed `DataPolicy` decides where each classification of data may go: which stores (user Matrix room, VFS, R2, Durable Object SQLite, telemetry), which processors and jurisdictions, which inference paths (pooled vs BYOK), and which retention/deletion/export obligations apply. Per-user durable state (checkpoints, secrets, preferences, delegations) anchors in the user's own Matrix storage; host-side state (e.g. DO SQLite) is a cache with write-back, so leaving a host — IXO's or anyone's — carries no user-state lock-in. Gateway/provider logging defaults follow the policy, not the vendor default.

Enforcement: `DataPolicy` schema (core) consumed by storage/model/telemetry ports; checkpointer port requires export and deletion operations; phase-5 jurisdiction and logging configuration.

## 5. Transparent model authority

Model selection is operator-governed data, not framework code. Routing — role maps, semantic routes, fallbacks — selects only within the operator's declared constraint set; fallbacks are off by default and each fallback entry discloses its provider/model/residency/retention/cost deltas. Unknown model roles fail configuration validation instead of silently downgrading. Every model call produces a receipt: requested role, resolved target, actual responding model, and fallback reason. Route classification is per-turn and ephemeral — it requests capabilities, which the kernel authorizes; it never grants persistent authority.

Enforcement: model policy schema + constraint validation; provider-adapter registry with broker-resolved credentials (no config-named secrets); `model.receipt` and `route.decision` audit records; router state kept out of checkpointed graph state.

## 6. Liability requires audit, under operator control

Authority-relevant decisions — tool allow/deny, refusal retries, model receipts, route decisions, turn boundaries — are appended to an operator-owned audit trail. Records carry digests and identifiers, never raw prompt text or bare user DIDs, so the trail can be retained and shared as evidence without leaking content. Telemetry and audit are operator infrastructure: there is no mandatory phone-home; fleet inventory (runtime version, config digest, policy digest) is an endpoint the operator exposes and authorizes.

Enforcement: `AuditSink` port (`packages/oracle-runtime/src/kernel/audit.ts`) with logger + optional JSONL file sinks (`AUDIT_LOG_PATH`); record kinds are typed; free-text fields are rejected in review; OTel/ops telemetry is explicitly not the audit ledger.
