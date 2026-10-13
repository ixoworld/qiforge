---
'@ixo/common': minor
---

Decision assurance: an inference dialect separate from provider identity and
per-evaluation inference provenance (requested vs. returned model, function
version, model pinning, provider artifact) on the evaluation's `judgment`;
versioned calibration profiles, with the capability router's 0.7 floor
published as a `provisional` profile; Databricks System One and `ai_decide`
adapters as distinct assurance classes (`DECISION_PROVIDER=databricks-systemone`
/ `databricks-ai-decide`); semantic-stability probes
(`buildSemanticConformanceVariants`, alongside the existing question-isolation
probe); and a provider-neutral bakeoff runner that keeps each run's provenance
and refuses to aggregate runs whose provenance differs.
