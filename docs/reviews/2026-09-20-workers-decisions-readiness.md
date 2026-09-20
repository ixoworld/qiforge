# Workers Decisions readiness audit — 20 September 2026

## Verdict

The original PR stack is **not production-ready for Companion Workers**. This hardening branch closes the shared-runtime and provider implementation gaps and passes the local release audit. Live activation remains blocked by provider configuration/access, package publication and deployed end-to-end evidence. It does not claim Workers commerce or payment parity.

## Source snapshots

| Source                                                                                                                    | Audited head                               | Role                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| [QiForge #309](https://github.com/ixoworld/qiforge/pull/309)                                                              | `4effb9f20b0bfb8ca4f737345af23b8271ce8d5f` | Decision primitive                                   |
| [QiForge #311](https://github.com/ixoworld/qiforge/pull/311)                                                              | `82c2c32b6b29bce9b96c4f3aa31b93d3574e3e91` | Cloudflare Jev adapter; stacked on #309              |
| [QiForge #312](https://github.com/ixoworld/qiforge/pull/312)                                                              | `ecc8b4e688278fe96d4b99c5880bfc38880f4e19` | Node commerce shadow; stacked on #311                |
| QiForge main                                                                                                              | `85d94ae4`                                 | Current Workers 0.13.0 / Matrix SDK 0.7.0 baseline   |
| [Companion #239](https://github.com/ixoworld/companion/pull/239)                                                          | `bc6962c44829d0981bb461a185b1aa8f0e6817d6` | Latest Workers implementation and deployment configs |
| [OpenRouter official SDK](https://github.com/OpenRouterTeam/typescript-sdk/tree/1a09de8a9749c72450bade8a373ed2120a2865c0) | `1a09de8a9749c72450bade8a373ed2120a2865c0` | Dedicated alpha Decisions wire contract              |

All three original PRs were open with passing Build and Lint checks at inspection. That workflow did not persistently run the new behavior tests. Existing review comments were read and checked against source, including the two unresolved #312 race findings.

## Findings and changes

| Severity            | Finding                                                                                                                                         | Resolution in this branch                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1                  | #309 registers Decisions only in Nest/Node. Workers has no registration hook, evaluator or turn-context binding.                                | Extracted lightweight `@ixo/decisions` with Zod/Web API dependencies; Node/common retain compatibility exports. Workers collects loaded-plugin Decisions, validates collisions and exposes a turn-scoped evaluator. |
| P1                  | #311 has no OpenRouter transport; Jev cannot use the ordinary OpenRouter chat endpoint.                                                         | Added the official `POST /api/alpha/decisions` contract, versioned Jev model selection, explicit provider configuration, no fallback and requested data-collection denial.                                          |
| P1                  | Abort only signals an adapter; a non-cooperative adapter can return a successful answer after cancellation. Timeout overrides are unvalidated.  | Runtime cancellation wins independently, pre-aborted calls never invoke the adapter, owning-turn cancellation cannot be replaced, timeouts are bounded, and outstanding work has an admission limit.                |
| P1                  | #311 retains raw fetch/JSON parser causes and arbitrary string error codes, which may contain private data. It reads unbounded response bodies. | Safe error messages without causes, numeric-only Cloudflare codes, cancellation sanitization, 256 KiB streaming response cap, HTTPS endpoint validation and redirect rejection.                                     |
| P1                  | #312 can leave a rejected shadow promise unhandled while awaiting its slower classifier.                                                        | Rejection handling attaches immediately; failures become inert telemetry. A regression deliberately holds the classifier pending.                                                                                   |
| P1                  | #312 inserts a turn into the in-flight map after awaited routing; supersession cannot cancel routing.                                           | Registration precedes routing inside the cleanup scope; aborted turns cannot start delivery. Added cancellation checks before routing consequences and a routing-phase supersession regression.                     |
| P2                  | Only state is byte-bounded; question instructions can be arbitrarily large. Direct adapter users can receive out-of-contract probabilities.     | Complete request cap, JSON-only projected state, declared-kind validation, and validation at both adapter and evaluator boundaries.                                                                                 |
| P2                  | Mutable adapter input can alter the contract used for result validation. Same-plugin duplicate names are accepted.                              | Snapshot separation and duplicate rejection; successful evaluations also carry projected-request SHA-256 provenance.                                                                                                |
| P1 for deployment   | The PR stack carries Workers 0.12.0 / Matrix SDK 0.4.0, but current Companion uses 0.13.0 / 0.7.0.                                              | Incorporated current main's Workers gateway/config changes and SDK versions; bundled Companion's actual PR #239 entry against the hardened runtime.                                                                 |
| Open scope boundary | #312's commerce plugin, legacy classifier, contract gate and engagement machinery do not exist in Workers or Companion.                         | Explicitly documented as unsupported. No synthetic commerce/payment implementation or authority was added.                                                                                                          |

The existing bridge test double omitted the real `workStatusProducer.endTurn` method, causing supersession tests to fail before cleanup could settle. The double now implements that actual interface; assertions were retained.

## Reusable verification artifact

Run [scripts/audit-workers-decisions.mjs](../../scripts/audit-workers-decisions.mjs):

```sh
node scripts/audit-workers-decisions.mjs --release
node scripts/audit-workers-decisions.mjs --live=cloudflare-jev
node scripts/audit-workers-decisions.mjs --live=openrouter-jev
```

The default audit is wired into CI. `--release` adds root lint and formatting. Live probes fail on missing credentials, use fixed fictional content and make no payment, chain or Matrix writes. Provider configuration and operating boundaries are in the [Workers Decisions guide](../../packages/oracle-runtime-workers/docs/decisions.md).

## Verified local evidence

| Lane                                                                                | Result                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Workspace build and declarations                                                    | Passed, 12 build targets                                   |
| Shared provider / failure-boundary suite                                            | 39 passed                                                  |
| Existing provider-neutral contract suite                                            | 6 passed                                                   |
| Node compatibility, registry and commerce shadow suites                             | 104 passed (including 15 turn-context compatibility tests) |
| Workers typecheck                                                                   | Passed                                                     |
| Workers core suite                                                                  | 332 passed in 45 files                                     |
| Actual workerd boot / Decisions integration                                         | 9 passed in 2 files                                        |
| Reference Worker dry-run                                                            | Passed; compressed bundle approximately 5,557 KiB          |
| Companion #239 devnet, testnet and mainnet dry-runs with hardened workspace runtime | Passed; no deployment                                      |
| Root lint                                                                           | Passed; existing warnings remain                           |
| Root format check and whitespace check                                              | Passed                                                     |

Counts are per lane, not unique coverage totals. Mocks establish provider wire conformance and failure behavior; they do not establish live model access, accuracy, privacy guarantees, rubric calibration or signed IXO decision conformance. No package release, deployment, chain execution or payment occurred during this audit.

## Live evidence and remaining gates

Read-only checks inspected the live `ixo-companion-devnet`, `ixo-companion-testnet` and `ixo-companion-mainnet` oracle Worker settings. Each has an `OPEN_ROUTER_API_KEY` secret; none has a `DECISION_PROVIDER` selector, `CLOUDFLARE_API_TOKEN`, Cloudflare Jev account/gateway binding or OpenRouter Jev model selector. Secret values were not retrieved.

A Cloudflare Jev REST probe using the existing operator OAuth session and fictional content returned **HTTP 402, numeric error code 2021**. It did not produce a successful semantic evaluation. The exact account access/billing condition must be resolved with Cloudflare before activation. This observation is not evidence that a separately provisioned production AI token will succeed or fail.

The OpenRouter live probe remains unrun: the key exists as a deployed Worker secret, and its value is unavailable to the local test runner. The existing generative-model key's presence does not prove Jev endpoint/model access or acceptance of the requested provider privacy policy.

Before a production readiness claim:

1. Resolve Cloudflare access and provision the chosen provider credentials on the oracle Worker; set the provider selector explicitly.
2. Run both live probes with deployment-equivalent credentials and record returned model versions/usage.
3. Publish `@ixo/decisions`, release the updated runtime packages using the included changeset, and update Companion's package pin/lockfile. Preserve its gateway split, DO migrations and `TopicChatDO` export.
4. Validate an authenticated staging turn through the deployed Companion Worker with cancellation, scoped projection and provider failures. Retain IXO policy thresholds, review/error handling, authority and settlement as separate gates.
5. Treat commerce-shadow parity as separate work requiring real Workers contract/engagement integration. No environment toggle can enable an absent commerce lane.

Companion #239 also contains an empty `TopicChatDO` compatibility class to preserve a deployed namespace whose implementation is absent from that branch. This audit preserves it and does not establish that feature's runtime behavior. Review that existing source/deployment discrepancy before a broader Companion production promotion.
