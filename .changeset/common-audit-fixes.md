---
'@ixo/common': patch
---

Decision timeouts and Workers AI cancellation.

- **Workers AI cancellation.** `WorkersAiJevDecisionAdapter` hands the evaluation's `AbortSignal` to the Workers AI binding (`ai.run(model, inputs, { signal })`), so a decision that times out or is cancelled stops its inference instead of only releasing the caller. Without a signal the binding is called with two arguments, as before.
- **Timeout validation.** `defineDecision` throws a `RangeError` when `timeoutMs` is not an integer from 1 to 2^31−1. `DecisionRuntime.evaluate` and `evaluateByName` reject with a `RangeError`, without calling the adapter, when the per-call `timeoutMs` or a hand-written registration's `timeoutMs` is outside that range. Visible to callers: a decision defined with such a value (0, a negative or fractional number, `NaN`, `Infinity`, or more than 2^31−1) now fails when it is defined or evaluated, where it used to time out on every evaluation.
