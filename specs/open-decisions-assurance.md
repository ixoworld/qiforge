# Open Decisions Assurance Profile

Status: Draft  
Version: 0.2.0

This profile separates a Decision's semantic contract from the external
inference transport that executes it.

## Inference dialect

A provider MUST identify the wire/API dialect independently from provider and
model identity. QiForge currently recognizes:

- `systemone-v1` — state + Noul/Choice/Score questions + distributions;
- `databricks-ai-decide-v1` — Databricks managed decision function;
- `openai-decisions` — reserved until OpenAI publishes a stable public
  Decisions contract;
- `native-classifier`;
- `custom`.

Supporting a dialect does not imply that two providers are epistemically
equivalent.

## Provenance

A consequential Decision SHOULD record:

```text
provider
apiDialect
requestedModel
returnedModel
functionVersion
modelPinning
providerArtifactRef
calibrationProfileRef
```

`requestedModel` and `returnedModel` MUST remain distinct. A model service
or managed function MAY route to a backend different from the requested
service. Function/API version MUST NOT be represented as model version.

If the backend model may change without the Decision definition changing,
`modelPinning` MUST be `mutable` or `unknown`, never `pinned`.

## Calibration profile

A probability emitted by a provider is evidence, not an action threshold.
Thresholds for consequential decisions MUST be carried by a versioned
`DecisionCalibrationProfile`, scoped at minimum to:

- provider/model artifact;
- Decision name and version;
- primitive/question;
- validation dataset and target population when validated;
- threshold or mapping;
- calibration/selective-risk metrics;
- validity date.

A profile with no held-out validation MUST be marked `provisional`.
Applications MUST NOT describe a provisional threshold as calibrated.

This rule applies equally to language decision models and non-language decision
heads. PathGen genome decision heads, for example, should use the same
CalibrationProfile artifact for lineage/AMR/novelty policy thresholds rather
than embedding a universal 0.5 cutoff in model code.

## Assurance classes

A pinned model-service request and a managed function are different assurance
classes even when they share question syntax.

For Databricks:

- Unity Gateway `/ai-gateway/typesafe/v1/systemone` records the requested
  model service and returned backend model separately.
- `ai_decide` pins function API version while Databricks may change the
  underlying model; its model pinning is therefore `mutable`.

Consequential policy MAY require a pinned/identified backend or escalate when
model identity is unknown.

## Semantic conformance

Provider qualification SHOULD include at least these independent probes:

1. option-order permutation;
2. semantic option-id rebinding to opaque identifiers while preserving
   descriptions;
3. semantically equivalent rubric/question paraphrase;
4. no-evidence and missing-question controls.

Passing schema validation is not semantic conformance. Thresholds for acceptable
drift are workload-specific and SHOULD be fixed before the final evaluation.

## Provider bakeoff

IXO provider comparisons SHOULD report workload-specific:

- accuracy/F1 as appropriate;
- Brier score and ECE;
- selective risk at fixed coverage;
- latency p50/p95;
- semantic-conformance drift;
- cost;
- pairwise error correlation where ensembles are considered.

The independent Deußer/Sparrenberg/Sifa Jev harness
(`AppliedMachineLearning-Lab/jev-benchmarking`, arXiv:2609.37647) is the
external baseline for public-dataset methodology. Its code is MIT-licensed,
while its published Jev responses have separate research/evaluation terms and
MUST NOT be used for distillation or training competing models.
