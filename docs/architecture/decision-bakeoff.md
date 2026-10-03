# Decision provider bakeoff

The provider bakeoff has two layers.

## External baseline

Use the independent 37-dataset harness from
`AppliedMachineLearning-Lab/jev-benchmarking` (arXiv:2609.37647) as a
methodological baseline. It evaluates 346,009 pinned Jev requests and includes
accuracy/F1, Brier, ECE, selective accuracy, AURC, bootstrap intervals and
per-question Noul threshold tuning.

Do not vendor its response archive into QiForge. The repository code is MIT,
but the published Jev responses carry separate research/evaluation terms that
prohibit distillation/training of similar or competing models.

## IXO workload bakeoff

Use `runDecisionProviderBakeoff()` on frozen IXO-labelled
`DecisionBenchmarkCase` fixtures. The initial target is
`runtime.route-capabilities`, followed by claim/evaluation Decisions.

Every provider run should pin or record:

```text
Decision version
provider
api dialect
requested model/service
returned model
model pinning class
calibration profile
fixture dataset version
```

Report accuracy, Brier, ECE, selective risk at 80% coverage, and latency.
Add task-specific metrics where appropriate.

Run `buildSemanticConformanceVariants()` on the same frozen cases to measure
option permutation, opaque option ids, rubric paraphrase, no-evidence and
missing-question controls. Do not tune prompts or thresholds on the final
confirmation set.

Databricks must be tested as two separate assurance classes:
`databricks-systemone` (explicit Unity Gateway model service) and
`databricks-ai-decide` (managed function with mutable backend).
