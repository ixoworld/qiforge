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

The runner records the provider-reported part of this for every case: each
entry of `result.runs` carries the case's correctness, confidence, Brier,
latency and the response provenance (dialect, requested model, returned
model, function version, model pinning, provider artifact and method), and
`result.provenance` labels the aggregate. When the runs disagree on any of
these, the runner throws `DecisionBenchmarkProvenanceError` (with the runs and
the cases grouped by provenance) instead of averaging across backends. A
mutable backend that reports no returned model, such as `ai_decide`, cannot be
told apart this way: its result shows `modelPinning: 'mutable'` and no
`returnedModel`, so record the run date with the report.

One bakeoff scores one primitive: all cases must ask boolean questions or
all must ask choice questions (`result.primitive`), because boolean Brier
(0..1) and multiclass Brier (0..2) are on different scales; a mixed list is
refused before any provider call, as are ordinal cases (they need a
task-specific metric) and gold labels that are not a valid answer (a choice
gold that is not one of the question's options). Choice confidence is the
probability the answer gives its own `value`. Latency percentiles are
nearest-rank. One failing case aborts the bakeoff with an error naming the
case, the provider's or validator's error as its cause.

Report accuracy, Brier, ECE, selective risk at 80% coverage, and latency.
Add task-specific metrics where appropriate.

Run `buildSemanticConformanceVariants()` on the same frozen cases to measure
option permutation, opaque option ids, rubric paraphrase, no-evidence and
missing-question controls. Compare each variant with the variant it names in
`comparesWith`, map rebound option ids back through `optionIdMap`, and report
the probes listed in `notApplicable` as not run rather than as stable. Do not
tune prompts or thresholds on the final confirmation set.

Databricks must be tested as two separate assurance classes:
`databricks-systemone` (explicit Unity Gateway model service) and
`databricks-ai-decide` (managed function with mutable backend).
