# Request admission

Workers plugins can implement `getRequestAdmission(context)` to handle a bounded authenticated read before model selection, attachment interpretation, capability routing, agent construction, and summarization. The context contains configuration, verified user and session identity, the message, optional bounded metadata, and a cancellation signal. It exposes no model or mutation tools.

Return `{ kind: 'pass' }` for unsupported requests or `{ kind: 'handled', text, title }` for a deterministic authorized read. The first handler in plugin dependency order wins. Authorization and read failures throw and fail the turn; they do not fall through to an agent. The host excludes requests containing attachments. A handler must use the same authorized service as its ordinary read tool and must never execute mutation handlers or invoke inference through captured dependencies.

The host persists an `admitting`, `agent`, or `direct-read` disposition on the durable run. Recovery repeats interrupted read admission, replays an already recorded direct result, or resumes an ordinary agent. Historical runs without a disposition resume the agent. The client cannot set a disposition. Direct replies append stable message IDs to the normal transcript, use the existing SSE buffer and Matrix mirror, and select a deterministic title. They skip agent preparation and after-turn shadow comparison. Group compaction runs independently and is not attributed as a generative call of this request.

`getRequestMiddlewares(ctx)` contributes request-local LangChain middleware to ordinary agent turns. These extensions receive the full RuntimeContext and are collected afresh after boot middleware. They do not provide inference avoidance; use admission for that boundary. Plugins must not retain either context on singleton instances.

New flow conditions require `source` equal to `configured_input` or `runtime_output`. Stored untagged conditions remain untagged when read. A separate `semanticGate` contains version 1, decision `flow.gate.semantic`, criterion, rubric, and named input fields. It is an additional host gate, never a replacement for deterministic conditions or authorization. Runner support and per-definition activation are host responsibilities.

`readFlowDecisionContext(ctx, ref?)` returns the authenticated `FlowSpecRead` snapshot, including its resolved `ref`, through the existing Matrix room-membership guard. It does not invoke inference or mutate the flow. Hosts must select and redact the fields needed for their Decision variables rather than trust model-supplied draft state. Input, condition, and semantic-gate edits update both the editor blocks and compiled `qi.flow.nodes` consumed by the runner.

Decision calls combine caller cancellation with turn cancellation. Already cancelled calls do not reach the provider, cancellation rejects even if a provider ignores the signal, and a result arriving after cancellation cannot become an accepted answer.
