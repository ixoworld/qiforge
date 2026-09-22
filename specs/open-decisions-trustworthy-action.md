# Open Decisions: Trustworthy Decision-to-Action Profile

Status: Draft normative profile  
Version: 0.1.0  
Target: Open Decisions-compatible runtimes and providers

## 1. Scope

This profile defines the minimum interoperability and safety requirements for turning bounded semantic judgments into authorized actions.

It is intentionally provider-neutral. A conforming runtime may obtain semantic judgments from Jev, SemIf, Laya, a classifier, a reasoning model, deterministic logic, a human evaluator, or another implementation, provided the requirements below are met.

This profile standardizes the transition:

```text
Evidence → Semantic Judgment → Decision Policy → Authority → Action
```

It does not standardize a particular model, prompt, chain, payment rail, credential format, or application policy.

## 2. Normative language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as normative requirements.

## 3. Core model

A conforming implementation MUST preserve five logically distinct layers.

### 3.1 Evidence

Evidence is the state, observations, claims, references, documents, tool outputs, or other inputs that ground a judgment.

A runtime:

- MUST define the evidence projection supplied to the semantic evaluator;
- MUST NOT silently add execution authority to evidence;
- SHOULD minimize disclosed evidence to what is necessary for the bounded question;
- SHOULD identify externally referenced evidence by stable digest, URI, credential identifier, or equivalent reference when the downstream consequence is material.

### 3.2 Semantic Judgment

A semantic judgment is a bounded evaluation over a declared outcome space.

A semantic evaluator:

- MUST operate over an explicitly declared finite question or outcome space;
- MUST return structured output;
- MUST NOT execute side effects;
- MUST NOT grant authority by virtue of model confidence, probability, score, or selected outcome;
- MUST expose provider and model provenance;
- MUST preserve probability distributions when available;
- MUST distinguish probability-like values from provider-specific confidence or concentration values.

A runtime MUST reject malformed outputs rather than inventing a semantic answer.

### 3.3 Decision Policy

Decision policy deterministically interprets one or more semantic judgments together with explicit thresholds, rules, preferences, weights, constraints, escalation rules, or other application logic.

Decision policy:

- MUST be represented separately from the semantic evaluator;
- MUST define how uncertainty is handled;
- MUST define abstention, escalation, fail-open, or fail-closed behavior where consequential actions are possible;
- MUST NOT infer authority from a semantic evaluator response.

For MCDA-style decisions, semantic estimates and stakeholder preference weights MUST remain logically distinct. A provider-generated criterion estimate MUST NOT be treated as a stakeholder preference unless explicitly supplied as such.

### 3.4 Authority

Authority determines whether an actor or system is permitted to perform the selected action.

Authority checks:

- MUST be independent from semantic confidence;
- MUST evaluate the actual actor, capability, mandate, contract, policy, approval, credential, or equivalent authorization required for the action;
- MUST occur against the final action subject defined in Section 4;
- MUST fail closed when a required authorization cannot be established.

Examples include UCAN capabilities, contract gates, human approvals, organizational policy, payment mandates, wallet controls, and chain permissions.

### 3.5 Action

The action is the final side effect: a tool call, transaction, payment, credential issuance, state transition, resource allocation, or equivalent execution.

A conforming runtime:

- MUST NOT mutate the authorized action after the final authority decision without invalidating the authorization;
- MUST NOT reuse a decision authorization for a materially different action subject;
- SHOULD emit an auditable receipt binding the decision, policy, authority, and executed action.

## 4. Final Decision Subject

The object evaluated for consequence MUST be the same object that is authorized and executed.

Before any consequential action, the runtime MUST derive a canonical Final Decision Subject (FDS).

The FDS MUST contain enough information to distinguish materially different executable actions. At minimum it SHOULD include:

```ts
interface FinalDecisionSubject {
  kind: string;
  action: unknown;
  evidenceRefs?: string[];
  policyRef?: string;
  context?: Record<string, unknown>;
}
```

The runtime MUST compute a deterministic digest over a canonical representation of the FDS:

```text
subjectDigest = HASH(CANONICALIZE(FinalDecisionSubject))
```

The digest algorithm and canonicalization method MUST be declared by the implementation.

Any decision receipt, authorization, approval, or downstream credential used to permit execution MUST bind to `subjectDigest`.

If any material field of the FDS changes after judgment or authorization, the previous decision/authorization MUST be considered stale and MUST NOT authorize execution.

This requirement exists to prevent:

```text
approve(A) → mutate(A → B) → execute(B)
```

## 5. Judgment result semantics

A provider-neutral result SHOULD distinguish at least:

```ts
interface SemanticJudgmentResult {
  outcomes: Record<string, number>;
  selectedOutcome?: string;
  provider: string;
  model: string;
  modelVersion?: string;

  confidence?: {
    value: number;
    semantics: string;
  };

  calibration?: {
    method: string;
    workload?: string;
    version?: string;
    evaluatedAt?: string;
    ece?: number;
    brier?: number;
  };
}
```

Requirements:

- `outcomes` MUST describe the declared outcome space when the provider exposes a distribution.
- `selectedOutcome` MUST be optional.
- A confidence value MUST NOT be assumed to be a calibrated probability unless its semantics explicitly state that.
- Calibration metadata MUST identify the workload or evaluation domain when calibration is workload-specific.
- Runtimes MUST NOT compare confidence values across providers unless their semantics are known to be comparable.

## 6. Decision receipt

Consequential decisions SHOULD produce a Decision Receipt.

A receipt SHOULD contain:

