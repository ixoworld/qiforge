# Observe-only domain context

The oracle uses its own anchored domain documents for constitutional guidance and the selected subject's documents for task context. The live IID `#dom` proof owns the anchor; Blocksync is the resolver's read projection. Anchor lookup has a five-minute cache, an explicit refresh, concurrent-request deduplication and per-turn revision pinning. Invalid bytes are excluded. Stale fallback is labelled, and confirmed replacements/removals invalidate the previous active binding.

This rollout observes failures without introducing new operational tool blocks or granting authority. Existing capability checks remain authoritative. Context loading is bounded and progressively disclosed. Public content caches by CID; private reads use live supported storage authorization and are not content-cached. Domain selection may be explicitly cleared with null.

Capsules are optional static inspections only. The manifest's CID and SHA-256 are verified and release/compatibility/Master references are reported with unresolved checks. No Master artifact is loaded, no runtime or skill is executed, and no capability becomes active. A difference between the capsule's oracle revision and the selected IID anchor is a finding, not an implicit release activation.

## Delivery

This change builds on Qiforge PR #297 and depends on domain.md PR #33. Companion adopts it in a separate PR on its Workers branch stack. The source dependency is pinned until an approved package release exists. Package publishing, deployments, constitutional document publication, full live-authority conformance and capsule activation are outside this delivery.

The configured Companion devnet IID had no `#dom` resource on inspection. Operational deployment needs a separately authorized document publication and anchor; the feature itself remains usable for any selected domain with supported, conforming documents. Private VFS reads have a built-in UCAN adapter. Other private transports, including encrypted Matrix documents, use an explicitly supplied authorizing host reader; unsupported routes remain unavailable.

## Verification

Shared validator tests and packed-package smoke; real workerd domain/cache/access/capsule tests; main/core regressions; null-clearing metadata coverage; typecheck, lint and formatting; and Companion gateway/oracle dry-run bundles. Provider-dependent behavioral evaluations and anchored private-domain end-to-end checks remain rollout gates rather than claimed results.
