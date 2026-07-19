# @ixo/oracle-worker — fail-closed compile spike

**This app is not deployable and must not be deployed.** It exists to prove
one thing: `@ixo/oracle-core` — the portable harness core (authority-kernel
primitives, transport-neutral turn seam, semantic routing, operator model
policy, signed-config/data-policy schemas) — compiles into a workerd-shaped
entry with **no Node dependencies and no `nodejs_compat`**.

Fail-closed properties, by construction:

- Boot never validates: there is no signed config envelope, no data policy,
  and no ports. Every route (including the `OracleSessionDO` stub) answers
  `503` with the refusal reason.
- **No model adapter is registered**, so no model call — billable or
  otherwise — can even be constructed. The 503 body reports the (empty)
  adapter registry.
- `wrangler.toml` deliberately omits `nodejs_compat`; portability is proven
  by the esbuild neutral-platform bundle gate
  (`pnpm --filter @ixo/oracle-worker check:neutral-bundle`), never by
  compat stubs.

The deployable adapter is Phase 5 work — see
`specs/phase-5-authenticated-config-and-cf-adapter.md` (per-oracle
Workers-for-Platforms user Workers, verified `SignedConfigEnvelope` boot,
`DataPolicy`-enforcing ports, durable HITL, Matrix feasibility decision) and
`specs/phase-6-billing-provisioning-operations.md` (reservation ledger,
settlement, provisioning ceremonies).