```ts
interface OpenDecisionReceipt {
  decision: {
    name: string;
    version: string;
  };

  subjectDigest: string;

  judgment: {
    provider: string;
    model: string;
    modelVersion?: string;
    evaluatedAt: string;
  };

  evidenceRefs?: string[];
  policyRef?: string;

  result: {
    outcome?: string;
    disposition: 'allow' | 'deny' | 'abstain' | 'escalate';
  };

  authority?: {
    mechanism: string;
    reference?: string;
  };

  execution?: {
    actionDigest: string;
    executedAt?: string;
    reference?: string;
  };
}
```

If the receipt includes an executed action, `execution.actionDigest` MUST equal the digest of the executed canonical action subject and MUST remain compatible with `subjectDigest`.

A receipt MUST NOT imply that semantic evaluation itself provided authority.

## 7. Middleware and composition invariant

Any component that can alter the executable action MUST run before the final subject binding and authority check, or MUST force those steps to be repeated.

Conforming composition:

```text
intent
  ↓
action construction
  ↓
argument enrichment / mutation
  ↓
canonical Final Decision Subject
  ↓
semantic judgment
  ↓
decision policy
  ↓
authority
  ↓
execution
```

Non-conforming composition:

```text
semantic approval
  ↓
action mutation
  ↓
execution using stale approval
```

Middleware frameworks MUST document where mutation is permitted and where final subject binding occurs.

## 8. Adversarial and robustness requirements

For a decision provider or runtime to claim conformance for consequential use, its test suite MUST include:

1. malformed-provider-output rejection;
2. option-order permutation tests for finite choice questions;
3. semantically equivalent paraphrase tests;
4. adversarial state / prompt-injection tests where untrusted text may enter evidence;
5. stale-subject tests proving post-approval mutation invalidates authorization;
6. provider timeout and unavailable-provider behavior;
7. abstention/escalation behavior at policy boundaries;
8. provenance preservation;
9. evidence-minimization checks where sensitive state exists;
10. middleware-order tests when downstream components can alter actions.

Where multilingual traffic is in scope, the conformance suite SHOULD include representative language/script robustness tests.

## 9. Open Decisions conformance levels

### OD-J: Judgment Conformant

A system is OD-J conformant when it:

- exposes a finite declared outcome space;
- returns typed semantic judgments;
- validates result shape;
- exposes provider/model provenance;
- does not execute side effects.

### OD-P: Policy Conformant

OD-P requires OD-J plus:

- explicit decision policy;
- declared uncertainty handling;
- abstain/escalate behavior;
- separation of semantic estimates from preferences and authority.

### OD-A: Action Conformant

OD-A requires OD-P plus:

- Final Decision Subject canonicalization;
- subject digest binding;
- independent authority checks;
- stale-subject invalidation;
- execution receipt binding the executed action to the authorized subject.

A system MUST NOT claim OD-A conformance if semantic model confidence is itself treated as execution authority.

## 10. Application profiles

### 10.1 Decision to Pay

A conforming Decision-to-Pay flow SHOULD preserve:

```text
Claim
  ↓
Evidence
  ↓
Semantic judgments
  ↓
Rubric / policy
  ↓
allow | deny | abstain | escalate
  ↓
Payment authority
  ↓
final payment subject digest
  ↓
settlement
```

A payment authorization or UDID-like artifact SHOULD bind to the final payment subject digest.

### 10.2 Decision to Treat

A conforming Decision-to-Treat flow SHOULD separate:

- diagnostic or risk estimation;
- treatment/resource-allocation policy;
- professional or institutional authority;
- the final treatment/resource action.

A model-estimated probability MUST NOT be represented as clinical or institutional authority.

### 10.3 Decision to Buy

A conforming Decision-to-Buy flow SHOULD separate:

- product/outcome estimates;
- explicit user preferences and constraints;
- recommendation/selection policy;
- spending authority;
- final purchase subject.

Preference weights MUST originate from the principal or an explicitly authorized preference source.

### 10.4 MCDA

A conforming MCDA profile SHOULD preserve uncertainty through criterion evaluation where practical.

Recommended sequence:

```text
evidence
  ↓
criterion outcome distributions
  ↓
principal preference weights
  ↓
MCDA aggregation / sensitivity
  ↓
decision policy
  ↓
abstain / escalate / select
```

The runtime SHOULD avoid prematurely collapsing distributions to crisp scalar scores when downstream sensitivity analysis can consume the distributions directly.

## 11. QiForge mapping

QiForge currently maps to this profile as follows:

| Open Decisions layer | QiForge primitive |
| --- | --- |
| Evidence | `DecisionDefinition.project()` |
| Semantic Judgment | `DecisionAdapter.evaluate()` |
| Decision Policy | deterministic plugin/application code |
| Authority | contract gates, UCANs, human or policy controls |
| Action | tool, Flow, payment, chain transaction, engagement start |

Current QiForge Decisions are closest to OD-J.

The next implementation step toward OD-A is to add a canonical Final Decision Subject and subject digest at consequential action boundaries, then bind policy/authority receipts to that digest.

## 12. Non-goals

This profile does not:

- require Jev or any other provider;
- require blockchain settlement;
- require W3C Verifiable Credentials;
- define a universal confidence threshold;
- define a universal MCDA method;
- allow semantic models to self-authorize;
- mandate that every bounded judgment be delegated to a model.

## 13. Design rule

The central interoperability rule is:

> Semantic judgment may inform a consequence, but only explicit policy and independent authority may permit an action, and that permission must bind to the exact action that is executed.
