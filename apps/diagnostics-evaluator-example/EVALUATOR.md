# Closing the loop: an evaluator oracle

A walkthrough of `apps/diagnostics-evaluator-example` — the oracle that determines the fault claims `apps/agentic-asset-example` submits.

Read [`../agentic-asset-example/ASSET-TWIN.md`](../agentic-asset-example/ASSET-TWIN.md) first. That app ends with a vehicle that can claim a fault and cannot determine one. This is where the determination comes from.

## Why a second entity, not a second capability

The vehicle's constitution denies it the ability to evaluate its own claims, and every control downstream of that — the vendor allowlist, the value ceiling, the upheld-determination condition — assumes a determination it does not control.

A denial is only worth what the alternative is worth. If the determination came from the same process under a different label, the separation would be a naming convention. It has to be a different principal, under a different constitution, holding a capability the first one is denied.

That is the whole reason this is a separate app rather than another tool in the vehicle's plugin.

## The symmetry

|                         | Vehicle (`asset`)     | Evaluator (`oracle`)      |
| ----------------------- | --------------------- | ------------------------- |
| Submit a fault claim    | **allowed**, one type | **denied**                |
| Determine a fault claim | **denied**            | **allowed**, credentialed |
| Book and pay            | allowed, bounded      | above its ceiling         |
| Mode ceiling            | `bounded_execute`     | `bounded_evaluate`        |

Both documents carry an explicit `deny` for the half they must not hold. A deny that depends on someone else's document is not a control, it is a hope.

## Three things worth copying

**The ceiling is the primary statement.** `bounded_evaluate` means acting is refused before any grant is consulted. Upholding a claim releases someone else to spend, and an evaluator that could also act could pay itself by finding in its own favour. Keeping the capability out of reach entirely beats granting it narrowly, and here it costs nothing.

**Evaluation authority is credentialed.** `credential_required: 'vc:fleet-diagnostics-evaluator'` makes the capability a grant the collection issues and can revoke, not a property of who the oracle is. Revoke it and the oracle keeps its identity, memory and constitution — and stops being able to determine anything. That is what makes an evaluator market possible rather than an evaluator monopoly.

**A determination must cite its rubric.** `determination_without_rubric` is a forbidden output; the rubric is versioned, and `authority_scopes` puts it under the collection rather than under `domain_md`. A verdict with no stated standard cannot be audited or appealed. Where the rubric does not cover a case, `inconclusive` is the honest outcome — and the loop treats it as a real result, sending the vehicle back to gathering evidence instead of forward to spending.

## The loop test

`test/loop.test.ts` is the only test in this repo that loads two constitutions at once, because the property it checks lives in neither alone:

> No principal can both generate a claim and determine it.

A single document can assert that about itself and be wrong about the other side. The test loads both documents as the apps actually ship them and walks the loop in order — sense, claim, determine, book, pay — asserting at each step both what is permitted and which shortcut is refused:

- Acting on an observation with no determination → denied.
- The vehicle determining its own claim → denied by its deny grant.
- The evaluator determining it → permitted, with the credential.
- The evaluator paying, transferring, or booking → denied by its ceiling.
- The vehicle booking against the upheld determination → permitted.
- The vehicle paying → **escalates**, then permits once a human approval is bound to that exact request.

If either document drifts, this fails.

## Something the test found

The evaluator's deny on submitting claims never fires. The `bounded_evaluate` ceiling refuses every `write` first, so the grant beneath it is shadowed.

It is not dead code — it is the backstop for a revision that raises the ceiling, at which point it becomes the thing that still keeps the evaluator out of the collection it judges. But the test now says which mechanism actually refuses today, and a second test raises the ceiling to prove the backstop bites. Asserting the outcome without asserting the mechanism would have hidden the fact that one of the two controls was doing nothing.

## What is stubbed

`EvaluatorState` is in-memory: claims, the rubric, and issued determinations. A deployed evaluator reads claims from the collection on chain and issues determinations as UDIDs through `msgEvaluateClaim`.

The two apps do not talk to each other over a wire. They share a claims collection in the deployed design; here each holds its own state and the loop test connects them at the level that matters — their constitutions.

## Running it

```bash
pnpm test --filter diagnostics-evaluator-example   # the loop, across both documents
pnpm test --filter agentic-asset-example           # the vehicle's own constitution
```
