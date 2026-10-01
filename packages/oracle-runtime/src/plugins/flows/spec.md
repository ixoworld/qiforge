# Flows Plugin — Production Specification

> **Status:** Production design. **Flagship paid product.** A qiforge oracle plugin that lets an agent **build, wire, mutate, inspect, and form-fill** multi-step action flows conversationally, on top of the `@ixo/editor` Qi Flow engine.
>
> **Scope (binding): the agent is a flow _builder_, not a _runner_.** The agent authors flows and fills forms; the **user runs the flow in the portal**. There is **no execution, no signing, no UCAN minting, no `ActionServices`** in this plugin. The agent only writes flow documents and reads their state — it never holds a key or triggers a side effect. This makes the security story trivial and keeps all signing/PIN/consent in the portal where it belongs.
>
> **Editor pin:** written against `@ixo/editor@5.31.0` core (portal runs `5.29.0`). We own `@ixo/editor`, so any upstream change this plugin needs is a scheduled work item (§7), not an external blocker. Re-run the drift checklist (Appendix B) on every bump.
>
> **Plugin location:** `packages/oracle-runtime/src/plugins/flows/`. (This spec currently lives under `…/editor/` for historical reasons.) The flows plugin **coexists** with the editor plugin (§6.6).

---

## 0. Executive summary

A user describes an automation in natural language ("when a claim is approved, email the applicant and load the carbon batches"); the agent builds it as a real, runnable flow — adding steps, wiring outputs to inputs, setting conditions/schedules/assignees, pre-filling forms — then the **user reviews and runs it in the portal**.

Five commitments:

1. **The agent operates on a friendly, leak-proof model (FlowSpec).** It never sees a block, Y.Doc, `can`/`with`, CAR, CID, or delegation. One translator module owns the projection (§2).
2. **The agent never executes and never signs.** It writes flow documents and reads their state. All running, PIN entry, and signing happen in the portal, driven by the user. No keys, no `ActionServices`, no auth surface in this plugin.
3. **Reads gather from every source and parse cleanly.** `read_flow` merges the graph map (structure), the document fragment (per-block inputs/conditions/trigger), and the runtime map (status/errors) into one FlowSpec — so the agent always sees the _true_ current flow, not a lossy projection (§4.1).
4. **Edits are per-block / delta and lossless.** A mutation touches only its target step; unrelated steps' data is never rewritten or dropped (§4.2). No full-rebuild-from-a-lossy-read.
5. **The agent sees errors at every layer.** Build/validation errors throw with precise messages at author time; the user's run results (success/failure/awaiting) and the audit history are read back from the shared Y.Doc (§4.3). The agent can diagnose a failed run and propose a fix.

---

## 1. Product goal & the abstraction

**Goal:** conversational flow construction. "Build me a flow that…" → the agent assembles steps from the action catalog, wires the data, sets the rules, fills the forms, and explains what it built. The user opens the flow in the portal and runs it.

**The abstraction (binding):** the agent operates exclusively on **FlowSpec** (§2). The plugin owns the **FlowSpec ⇄ BaseUcanFlow translator** — the one place internals could leak, so it is one module with exhaustive round-trip tests. No tool's JSON schema, argument, or output may mention `block`, `blockId`, `props`, `yDoc`, `roomId`, `CAR`, `CID`, `delegation`, `can`, `with`, or `nb`. The agent thinks in **steps, actions, inputs, outputs, conditions, schedules, assignees, forms** — never the compiler's primitives.

**Flow handle:** the agent addresses a flow by an **opaque `flowRef`**. **Internally, `flowRef` _is_ the Matrix room id** — opaque to the agent (it must never appear in a tool's prose/output per the leak guard), but the plugin resolves it directly to a room with no lookup table: `flowRef` → roomId is the identity, and every editor call (`readCompiledFlowFromYDoc`, `setupFlowFromBaseUcan`, the provider) takes that roomId. The **default** `flowRef` (when the agent omits it) is the current flow bound to `state.editorRoomId`. `create_flow` returns a fresh `flowRef` (the new room's id, opaque). This keeps resolution trivial and avoids any registry.

---

## 2. The FlowSpec model

### 2.1 Shape

FlowSpec is the friendly, faithful projection of `BaseUcanFlow` (Appendix A.0 has the verified target type).

```ts
interface FlowSpec {
  ref?: string; // opaque flowRef (omitted on create; assigned by the plugin)
  title: string;
  goal?: string;
  steps: FlowStep[]; // ORDER IS SEMANTIC — implicit sequential ordering (2.3)
}

interface FlowStep {
  id: string; // stable, human-readable step id (e.g. "load-batches")
  action: string; // friendly action name (resolves to a `can` via the registry)
  title?: string;
  description?: string;

  inputs?: Record<string, unknown>; // friendly inputs; values may be field refs (2.4)
  form?: FormAnswers; // for human form/survey steps — pre-filled answers (2.5)

  // ── wiring / sequencing (see 2.3 for the verified model) ──
  after?: string[]; // ordering: place this step after these (sequence). Pair with data-refs for a real dependency. NOT an auto-trigger.
  runWhen?: Condition; // gate activation on an upstream value — STATIC config props only (see 2.3 caveat)
  conditions?: Condition[]; // multiple gates (folded into one ConditionRef)
  onEvent?: { fromStep: string; event: string }; // ADVANCED, opt-in: auto-trigger when an upstream EMITS a named event. Only valid when that upstream's action is event-capable (validated). Most actions are not — see 2.3.

  // ── scheduling ──
  trigger?: 'manual' | 'flow-start'; // explicit trigger override (default 'manual'). Event-triggering is via onEvent.
  due?: { at?: string; within?: string; afterCommitment?: string }; // ISO date / ISO-8601 duration

  // ── assignment (flow metadata: who is meant to run / is notified) ──
  assignTo?: string; // assignee (DID or known alias)
  commitTo?: string; // commitment window (ISO-8601 duration)

  // ── lifecycle hooks (the `on` field) ──
  on?: Record<string, HookSpec[]>; // event name → hooks (sendEmail | addLinkedEntity | sendMatrixDM)

  // ── capsule skills attached to this step ──
  skills?: string[];

  // ── display metadata for the runner ──
  requireConfirmation?: boolean; // hint the portal to force a confirm before this step runs
  status?: StepStatus; // READ-ONLY (from runtime; never written by the agent) — see 2.6
}
```

```ts
// `is` values map 1:1 onto the FE condition evaluator's operator vocabulary at author time (§7.1):
// equals | notEquals | greaterThan | lessThan | contains | isEmpty | isNotEmpty.
interface Condition {
  fromStep: string;
  field: string;
  is:
    | 'equals'
    | 'notEquals'
    | 'greaterThan'
    | 'lessThan'
    | 'contains'
    | 'isEmpty'
    | 'isNotEmpty';
  value?: unknown;
}
interface HookSpec {
  type: 'sendEmail' | 'addLinkedEntity' | 'sendMatrixDM';
  config: Record<string, unknown>;
}
type FormAnswers = Record<string, unknown>; // keyed by question name (2.5)
// Read-only, derived on read from the runtime map (never written by the agent — §2.6, §4.3):
interface StepStatus {
  state:
    | 'idle'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'awaiting_readback'; // stored (runtime.state)
  error?: { message: string; code?: string; at?: number }; // stored (runtime.error)
  lastRunAt?: number; // stored (runtime.executedAt)
  blockedBy?: string[]; // COMPUTED: upstream step ids that are failed or whose output this step's refs need
  stale?: boolean; // COMPUTED: completed but missing expected proof (transactionHash/claimId)
}
```

> **Dropped from the earlier draft (out of scope here):** `authorize`/permission grants and anything UCAN/delegation — those are execution-authorization, which lives in the portal. `assignTo` remains as _flow metadata_ (who is meant to act), written into the flow doc; it grants nothing.

### 2.2 Field-by-field translation contract

The translator (`flow-spec.ts`) maps every FlowSpec field onto the verified `BaseUcanFlow`/`FlowCapability` shape (Appendix A.0). This table **is** the translator's test matrix (§9).

| FlowSpec                      | BaseUcanFlow target                                                         | Notes                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`, `goal`               | `flow.title`, `flow.goal`                                                   | direct                                                                                                                                                                                                           |
| `ref`                         | `flow.flowId` + `meta.flowUri`                                              | opaque                                                                                                                                                                                                           |
| `step.id`                     | `capability.id`                                                             | stable node id                                                                                                                                                                                                   |
| `step.action`                 | `capability.can` (via `typeToCan`/`getActionByCan`)                         | friendly name → `can`                                                                                                                                                                                            |
| `step.title`/`description`    | `capability.title`/`description`                                            | direct                                                                                                                                                                                                           |
| `step.inputs`                 | `capability.nb`                                                             | field refs translated (2.4)                                                                                                                                                                                      |
| `step.form`                   | runtime `output.form.answers` (schema read from `block.props.surveySchema`) | survey path (2.5, §7.2) — not submitted                                                                                                                                                                          |
| `step.after`                  | **`capabilities[]` ORDER** (the step is placed after the named steps)       | sequencing only — **not** a trigger; the real dependency is the data-ref (2.4). See 2.3.                                                                                                                         |
| `step.runWhen`/`conditions[]` | `capability.condition` (`ConditionRef`) → compiled `props.conditions`       | translator maps the friendly `is` to the **evaluator's operator vocabulary** (§7.1) and writes `props.conditions` directly; gates on **static props only** (2.3 caveat). Multiples folded into one ConditionRef. |
| `step.onEvent`                | `capability.trigger` = `block.event` (`{sourceBlockId, eventName, alias}`)  | **advanced**; valid only if the upstream action is `eligibleForEventTrigger` and declares `event` — else `validate_flow` rejects it (2.3).                                                                       |
| `step.trigger`                | `capability.trigger.type` (`manual`/`flow.start`)                           | explicit override; default `manual`.                                                                                                                                                                             |
| `step.due.*`                  | `capability.ttl.absoluteDueDate`/`fromEnablement`/`fromCommitment`          | ISO-8601                                                                                                                                                                                                         |
| `step.assignTo`               | `capability.actor.authorisedActors` + block `assigneeDid` prop              | metadata only                                                                                                                                                                                                    |
| `step.commitTo`               | `capability.ttl.fromCommitment`                                             |                                                                                                                                                                                                                  |
| `step.on`                     | block `props.hookedActions`                                                 | Appendix A.4                                                                                                                                                                                                     |
| `step.skills`                 | block `props.skills`                                                        |                                                                                                                                                                                                                  |
| `step.requireConfirmation`    | overrides action's `defaultRequiresConfirmation`                            | display hint for the runner                                                                                                                                                                                      |
| `step.status`                 | runtime map (read-only)                                                     | never written by the agent (2.6)                                                                                                                                                                                 |

`parallelGroup`/`phase` (layout hints) are not surfaced in v1. The agent reasons in `after`/`runWhen`.

### 2.3 Sequencing model (verified — read this carefully)

How "step B comes after step A" actually works in this engine (since the user runs the flow):

1. **Order + data-refs is the primary, always-works mechanism.** `capabilities[]` array order _is_ the sequence (the only compiled edge kind is `'trigger'`; ordering is implicit). A step that references an upstream's output (`{{A.output.x}}`, 2.4) is **not ready until A has produced that output** — the engine classifies it `Blocked`/missing-inputs until then. So the user steps through A → B, and B's inputs only resolve once A ran. This is exactly what the built-in templates do (e.g. carbon-harvest reads `{{carbon-load.output.harvestableBatches}}`). `step.after` compiles to **ordering** (+ signals the agent to wire the data-ref); it is **not** an auto-trigger.

2. **Event auto-triggers (`onEvent`) are an ADVANCED, validated, opt-in feature — and only work for event-capable actions.** A `block.event` trigger requires the upstream action to be `eligibleForEventTrigger: true` AND to declare a named `event`. **Verified: only ~12 of ~55 actions qualify** (e.g. `claim.submit`, `evaluateClaim`, `domain.sign`, `email.send`, `http.request`, calendar/xero, some pod actions). Most actions — including `carbon.loadBatches`, `humanForm`, wallet/oracle/entity actions — **declare no event and are not eligible**, so `block.event` on them **fails to compile** (the editor throws `"not marked eligibleForEventTrigger"`). Therefore `onEvent` is for genuine event-driven patterns ("when this claim is _approved_, run the next step"), not general sequencing. `validate_flow` MUST reject `onEvent` whose `fromStep` action isn't event-capable, with a clear message, and steer the agent to order+data-refs instead.

3. **`runWhen`/`conditions` gate on STATIC config props, not runtime output** (§7.4): the FE condition evaluator reads `sourceBlock.props[field]`, not the upstream's runtime output. So conditions can gate on authored configuration, but **cannot** gate on a live result like `evaluate.decision == approved` — that case is the `onEvent` path (an `approved` event) or simply user judgment. The translator authors `props.conditions` in the evaluator's operator vocabulary (§7.1).

> **Net for v1:** the agent sequences with **order + data-refs** (works for everything), uses **`onEvent`** only for the ~12 event-emitting actions, and uses **`runWhen`/`conditions`** for static-config gating. `validate_flow` enforces the event-capability constraint so a bad `onEvent` is caught at author time, never at the user's run.

### 2.4 Field references (data piping)

The agent writes friendly refs; the translator converts them: `inputs.batches = "{{load-batches.output.harvestable}}"` → `{ batches: { $ref: "load-batches.output.harvestable" } }`. `list_referenceable_fields(flowRef, stepId)` returns the **friendly** field paths a step can pipe from its upstream steps (from each upstream action's `outputSchema`/`getDynamicOutputSchema`), so the agent never guesses ref strings.

### 2.5 Forms (the fill-forms feature)

Human form/survey steps use **SurveyJS** (Appendix A.2). The agent can **pre-fill** answers but **never submits** — the user reviews and submits in the portal.

- `describe_form(flowRef, stepId)` → the survey's questions with **exact allowed values** (dropdown `value`s, validators, conditional `visibleIf`), so the agent fills correctly (dropdowns need the underlying value, not the label).
- `fill_form(flowRef, stepId, answers)` → writes answers into the step, returns `{ applied, rejected, validation }`. `merge:true` by default. Two surfaces exist in the editor and the tool handles both (Appendix A.2):
  1. **Block-state forms (what the plugin targets)** — the survey **schema** lives in `block.props.surveySchema`; the **answers** persist in the **runtime map** at `runtime.output.form.answers` (verified, §7.2). `fill_form` reads the schema and writes that runtime field directly — it does **not** set `state:'completed'` (submission is the user's action in the portal).
  2. **Ephemeral open-survey panels** — `fillOpenSurvey`/`snapshotOpenSurvey`/`useOpenSurveyStore` (a live FE panel, session-scoped). The plugin does **not** use these (they require a live React panel); it always targets the durable block-state path above.

### 2.6 Status is read-only

`step.status` is derived from the runtime map (§4.3) on read and **never written by the agent**. It reflects the user's runs. The agent reads it to report progress and diagnose failures.

---

## 3. Tool catalog

All tools are contributed via `getRequestTools(rtCtx)` (they need per-request `state.editorRoomId`/`spaceId` + `ctx.user`) and inherit the room-membership guard (§6.1). Every tool's I/O is FlowSpec-shaped and passes the leak guard (§9). **No execution or permission tools exist** — running is the portal's job.

### 3.1 Discovery

| Tool                        | In → Out                                                                 | Purpose                                                               |
| --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `list_actions`              | `{category?, tag?}` → `[{action, summary, whenToUse, tags}]`             | enumerate available actions (driven by §5 manifests)                  |
| `describe_action`           | `{action}` → `{summary, inputs[], outputs[], events[], hooks[], isForm}` | full friendly spec of one action                                      |
| `list_referenceable_fields` | `{flowRef, stepId}` → `[{fromStep, field, type}]`                        | which upstream outputs a step can pipe from (2.4)                     |
| `get_flow_template`         | `{name}` → `FlowSpec`                                                    | a reference flow as FlowSpec (in-plugin starter templates — see §7.4) |

### 3.2 Linkage (typed wiring checks)

| Tool                 | In → Out                                                      | Purpose                                                  |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `check_link`         | `{flowRef, fromStep, field, toStep, input}` → `{ok, reason?}` | can this output feed that input? (typed-port check, §5)  |
| `compatible_actions` | `{flowRef, stepId, forInput}` → `[{action, field}]`           | which actions produce a value compatible with this input |
| `requirements`       | `{action}` → `{requires[]}`                                   | declarative prerequisites of an action (§5 `requires`)   |

### 3.3 Authoring (per-block / delta — §4.2)

| Tool               | In → Out                                               | Purpose                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validate_flow`    | `{flow: FlowSpec}` → `{ok, errors[], warnings[]}`      | compile-without-write; surfaces the exact compiler errors (§4.3). Never mutates                                                                                                                                    |
| `create_flow`      | `{flow: FlowSpec}` → `{flowRef}`                       | allocate + compile + write a new flow (§6.5)                                                                                                                                                                       |
| `add_step`         | `{flowRef, step, position?}` → `{ok}`                  | add a step (others untouched). `position`: a 0-based index, or `{after: stepId}` / `{before: stepId}`; omitted = append. Implemented via `strategy:'merge'` then `reorder_step` if a non-append position is given. |
| `update_step`      | `{flowRef, stepId, patch: Partial<FlowStep>}` → `{ok}` | convenience: shallow-merge any subset of step fields; routes each field to the same mechanism as its focused mutator (§4.2). The focused `set_step_*` (§3.4) are the canonical per-setting API.                    |
| `remove_step`      | `{flowRef, stepId}` → `{ok}`                           | targeted removal (§7.3); rejects if referenced                                                                                                                                                                     |
| `reorder_step`     | `{flowRef, stepId, toIndex}` → `{ok}`                  | preserves semantic order (§7.3)                                                                                                                                                                                    |
| `update_flow_meta` | `{flowRef, title?, goal?}` → `{ok}`                    |                                                                                                                                                                                                                    |
| `connect_steps`    | `{flowRef, fromStep, field, toStep, input}` → `{ok}`   | wire a field ref (validated by `check_link`)                                                                                                                                                                       |

### 3.4 Settings mutators (one focused tool per setting; each per-block — §4.2)

`set_step_inputs`, `set_step_conditions` (static-prop gates, §2.3), `set_step_trigger` (`manual`/`flow-start`), `set_step_sequence` (`after` ordering), `set_step_event` (`onEvent` — validated event-capability, §2.3), `set_step_schedule` (due/within), `set_step_assignment` (assignTo/commitTo), `set_step_hooks` (on), `set_step_skills`, `set_step_confirmation`. Each maps to exactly the §2.2 target and round-trips through `read_flow`.

### 3.5 Forms (§2.5)

| Tool            | In → Out                                                                              | Purpose                               |
| --------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| `describe_form` | `{flowRef, stepId}` → `{questions:[{name, type, choices?, validators?, visibleIf?}]}` | exact fillable schema                 |
| `fill_form`     | `{flowRef, stepId, answers, merge?}` → `{applied, rejected, validation}`              | pre-fill answers; **does not submit** |

### 3.6 Inspect (multi-source read — §4.1)

| Tool           | In → Out                                                      | Purpose                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_flow`    | `{flowRef}` → `FlowSpec` (+ `{schemaVersion}`)                | full friendly read, gathered from all sources. Each step carries its read-only `status: StepStatus` (§2.1).                                                                                   |
| `get_step`     | `{flowRef, stepId}` → `FlowStep` (incl. `status: StepStatus`) | one step incl. runtime status                                                                                                                                                                 |
| `flow_status`  | `{flowRef}` → `{ steps: Array<{ id: string } & StepStatus> }` | per-step `StepStatus` (§2.1): `state`/`error`/`lastRunAt` stored, `blockedBy`/`stale` computed (§4.3)                                                                                         |
| `explain_step` | `{flowRef, stepId}` → `{willDo, inputsResolved, changes?}`    | a plain-language "what this step does + the diff it would produce" (uses the action's diff resolver, read-only — Appendix A.7). Helps the agent explain a step to the user before they run it |

### 3.7 (Deferred — not v1) Propose-to-user

`propose_step_change({flowRef, stepId, patch, rationale}) → {proposalId}` would write an **AI proposal** (`runtime.proposals[]`, Appendix A.0) the user accepts/rejects in the portal — the safe "suggest, human commits" path for sensitive edits. **Deferred:** it's unconfirmed whether the portal wires the proposal-accept UI, so v1 uses direct per-block mutation. Revisit once the portal side is confirmed (§4.4).

---

## 4. Reading, editing & error visibility (the mechanics)

### 4.1 Multi-source read

The editor stores a compiled flow in **two places**, and per-block `props` (inputs, conditions, trigger, ttl, icon) live only in one of them. So a single read path is lossy; `read_flow` **gathers from all sources** and assembles the FlowSpec:

| Source                                                                                            | Yields                                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `qi.flow.*` maps (`readCompiledFlowFromYDoc`)                                                     | structure: node ids, `can`/`with`, order, edges, `actor`, title/description                              |
| BlockNote **`document` XmlFragment** block attributes                                             | the per-block `props` the graph map omits — `inputs` (`nb`), `conditions`, `triggerMode`, `ttl*`, `icon` |
| the **`runtime`** Y.Map (`yDoc.getMap('runtime')`, keyed by **blockId**) — `FlowNodeRuntimeState` | per-step `state`, `error`, `output`, `executedAt`, `readBack`, assignments, proposals                    |

The translator merges these into one FlowSpec entirely in the plugin — **no editor change** (§7.1). The only coupling is that the fragment-parsing branch reads BlockNote's `blockContainer>blockContent` shape; that's contained in our code and re-verified on each editor bump (Appendix B).

### 4.2 Per-block / delta edits (lossless)

A mutation never does "read-the-whole-flow → recompile → overwrite." Instead it touches only its target. Note the editor stores per-block props **only in the `document` fragment** — `createYMapFromNode` omits props from `qi.flow.nodes` (§7.1), so the node map carries no props to desync, and the editor renders from the fragment. So a direct fragment-attribute write is the single source of truth for props.

- **Value-only prop changes** (`inputs`, `title`, `schedule`, `assignment`, `skills`, `hooks`, `icon`, `form` answers, `conditions`) → **direct per-block attribute write** into the target block's `blockContent` in the `document` fragment, via plain yjs (an **in-plugin replica** of the editor's `replaceBlockInFragment` logic — that helper is not exported, §7.3). No recompile; siblings untouched.
- **Edge-affecting changes** (`onEvent` triggers, which synthesize compiled trigger edges) → `setupFlowFromBaseUcan` with **`strategy:'patch'`** and a **single-capability delta**, so the editor recomputes edges. Patch keeps unmentioned blocks' fragment props intact (verified: `applyMergeResultToFragment` only replaces changed blocks). (`after` is pure ordering, §2.3 — it does **not** need recompile beyond array order.)
- **Add** → `strategy:'merge'` with the new capability only.
- **Remove** → in-plugin replica of `removeBlockFromFragment` (match `blockContainer` by `id` attr) + `qi.flow.*` map cleanup + runtime-entry delete, with the reference guard (§7.3).
- **Reorder** → rewrite `qi.flow.order` + reorder the `blockGroup` children (§7.3).

Constructing a correct delta uses the §4.1 multi-source read of the target step. The §9 suite proves editing one step never disturbs another's data.

### 4.3 Error & status visibility (how the agent knows something's wrong)

The editor tracks errors at three layers; all are visible to the agent because they live in the shared Y.Doc (or are thrown at author time):

1. **Build/validation errors — author time, thrown, precise.** `compileBaseUcanFlow`/`setupFlowFromBaseUcan` throw specific messages: unknown capability/action, duplicate id, trigger references unknown source/event (with the declared-events list), `block.event.all` on a non-`eligibleForEventTrigger` action, listener ref to unknown block, condition references unknown source, **trigger cycle** (with the readable `A → B → A` path), invalid ref format. `validate_flow` and every authoring tool surface these verbatim → the agent fixes the flow before/at write time.
2. **Run results — the `runtime` Y.Map** (`yDoc.getMap('runtime')`, keyed by **blockId**). After the user runs, each step's `FlowNodeRuntimeState` holds `state` (`idle|running|completed|failed|cancelled|awaiting_readback`), **`error:{message,code?,at,data?}`** (written by the executor's `updateRuntimeFailure` → `{state:'failed', error:{message,at}}`), `output`, `executedAt`, `readBack`, `claimId`. `flow_status`/`get_step` read these.
3. **Audit history — the `auditTrail` Y.Map** (`yDoc.getMap('auditTrail')`, keyed by blockId): a FIFO-capped list of `RunRecordDetails` per block (output, events, `error{message,code?}`, timestamps, actor) — for diagnosing past/intermittent failures, not just the latest state.

Plus two derived signals `flow_status` computes: **(a) blocker classification** (mirroring `classifyNodeState`) — `Done`/`Pending`/`Overdue`/`Blocked` (Blocked when `state==='failed'`, an `error` is present, or a required input/ref is unsatisfied), with `blockedBy` naming the failed/unsatisfied upstream; **(b) completed-without-proof (stale)** — a step `completed` but missing its expected proof (`transactionHash`/`claimId`), flagged so the agent doesn't trust a side-effect that left no receipt.

**Access model (pull-based).** All of the above live in the **same flow-room Y.Doc the plugin connects to** — the portal writes run state over Matrix CRDT, the plugin reads it. It is **pull-based per tool call**: on a turn that calls `flow_status`, the plugin connects (`MatrixProviderManager` → sync → read → dispose) and returns the latest synced state. There is no background push into the conversation; the agent sees errors whenever it checks (e.g. user asks "did it work?"). Proactive notify-on-failure (subscribe to room events) is a possible later enhancement, out of v1.

Example:

```jsonc
flow_status("flow_abc") → { steps: [
  { id: "load-batches", state: "completed", lastRunAt: "…" },
  { id: "submit-claim", state: "failed",
    error: { message: "PIN required to submit claim", code: "E_PIN", at: … }, lastRunAt: "…" },
  { id: "notify-team", state: "idle", blockedBy: ["submit-claim"] } ] }
```

### 4.4 Propose-to-user (optional safe-edit path)

The editor has a native **AI-proposal** mechanism: `FlowNodeRuntimeState.proposals[]` (`mode:'inputs_patch'|'output_patch'`, `rationale`, `status:'open'|'accepted'|'rejected'`, `acceptanceInvocationCid`). For sensitive changes, instead of mutating directly the agent can `propose_step_change` (§3.7) — writing a proposal the user accepts/rejects in the portal. Default authoring is direct mutation (the agent _is_ the builder); proposals are the opt-in "suggest, human commits" path. This is the editor's own pattern for agent-builds/human-decides, so we reuse it rather than inventing one.

---

## 5. Action-metadata enhancement (on `@ixo/editor`)

Discovery/linkage quality depends on richer metadata than the bare action registry provides. We add it as a **plugin-side overlay** (a map keyed by action `type`/`can`), merged with `getAllActions()` at runtime — **no editor change** (§7.5). Three pieces of metadata:

1. **Manifest** — `{ summary, whenToUse: string[], whenNotToUse?: string[], tags: string[] }`. Drives `list_actions`/`describe_action`. No embeddings — the catalog is dozens to low-hundreds and static; manifests + tags give better precision at this size. (Revisit only for a large free-text flow/template _library_; manifests are the embedding input regardless.)
2. **Typed ports** — semantic `portType` on inputs/outputs (`did`, `chainAddress`, `transactionHash`, `claimCollectionId`, …). Powers `check_link`/`compatible_actions`. Open-string vocabulary with a documented core set; unknown → primitive match + warning.
3. **Declarative `requires`** — prerequisites (e.g. "needs a funded wallet"). Powers `requirements` + pre-write validation.

Additive and backward-compatible; actions without them fall back to primitive matching.

---

## 6. Implementation in qiforge

### 6.1 Plugin shape

`packages/oracle-runtime/src/plugins/flows/flows.plugin.ts` — `class FlowsPlugin extends OraclePlugin`:

```ts
manifest = {
  title: 'Flows',
  summary:
    'Build, wire, and edit multi-step action flows, and fill their forms. Use whenever the user ' +
    'wants to create an automation/workflow, change a flow’s steps or settings, fill a form, or ' +
    'check a flow’s status. The user runs the flow in the portal.',
  whenToUse: [
    'User wants to build a workflow/automation/flow from steps or actions.',
    'User wants to change a step’s inputs, condition, trigger, schedule, or assignee.',
    'User wants to fill in a form/survey on a flow.',
    'User wants to inspect a flow or find out why a step failed.',
  ],
  whenNotToUse: [
    'Editing prose/pages/documents (use Editor).',
    'Actually executing/running/signing a step — that happens in the portal, by the user.',
  ],
  tags: ['flows', 'automation', 'workflow', 'forms'],
  category: 'automation',
  visibility: 'on-demand',
  stability: 'beta',
};
```

Tools via `getRequestTools(rtCtx)`. **Room-membership guard** on every read/mutate: `isUserInRoom(flowRoom, rtCtx.user.matrixUserId)` (fail closed), mirroring the editor plugin. The oracle must be a member of the flow's Matrix room to read/write its Y.Doc.

**Error model (uniform):** every tool returns a structured result, never throws to the agent. Expected failures come back as `{ ok: false, error: { code, message } }` with friendly, leak-safe messages: `not_in_room` (guard failed), `flow_not_found` (room unavailable / no flow state), `validation_failed` (carries the compiler's verbatim message — unknown action, duplicate id, trigger cycle path, non-event-capable `onEvent`, etc.), `step_not_found`, `referenced` (remove blocked by referrers). `validate_flow` returns `{ ok, errors[], warnings[] }`. Malformed data encountered on read (e.g. unparseable `props.conditions`) is skipped defensively and surfaced as a `warnings[]` entry, never crashes the read.

**Plugin construction:** like the editor plugin, `FlowsPlugin` receives the `matrixClient` at construction (not via `rtCtx`) — needed for the provider connection and for any room creation (`rtCtx.matrix` exposes only `postToRoom`/`getRoomState`/`getEventById`, **no `createRoom`**; §6.5).

### 6.2 Reuse, don't reinvent

- **CRDT connection:** reuse `MatrixProviderManager` (`provider.ts`) + `buildBlocknoteToolsConfig` (`blocknote-tools.ts`, exported from the editor plugin's `index.ts`). Note: `MatrixProviderManager` is **not** in the editor plugin's `index.ts` today — import it from `./editor/provider.js` directly, or add the export (an oracle-runtime change, allowed; not an `@ixo/editor` change). Instantiate per invocation, `init()` → Y.Doc, `dispose()` when done. The flows plugin gets a connected Y.Doc the same way; it never exposes it.
- **Flow logic — only `@ixo/editor/core` exports that actually exist:** `compileBaseUcanFlow`, `setupFlowFromBaseUcan` (`full`/`merge`/`patch`), `readCompiledFlowFromYDoc`, `mergeCompiledFlows`, `getAllActions`/`getAction`/`getActionByCan`/`typeToCan`. (Verified against `core/index.ts`: Appendix A.0.) The fragment helpers are **not** exported today — so the plugin does fragment reads/writes and form-answer reads/writes **via direct yjs** on the connected Y.Doc, **or via a small additive editor export where that's cleaner** (notably the fragment helpers for remove/reorder, §7.3). Never modify existing-export behavior or reimplement the compiler (§7).
- **No execution imports.** The plugin does **not** use `executeActionBlock`/`executeNode`/`FlowAgentService`/`tickFlowAgent`/`UcanService`/`ActionServices`/`mint-invocation`. Those are the portal's runtime.
- **The layers the plugin owns:** the **FlowSpec ⇄ BaseUcanFlow translator**, the **multi-source read assembler** (§4.1, §7.1), the **per-block / direct-CRDT edit dispatcher** (§4.2, §7.3), the **form read/write** (§7.2), the **action-metadata overlay** (§7.5), and **in-plugin FlowSpec templates** (§7.4) — in `flow-spec.ts` / `flow-read.ts` / `flow-edit.ts` / `flow-forms.ts` / `action-metadata.ts` / `templates.ts`, with exhaustive tests.

### 6.3 Why this is safe by construction

The plugin's entire capability is: connect to a Matrix room the user is in, read/write that room's flow document, and read its runtime state. It holds no signing key, calls no chain, and triggers **no chain/signing side effect**. Its only allocation is creating a flow _room_ — and even that is delegated to the user's FE over WS (§6.5), so the oracle never needs elevated Matrix rights. The worst-case blast radius of a bug is a malformed flow document in a room the user already belongs to — which the user sees and can fix or discard before running. There is no auth model to get wrong because there is nothing to authorize.

### 6.4 Config & dependencies

`configSchema` (zod) adds the flows plugin's env. Pin `@ixo/editor` **exactly** (no `^`). Bumping from the editor plugin's current `3.0.0-beta.11` to `≥5.31.0` is the gating prerequisite (§10 PR 1).

### 6.5 Flow handle / room allocation — **one room per flow** (verified against the portal)

In the portal, **every flow is its own Matrix room**, parented to a space via `m.space.child`. Verified details (corrected): a flow's "type" is determined by its **room alias prefix** (`#flow-*` / `#template-*`), not a `type:"flow"` state event; status is an `ixo.flow.status` state event. Lifecycle is room-ops: `cloneFromProtocol` → `{ newRoomId }`, `flowRoomLock`, `deleteFlowRoom`, `flowStatus`.

**Critical verified constraint:** `setupFlowFromBaseUcan` **connects to an existing room** — the room must **pre-exist** before authoring. So creating a flow is always a **two-step** sequence: create the room, then write the flow into it.

**`create_flow` — room creation runs on the FE over the WS browser-tool channel (decided):** rather than have the oracle hold room-creation rights in the user's space, the oracle asks the **user's front-end** to create the room — the FE client already has the rights and already creates flow rooms exactly this way. The channel is the verified, in-production `callBrowserTool` path (`@ixo/common`; `rtCtx.emit.browserToolCall` → ws.gateway `tool_result` → `browser_tool_result`; the portal plugin uses it today).

1. **Ask the FE to create the room.** `callBrowserTool({ sessionId, toolCallId, toolName: 'create_flow_room', args: { title, spaceId: state.spaceId } })`. The FE creates a `#flow-*` room parented to the space with the **user as owner** (reusing the portal's existing `createBlocknoteCollaborativeRoom` / `instantiateTemplate` path) and returns `{ roomId }`. **Requires a small `create_flow_room` browser tool in the portal** (the one portal-side dependency for v1).
2. **Author into it:** `setupFlowFromBaseUcan({ plan, roomId, matrixClient, creatorDid: userDid })` — `flowOwnerDid` = the user's DID so the flow is user-owned; the oracle is a member so it can keep authoring.
3. Return the opaque `flowRef` (= the new room id, §1).

Edits/inspection of an **already-open** flow target `state.editorRoomId` instead (no room creation). The FE round-trip args (`spaceId`/`roomId`) are **internal plugin↔FE** — never surfaced to the agent, so the leak guard (§1) holds.

> **Scope note:** the WS FE-tool is used here ONLY for **benign room allocation** (a one-time setup step), **not** for running flow steps or signing — the builder line (agent never executes/signs, §6.3) is intact. Room creation is a user-scoped write (no chain, no signing).
>
> **Fallbacks** (same tool contract): (a) the oracle creates the room itself via its construction-time `matrixClient` (`page-functions.ts` `createPage` pattern) if a deployment grants it space rights; (b) the portal pre-creates an empty flow room and passes it as `state.editorRoomId`.

**Templates (later):** "start from template X" = clone a template room (the portal's `cloneFromProtocol` pattern). Additive follow-on, not v1.

### 6.6 Relationship to the editor plugin

**Coexist.** Flows plugin = flow building/inspection/form-filling; editor plugin = documents/pages. We do not deprecate the editor plugin's flow-read tools in v1. Shared internals (`MatrixProviderManager`, `buildBlocknoteToolsConfig`) are exported from the editor plugin and imported by flows (or factored into a small shared module).

### 6.7 Editor tooling vs. custom CRDT — the build map

Everything the plugin does is reads/writes against the flow room's Y.Doc. Three buckets:

- **Editor-package tooling** (call exported fns — **never reimplement compilation**): `compileBaseUcanFlow`, `setupFlowFromBaseUcan` (`full`/`merge`/`patch`), `readCompiledFlowFromYDoc`, `mergeCompiledFlows`, `getAllActions`/`getActionByCan`/`typeToCan`.
- **Custom CRDT / yjs** (we write — the editor exposes no function for it): per-block prop **reads** (parse the fragment), runtime/audit **reads**, **remove/reorder**, form-answer read/write, condition-JSON decode.
- **Pure logic** (no yjs, no editor): the FlowSpec⇄BaseUcanFlow **translator**, the **metadata overlay**, the **in-plugin templates**.

**Y.Doc layout** — the top-level keys in a flow room's doc; the schema the custom code depends on (re-verify on bump, Appendix B):

| Y.Doc key                                                            | Type                                 | Holds                                                                                                            | Plugin                                                     |
| -------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `root`                                                               | Map                                  | `schema_version`, `@context`, `_type`                                                                            | read                                                       |
| `qi.flow.meta`                                                       | Map                                  | flowId, title, goal, version, flowOwnerDid, flowUri                                                              | read (editor fn)                                           |
| `qi.flow.nodes`                                                      | Map\<nodeId,Map\>                    | structure (`can`/`with`/`actor`/title…) — **no props**                                                           | read (editor fn)                                           |
| `qi.flow.edges`                                                      | Map                                  | trigger edges                                                                                                    | read (editor fn)                                           |
| `qi.flow.order`                                                      | Array\<nodeId\>                      | sequence                                                                                                         | read; **write** (reorder)                                  |
| `qi.flow.blockIndex`                                                 | Map                                  | nodeId→blockId                                                                                                   | read                                                       |
| **`document`**                                                       | XmlFragment                          | BlockNote doc: `blockGroup > blockContainer[id] > blockContent[…props as attrs]` — **per-block props live here** | **read** (props) + **write** (direct edits/remove/reorder) |
| **`runtime`**                                                        | Map\<blockId, FlowNodeRuntimeState\> | `state`/`output`/`error`/`output.form.answers`                                                                   | **read** (status) + **write** (form answers)               |
| `auditTrail`                                                         | Map\<blockId, RunRecord[]\>          | run history                                                                                                      | read                                                       |
| `invocations` / `pendingInvocations` / `agentOutbox` / `agentLeases` | Map                                  | execution machinery                                                                                              | **ignored** (portal/runtime)                               |

`runtime` and `auditTrail` are **top-level** maps (`yDoc.getMap('runtime')` / `getMap('auditTrail')`), not under `qi.flow.*`; `runtime` is keyed by **blockId** (not nodeId — `initializeRuntime` keys on `blockIndex[nodeId]`). The doc also contains maps the plugin **ignores** (`invocations`, `pendingInvocations`, `agentOutbox`, `agentLeases`, `xeroWorkItems`, `xeroConnection`, `delegations`, `migration`) — all execution/integration machinery owned by the portal/runtime.

**Per-operation split:**

| Plugin op                                                                                    | Editor tooling                                                           | Custom code                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| connect → Y.Doc                                                                              | `MatrixProviderManager` (editor _plugin_ reuse)                          | —                                                                                                                                                                   |
| `create_flow`                                                                                | `setupFlowFromBaseUcan(full)`                                            | translator; room created by the FE via `callBrowserTool('create_flow_room')` over WS (§6.5)                                                                         |
| `validate_flow`                                                                              | `compileBaseUcanFlow` (catch throws)                                     | translator; friendly errors                                                                                                                                         |
| `read_flow`/`get_step`                                                                       | `readCompiledFlowFromYDoc` (structure)                                   | parse fragment for props + read `runtime` + decode conditions → FlowSpec                                                                                            |
| `flow_status`                                                                                | —                                                                        | read `runtime` + `auditTrail`; classify                                                                                                                             |
| `add_step`                                                                                   | `setupFlowFromBaseUcan(merge)`                                           | translator (delta cap)                                                                                                                                              |
| `set_step_*` **value** (inputs/conditions/schedule/assignee/hooks/skills/title/icon/trigger) | —                                                                        | direct `blockContent` attribute write (in-plugin replica of `replaceBlockInFragment`); translator. Conditions written in the evaluator's operator vocabulary (§7.1) |
| `set_step_sequence` (`after`)                                                                | —                                                                        | reorder `qi.flow.order` / set array position (ordering only, §2.3)                                                                                                  |
| `set_step_event` (`onEvent`) **(edges)**                                                     | `setupFlowFromBaseUcan(patch)` (synthesizes trigger edges)               | translator; `validate_flow` first checks the source action is event-capable (§2.3)                                                                                  |
| `connect_steps`                                                                              | (= set inputs)                                                           | ref build + `check_link`                                                                                                                                            |
| `remove_step`                                                                                | `removeBlockFromFragment` (exported, §7.3)                               | ref-guard; delete from `qi.flow.nodes`/`blockIndex`/`order`/`edges`; delete `runtime` entry                                                                         |
| `reorder_step`                                                                               | —                                                                        | rewrite `qi.flow.order`; reorder `blockGroup` children                                                                                                              |
| `list_actions`/`describe_action`                                                             | `getAllActions`/`getActionByCan`                                         | metadata overlay merge                                                                                                                                              |
| `check_link`/`compatible_actions`/`requirements`                                             | `getAllActions` + output schemas                                         | port-type matching (overlay)                                                                                                                                        |
| `describe_form`                                                                              | —                                                                        | read `block.props.surveySchema`; flatten SurveyJS                                                                                                                   |
| `fill_form`                                                                                  | — _(opt: SurveyJS `SurveyModel` for validation — 3rd-party, not editor)_ | write `runtime[blockId].output.form.answers`                                                                                                                        |
| `get_flow_template`                                                                          | _(opt)_ `createOracleInitFlowTemplate` + `typeToCan`                     | in-plugin FlowSpec templates (preferred)                                                                                                                            |

**Principle:** anything that **compiles or writes the canonical flow graph** goes through editor tooling — never reimplemented (block ids, edges, ref-coverage, cycle detection are the editor's tested job). Custom yjs is confined to **reads the editor doesn't expose** + **two structural ops** (remove/reorder) + the **form-answer write** — simple map/fragment manipulation against the layout above. Translator/overlay/templates are pure logic. The one coupling risk is the Y.Doc layout + the `blockContainer>blockContent` shape; the `getAllActions()` snapshot canary + round-trip tests catch drift (Appendix B).

---

## 7. Building it in oracle-runtime — **minimal, additive editor exports OK**

**Decision (user, 2026-06-18, updated):** the plugin lives in oracle-runtime, but **we MAY add small _additive_ exports to `@ixo/editor` where that's cleaner than replicating editor internals** (the user approved "export from it what you need, or rebuild — either is fine"). Two hard rules remain: **never change the behavior of an existing export, and never reimplement the compiler** (block ids, edges, ref-coverage, cycle detection stay the editor's job). So the build uses, in preference order: (a) **already-exported** editor functions; (b) a **small additive export** of an existing internal helper when replicating it in-plugin would be brittle (notably the fragment helpers, §7.3); (c) **direct CRDT** in the plugin for everything trivial. Plus the dependency bump to `@ixo/editor ≥5.31.0`.

The capability table's "Editor change" column below reads **none** or **export** (a one-line additive re-export, no logic change).

**Exported and used as-is:** `compileBaseUcanFlow`, `setupFlowFromBaseUcan` (`full`/`merge`/`patch`), `readCompiledFlowFromYDoc`, `mergeCompiledFlows`, `getAllActions`, `getActionByCan`/`typeToCan`/`canToType`/`getAllCanMappings`, the template factories (`createOracleInitFlowTemplate`, `oracleInitSurveySchema`, …).

**Capability → in-plugin mechanism** (verified internals + detail in 7.1–7.5):

| Capability                        | In-plugin mechanism                                                                                                                                                    | Editor change              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Read a flow with **all** props    | multi-source CRDT read: `readCompiledFlowFromYDoc` (structure) + parse the `document` XmlFragment (per-block props) + the runtime map (status) → FlowSpec              | none                       |
| Add / update / wire a step        | `setupFlowFromBaseUcan` `merge`/`patch` with a single-capability delta; or a direct prop write on the block's fragment element                                         | none                       |
| Value-only prop edit              | direct write of the block's `blockContent` attribute in the Y.XmlFragment (preserves runtime)                                                                          | none                       |
| **Remove / reorder** a step       | **export** + call the editor's fragment helpers (`removeBlockFromFragment`/`replaceBlockInFragment`) + `qi.flow.*` map cleanup; or replicate in-plugin if not exported | export (preferred) or none |
| Fill a form                       | read schema from `block.props.surveySchema`; write answers to the runtime map at `output.form.answers`                                                                 | none                       |
| Templates                         | ship starter templates as FlowSpec in the plugin, or convert the exported legacy factories in-plugin                                                                   | none                       |
| Action discovery/linkage metadata | plugin-side metadata **overlay** keyed by action `type`/`can`, merged with `getAllActions()`                                                                           | none                       |

> **Out of scope entirely** (execution-only): `ucanRequired`, `dryRun`, UCAN/invocation exports.

The subsections below keep the **verified editor internals** (so the implementer knows exactly what they read/write in the CRDT) and give the in-plugin approach for each.

### 7.0 Cross-cutting constraints (in-plugin)

- **All Y.Doc writes inside `yDoc.transact()`** (mirror `hydrate.ts`); never partial-write across a transaction boundary.
- **Treat `@ixo/editor` as read-only at the pinned version.** Pin exactly (no `^`); each bump is an intentional PR re-running Appendix B. Don't depend on editor internals beyond what's verified here.
- **All tests live in the flows plugin** (`createTestRuntime`), not in `@ixo/editor`.
- **Drift canary:** commit a `getAllActions()` snapshot **in the plugin**; CI fails when the registry shifts after a bump (Appendix B).

---

### 7.1 Reading a flow with all props (multi-source CRDT read)

**Why:** per-block `props` (`inputs`/`nb`, `conditions`, `triggerMode`, `ttl*`, `icon`) are the data the agent edits. The editor's own read drops them, so the plugin assembles the read itself.

**Verified internals:**

- The compiler writes every prop onto both the block and node (`compiler.ts:191–222`): `props.conditions = compileCondition(...)` (JSON string, shape below); `props.triggerMode = cap.trigger?.type || 'manual'`.
- `hydrate.ts` `createYMapFromNode` (173–186) **omits `props`** from the `qi.flow.nodes` Y.Map → `readCompiledFlowFromYDoc` returns empty `props`.
- `documentFragment.ts` `createBlockContainer` (108–125) **persists every prop as an attribute on the inner `blockContent` XML element** of the `document` XmlFragment — the authoritative prop store, for old and new flows alike.

**In-plugin read assembler (no editor change):**

1. `readCompiledFlowFromYDoc(yDoc)` → structure (nodes/order/edges/`can`/`with`/`actor`). Empty `props` is expected.
2. Read `yDoc.getXmlFragment('document')` directly via yjs: walk the single `blockGroup`; for each `blockContainer` read its `id` attr + its child content element's attributes → that block's real props (`inputs`/`conditions`/`triggerMode`/`ttl*`/`icon`). Skip the container's `textColor`/`backgroundColor`. Map `blockId→nodeId` via `CompiledFlow.blockIndex`.
3. Read the runtime map (`FlowNodeRuntimeState`) for per-step `state`/`error`/`output`.
4. Decode `props.conditions` → friendly `Condition` in the plugin. Stored JSON shape (`compiler.ts:262–280`):
   ```json
   { "enabled": true, "mode": "all_must_pass",
     "conditions": [ { "sourceBlockId": "<blockId>", "sourceBlockType": "action",
       "rule": { "type": "property_value", "property": "<field>", "operator": "<op>", "value": <v> },
       "effect": { "action": "enable" } } ] }
   ```
   Reverse: `fromStep` = `blockId→nodeId` of `sourceBlockId`; `field` = `rule.property`; `is` = `rule.operator`; `value` = `rule.value`. Parse defensively (try/catch; skip malformed).
5. Merge 1–4 into FlowSpec.

**Tradeoff:** step 2 couples to BlockNote's `blockContainer>blockContent` shape — contained in our code, re-verified on each editor bump (Appendix B). No editor change.

**⚠ Condition operator mapping (write side — verified gotcha).** `compileBaseUcanFlow` writes `ConditionRef.operator` (`eq`/`neq`/`gt`/`lt`/…) **verbatim** into `props.conditions`, but the FE evaluator (`conditionEvaluator.ts:14`) only understands `equals`/`not_equals`/`greater_than`/`less_than`/`contains`/`is_empty`/`is_not_empty`, and **no normalizer maps between them** (`conditionNormalizer.ts` only inverts effect _actions_). So a condition authored through the compiler's `cap.condition` path **never evaluates** (the evaluator hits `default: passes=false`). Therefore the plugin **authors `props.conditions` directly** (the §4.2 value-write path), building the `BlockCondition` JSON itself with the evaluator's operator names — mapping the friendly `Condition.is` (`equals`/`notEquals`/`greaterThan`/`lessThan`/`contains`/`isEmpty`/`isNotEmpty`, §2.1) → the evaluator's exact strings (`equals`/`not_equals`/`greater_than`/`less_than`/`contains`/`is_empty`/`is_not_empty`). On read (step 4 above), reverse the same mapping. Do **not** route conditions through `setupFlowFromBaseUcan`/`cap.condition`.

**Acceptance:** (a) author a flow with `nb` + a `ttl` + a static-prop `runWhen` via the plugin, write, re-read → FlowSpec equals input; (b) a condition authored via the plugin produces `props.conditions` whose operator is in the evaluator's vocabulary (so it would actually evaluate). Plugin tests.

---

### 7.2 Filling a form (direct runtime write)

**Why:** `describe_form`/`fill_form` need to read a form step's questions and pre-fill answers server-side.

**Verified internals (`mantine/blocks/form/flow/FormPanel.tsx`):**

- **Schema** is `block.props.surveySchema` (JSON-stringified SurveyJS).
- **Answers persist in the RUNTIME map**, not block props: `updateRuntime(blockId, { output: { form: { answers: <JSON string> } } })` (118–120); the panel renders pre-fills from `runtime.output?.form?.answers` (123–129). Survey _complete_ additionally sets `state:'completed'` + `executedAt`.

**In-plugin (no editor change):**

- `describe_form` reads `block.props.surveySchema`, flattens `pages[].elements[]` (incl. nested `panel`/`paneldynamic`), surfaces each choice question's **underlying `value`s** + validators + `visibleIf`.
- `fill_form` validates answers against the schema (choice questions accept only declared `value`s; respect `isRequired`/`visibleIf` — optionally run SurveyJS `SurveyModel` headless in Node for validation), then writes them to the block's **runtime entry** at `output.form.answers` (JSON-stringified `Record<questionName,value>`). **Never** set `state:'completed'` — that's submission, which the user does. Matches the `humanForm` output shape (`{ form: { answers }, answers }`).

**Acceptance:** in a test Y.Doc with a form block, `fill_form` writes answers, leaves the step **unsubmitted**, and a mantine mount renders the pre-fill.

---

### 7.3 Remove / reorder a step (runtime-preserving)

**Why:** `setupFlowFromBaseUcan` `patch`/`merge` cover add + update without disturbing siblings, but neither removes nor reorders a single step — and a `full` rebuild resets runtime. The fragment helpers (`removeBlockFromFragment`/`replaceBlockInFragment`/`applyMergeResultToFragment`) exist in `lib/flowCompiler/documentFragment.ts` but are **not exported** from `core/index.ts`.

**Preferred: add the export, then orchestrate in-plugin.** Since additive exports are allowed (§7 intro), the cleanest, least-brittle path is to **export the fragment helpers** from `@ixo/editor/core` (a one-line re-export, no logic change) — or add a thin `removeFlowNode(yDoc, nodeId)` / `reorderFlowNodes(yDoc, order)` that does maps + fragment atomically. The plugin then composes them in one `transact()`:

- **remove:** guard for references (any other node's `trigger.sourceBlockId`/`sources[]`, `condition.sourceBlockId`, or a `{{node.output.*}}` ref in `props.inputs`) → return `{ok:false, error:{code:'referenced'}}` listing the referrers (do not orphan refs). Then `removeBlockFromFragment(fragment, blockId)` + delete from `qi.flow.nodes`/`blockIndex`, drop the id from `qi.flow.order`, delete `qi.flow.edges` touching the node, delete its `runtime` entry. **Siblings untouched.**
- **reorder:** validate the input is a permutation of `qi.flow.order`; rewrite `qi.flow.order`; reorder the `blockGroup` children to match. Maps/edges/runtime unchanged. (Sequence is display-only; `block.event` triggers are id-based, unaffected.)

**Fallback if we choose not to export:** replicate that fragment logic in the plugin via plain yjs (match `blockContainer` by `id` attr — it's ~30 lines). Both preserve sibling runtime. **Avoid** the `full`-rebuild route (`setupFlowFromBaseUcan({strategy:'full'})`) for live flows — `full` re-inits runtime (`initializeRuntime` → all nodes `idle`) and wipes run progress.

**Acceptance (plugin test):** remove a leaf node → its block/maps/runtime gone, **siblings' props + runtime unchanged**, order updated; remove a referenced node → `{ok:false}` listing referrers; reorder → `qi.flow.order` + fragment order updated, per-node state intact.

---

### 7.4 Templates (in-plugin; PR 3)

**Verified shape** (`src/core/templates/carbonHarvestFlow.ts`): `create…FlowTemplate(): { metadata, nodes: FlowNode[] }`, each `FlowNode = { id, type:'action', props:{ title, description, icon, actionType, inputs:<JSON string w/ "{{node.output.field}}" refs>, requiresConfirmation }, activationCondition?:{ upstreamNodeId, requiredStatus } }`.

**✅ `activationCondition` is vestigial** — grep shows it appears **only in the template files**, never evaluated in `core` or `mantine` at 5.31.0. The real dependency is the **data ref** (`{{carbon-load.output.harvestableBatches}}`); live gating uses data-ref availability + compiled `props.conditions`.

**In-plugin (no editor change):** either

- **(a, recommended)** author a handful of good starter flows **directly as FlowSpec in the plugin** — zero editor dependency, cleanest; or
- **(b)** convert the legacy factories in-plugin: `props.actionType → action` (via `typeToCan`/`getActionByCan`), `JSON.parse(props.inputs) → inputs` (keep `{{…}}` refs), title/description/icon across, **drop `activationCondition`**. Note: only `createOracleInitFlowTemplate` (+ `oracleInitSurveySchema`) is exported from `core/index.ts`; `createCarbonHarvestFlowTemplate`/`createEntityTransferFlowTemplate` are **not** exported — which is another reason to prefer (a).

> **Caveat for `runWhen`/`conditions` (§2.1):** `conditionEvaluator.ts:14` evaluates against `sourceBlock.props[rule.property]` — the source's **static props**, not runtime output. So a `runWhen` gating on an upstream's _runtime output_ isn't honored by the current FE evaluator. Gating on static config props works today; runtime-output gating would need an editor change we are **not** making — so v1 scopes `runWhen`/`conditions` to static props and the agent leans on data-refs + `after` for sequencing.

**Acceptance:** `get_flow_template` returns a valid FlowSpec that `create_flow` accepts and `compileBaseUcanFlow` compiles.

---

### 7.5 Action metadata (in-plugin overlay)

**Why:** lift `list_actions`/`describe_action` and `check_link`/`compatible_actions` from raw action types to well-described, typed capabilities — **without** editing `ActionDefinition`.

**In-plugin (no editor change):** maintain a **metadata overlay** in the plugin — a map keyed by action `type` (or `can`) →

```ts
{ summary: string; whenToUse?: string[]; whenNotToUse?: string[]; tags?: string[];
  inputPorts?: { path: string; portType: string; required?: boolean }[];
  outputPorts?: { path: string; portType: string }[];
  requires?: { kind: string; description: string }[] }
```

**Where it lives & seeding:** a committed module in the plugin (`action-metadata.ts`) — `const ACTION_METADATA: Record<string /*action type or can*/, OverlayEntry>`. One entry per action, authored by the maintainer, seeded against the committed `getAllActions()` snapshot (§7.0) so it stays aligned. `list_actions`/`describe_action` merge per action — `{ ...actionDef, ...ACTION_METADATA[action.type] }` (shallow); `check_link`/`compatible_actions` use the overlay's `inputPorts`/`outputPorts`, falling back to the editor's primitive `OutputSchemaField.type` + a warning when an action has no overlay entry. **Port-type vocabulary:** open string with a documented core set (`did`, `chainAddress`, `transactionHash`, `claimCollectionId`, `entityDid`, `roomId`, …).

**Drift:** when the editor adds an action our overlay doesn't cover, discovery falls back to the raw `type`/`name` — and the `getAllActions()` snapshot canary (7.0) trips so we add metadata. No editor change.

**Acceptance:** an action with overlay metadata surfaces it through `describe_action`; `check_link` returns `ok` on matching port types, `ok`+warning on absent ones, `!ok` on a typed mismatch; an uncovered action still lists/links via primitives.

---

## 8. Safety model

The agent never executes, signs, or holds a key (§6.3). The remaining safety surface is small:

1. **Room-membership guard** on every read/mutate (fail closed).
2. **Untrusted content:** step titles/inputs/goal and any run output are user/third-party-authored; mark as untrusted when echoed back so they aren't read as instructions.
3. **Forms are filled, never submitted** (§2.5) — the user reviews and submits.
4. **Sensitive edits can route through proposals** (§4.4) instead of direct mutation.
5. **No fabricated status:** `step.status` is read-only from the runtime map; the agent never invents a step's state or a proof.

---

## 9. Testing

`createTestRuntime({ plugins:[new FlowsPlugin({matrixClient})], user, state:{ editorRoomId } })` → `invokeTool(...)`, mirroring the Weather plugin's two-tier pattern. Minimum coverage:

- **Translator round-trip:** `validate_flow` → `create_flow` → `read_flow` returns the **same FlowSpec** — proving the multi-source read recovers `inputs`/`conditions`/`trigger`/`ttl` (the props the graph map drops) from the fragment.
- **Every §2.1 setting round-trips** via its focused mutator → `read_flow` returns the same friendly values.
- **Per-block edit isolation (the core guarantee):** set step B's inputs; assert steps A, C, D unchanged (inputs, conditions, trigger, runtime status). Also: `remove_step(leaf)` leaves siblings + their runtime untouched; `remove_step(referenced)` throws listing referrers; `reorder_step` updates order + fragment block order with per-node state intact (§7.3).
- **Sequencing:** `after` sets array order (no `block.event` produced); a data-ref dependency reads back correctly. `onEvent` on an **event-capable** upstream compiles to a `block.event` trigger; `onEvent` on a **non-event-capable** upstream (e.g. `carbon.loadBatches`) is **rejected by `validate_flow`** with a clear message (NOT a runtime compile failure).
- **Condition operator mapping (the silent-failure guard):** author a `runWhen`; assert the written `props.conditions` operator is in the evaluator's vocabulary (`equals`/`not_equals`/… — never `eq`/`neq`/…); round-trip back to the friendly `is`. This test fails if conditions are routed through `cap.condition` (§7.1).
- **Form fill:** `describe_form` returns dropdown `value`s + validators; `fill_form` writes `runtime.output.form.answers`, returns `{applied, rejected}`, and does **not** set `state:'completed'`.
- **Validation errors surface verbatim:** duplicate id / unknown action / trigger cycle → `validate_flow` returns `{ok:false, errors}` with the exact compiler message (cycle path included).
- **Error model:** read/edit on a room the user isn't in → `{ok:false, error:{code:'not_in_room'}}`; unknown `flowRef`/empty room → `flow_not_found`; never throws to the agent.
- **Status read + blockId↔stepId join:** seed `runtime[blockId]` with `{state:'failed', error}` (blockId = `flow_block_<stepId>`) → `flow_status` reports it against the **stepId**; `read_flow`'s `step.status` reflects it and is never written by a mutation; `blockedBy`/`stale` are computed correctly.
- **Leak test:** assert no tool's JSON schema or output mentions `block`/`blockId`/`props`/`yDoc`/`roomId`/`CAR`/`CID`/`delegation`/`can`/`with`/`nb`.

Per repo rules: run unit tests after writing; don't auto-run `*.int.test.ts`; integration tests throw on missing env; don't loosen assertions or edit editor source to make tests pass.

---

## 10. Phasing

No execution phase exists. v1 ships the whole builder.

1. **PR 1 — `@ixo/editor` dependency bump (gate):** bump the consumed version to `≥5.31.0` (no editor source change), pin exactly, migrate the editor plugin's call site to the new API, green existing tests. Land the `getAllActions()` snapshot canary (§7.0).
2. **PR 2 — read & author core:** the translator + multi-source read (§4.1) + per-block edit dispatcher (§4.2); discovery (3.1); authoring (3.3); the settings mutators (3.4); inspect (`read_flow`/`get_step`/`flow_status`/`explain_step`); the §9 round-trip + per-block-isolation + validation-error suites. **Coordination dependency:** `create_flow` needs a small `create_flow_room` browser tool added portal-side (§6.5) — sequence that with the portal team; until it lands, `create_flow` can target a portal-pre-created room via `state.editorRoomId` (fallback).
3. **PR 3 — forms & linkage:** `describe_form`/`fill_form` (3.5, §7.2); linkage (3.2) + the metadata overlay's typed ports (§7.5); `get_flow_template` (in-plugin FlowSpec templates, §7.4).
4. **PR 4 — polish:** error-diagnosis UX in `flow_status`, manifest/whenToUse tuning, the leak-guard sweep. (`propose_step_change` is deferred past v1 — §3.7.)

Stop-and-report between PRs (repo rules); verify editor-API claims before accepting.

---

## 11. Resolved decisions

1. **Scope:** builder only — the agent authors + fills forms; the user runs in the portal. No execution/auth/UCAN/`ActionServices` in this plugin.
2. **Read:** multi-source gather (graph map + fragment props + runtime map) → clean FlowSpec; no dependency on the editor's lossy decompile.
3. **Edit:** per-block / delta; never a lossy full-rebuild; value props direct, relational via `patch`.
4. **Errors:** three layers (compile throws / runtime state / audit records) all visible to the agent; plus derived blocker classification.
5. **Forms:** agent fills, user submits; target the durable block-state survey path.
6. **Sequencing (corrected after validation):** primary = `capabilities[]` **order + data-refs** (works for all actions; the step is `Blocked` until its referenced upstream output exists). `after` = ordering only (NOT a trigger). **`onEvent`** = advanced auto-trigger, valid only for the ~12 `eligibleForEventTrigger` actions that declare an event (`validate_flow` enforces). `runWhen`/`conditions` gate on **static props only** (FE evaluator reads `sourceBlock.props`, not runtime output) and must be authored in the evaluator's operator vocabulary (§2.3, §7.1).
7. **Editor changes: minimal additive exports allowed.** Built in oracle-runtime; we may **add small additive exports** to `@ixo/editor` where cleaner than replicating (notably the fragment helpers for remove/reorder, §7.3) — never changing existing-export behavior or reimplementing the compiler. Consumed version bumped to ≥5.31.0 (§7).
8. **`flowRef` = the Matrix room id** (opaque to the agent); default = `state.editorRoomId`. No registry/lookup (§1).
9. **Room allocation (decided): the FE creates the room over WS.** `create_flow` is two-step — (1) `callBrowserTool('create_flow_room', {title, spaceId})` so the **user's FE** creates a `#flow-*` room (user-owned, parented to the space) and returns `{roomId}` — the verified in-production browser-tool channel; needs a small `create_flow_room` FE tool in the portal; (2) `setupFlowFromBaseUcan({roomId, creatorDid: userDid})` authors into it. This used **only** for benign room allocation, not execution/signing. Edits target `state.editorRoomId`. Fallbacks (same contract): oracle self-creates via construction-time `matrixClient`, or portal pre-creates (§6.5).
10. **Condition operators (decided): use what the evaluator supports.** `Condition.is` is aligned to the FE evaluator's vocabulary (`equals`/`notEquals`/`greaterThan`/`lessThan`/`contains`/`isEmpty`/`isNotEmpty`); no `in`/`exists`. The plugin maps to the evaluator's exact strings on write (§7.1).
11. **Errors:** uniform `{ok:false, error:{code,message}}`; tools never throw to the agent (§6.1).
12. **Proposals:** deferred past v1 (§3.7/§4.4).

**No blocking open items remain.** Remaining product nicety (non-blocking): a deployment may restrict the oracle from creating rooms in the user's space — covered by the §6.5 portal-pre-creates fallback.

---

## Appendix A — Editor package reference

Verified against `@ixo/editor@5.31.0`. Re-verify on each bump (Appendix B).

### A.0 Verified API surface (the parts this plugin uses)

**Flow compiler / read (`@ixo/editor/core`):**

- `compileBaseUcanFlow(plan: BaseUcanFlow, registry: { getActionByCan }): CompiledFlow` — `lib/flowCompiler/compiler.ts`. **Throws** on: non-array/empty capabilities, empty/duplicate id, unknown `can`, trigger→unknown source/event, `block.event` missing source/event, `block.event.all` on non-`eligibleForEventTrigger` action, barrier source missing alias, listener ref→unknown block, condition→unknown source, **trigger cycle** (readable path).
- `setupFlowFromBaseUcan({ plan, roomId, matrixClient, creatorDid, docId?, strategy? }): Promise<{ compiled, roomId, flowId }>` — `strategy: 'full'|'merge'|'patch'`. `full` rebuilds; `merge` adds new ids; `patch` overwrites colliding ids, keeps the rest. `applyMergeResultToFragment` only replaces changed blocks (others' fragment props survive).
- `readCompiledFlowFromYDoc(yDoc): CompiledFlow | null` — reads `qi.flow.*` maps. ⚠ node map omits `props` (read props from the fragment instead — §4.1).
- Fragment helpers (`lib/flowCompiler/documentFragment.ts`): `writeCompiledBlocksToFragment`, `replaceBlockInFragment`, `removeBlockFromFragment`, `removeAllFlowBlocks`, `applyMergeResultToFragment`. Props are written as XML attributes (`createBlockContainer`).
- `mergeCompiledFlows(existing, incoming, 'merge'|'patch')`, `resolveRuntimeRefs(nb, getNodeOutput, triggerContext?)`.
- ⚠ `decompileToBaseUcanFlow` / `readFlowAsBaseUcan` / `readFlowFromEditor` / `readFlow` exist but the **composed read is lossy**: `readCompiledFlowFromYDoc` returns empty per-node `props` (the node map omits them), so `decompile` recovers no `nb` from `props.inputs`; and `decompile` **never** reconstructs `condition` from `props.conditions` even when present. So the plugin does **not** use them — it reads props from the fragment directly (§4.1, §7.1).

**`BaseUcanFlow` (`types/baseUcan.ts`):** `{ kind:'qi.flow.base-ucan', version:'1.0', flowId, title, goal?, meta?{entityDid?,flowUri?,rootIssuer?}, capabilities: FlowCapability[] }`. `FlowCapability = { id, can, with, nb?, condition?: ConditionRef, parallelGroup?, phase?, actor?{authorisedActors?,parentCapability?}, ttl?{absoluteDueDate?,fromEnablement?,fromCommitment?}, trigger?: TriggerSpec, title?, description?, icon? }`. `TriggerSpec = { type:'manual'|'flow.start'|'block.event'|'block.event.all', sourceBlockId?, eventName?, sources?: { sourceBlockId, eventName, alias }[] }` — **note `block.event` triggers require all three per source and the source ACTION must be `eligibleForEventTrigger:true` and declare the `eventName` (else compile throws); only ~12/~55 actions qualify (§2.3).** `ConditionRef = { sourceId, field, operator:'eq'|'neq'|'gt'|'lt'|'in'|'exists', value?, effect? }` — ⚠ the compiler writes `operator` **verbatim** into `props.conditions`, but the FE evaluator only reads `equals|not_equals|greater_than|less_than|contains|is_empty|is_not_empty` with **no normalizer**, so the plugin authors `props.conditions` directly in the evaluator's vocabulary (§7.1), not via `cap.condition`. Compiled edges are `'trigger'` only; **sequence is implicit in `capabilities[]` order**. Field refs compile to `{ $ref:'nodeId.output.field' }`.

**Action registry (`lib/actionRegistry/`):** `getAllActions()`, `getAction(type)`, `getActionByCan(can)`, `typeToCan`/`canToType`/`resolveActionType` — exported from `core/index.ts`. (`getEventsForBlock`/`getOutputSchemaForBlock` exist but are **not** re-exported from `core/index.ts`; the plugin reads each action's `events`/`outputSchema` fields — or calls `getDynamicEvents`/`getDynamicOutputSchema` — directly off the `ActionDefinition`.) `ActionDefinition = { type, can?, sideEffect, defaultRequiresConfirmation, requiredCapability?, inputSchema?, outputSchema?, events?, getDynamicEvents?, getDynamicOutputSchema?, eligibleForEventTrigger?, run }` (no `portType` — that's the plugin overlay, §7.5).

**Runtime state (read-only for the plugin) — `types/authorization.ts` `FlowNodeRuntimeState`:** `state?: 'idle'|'running'|'completed'|'failed'|'cancelled'|'awaiting_readback'`, `output?`, `executedByDid?`, `executedAt?`, `enabledAt?`, `readBack?`, `invocations?`/`lastInvocationCid?`, `assignments?[]`, `commitments?[]`, **`proposals?[]`** (`mode:'inputs_patch'|'output_patch'`, `rationale`, `status:'open'|'accepted'|'rejected'`, `acceptanceInvocationCid`), `pendingPayload?`, **`error?:{message,code?,at,data?}`**, `cache?`, `userInputs?`, legacy `claimId?`/`evaluationStatus?`. Stored in the runtime Y.Map (`lib/flowEngine/runtime.ts` `FlowRuntimeStateManager.get/update`). Run history: `RunRecordDetails` (audit `block.run`).

### A.1 Block palette

Compiler emits one generic `action` block per capability (`COMPILED_BLOCK_TYPE='action'`); the plugin authors everything executable as a `FlowStep`. Specialized blocks (`claim`/`bid`/`evaluator`/`proposal`/`governanceGroup`/`domainCreatorSign`/`notify`/`email`/`apiRequest`) compile to the same action types. `checkbox`/`form`/`domainCreator` → human-form steps. Display/data blocks (`list`, `overview`, `visualization`, `flowLink`, `secrets`, `skills`, …) are document content (editor-plugin territory); the flows plugin may _read_ them but doesn't author them as steps.

### A.2 Survey / form model

SurveyJS. A form step's schema is SurveyJS JSON (`{ title?, pages?[], elements?:[{name,type,title?,isRequired?,visibleIf?,inputType?,choices?,choicesByUrl?}] }`); `answers` is a flat `Record<name,value>` (dropdowns need the underlying `value`). Two surfaces: **block-state forms** (answers persist to `block.props`/runtime — the durable authoring path the plugin targets) and **ephemeral open-survey panels** (`fillOpenSurvey`/`snapshotOpenSurvey`/`useOpenSurveyStore` from `@ixo/editor/mantine` — live UI, FE/session-scoped). Filling writes answers but never submits.

### A.3 Events, triggers & reconciliation

Actions declare `events` (static `events[]` or `getDynamicEvents(inputs)`). A `block.event`/`block.event.all` trigger fires pending invocations at run time (the portal's concern) — **but only if the source action is `eligibleForEventTrigger:true` and declares the named event; the compiler throws otherwise.** Verified: ~12 of ~55 actions qualify (claim/evaluate, domain.sign, email/http, calendar/xero, some pod). So `block.event` is the `onEvent` (advanced) path, NOT general sequencing — `FlowSpec.after` is plain ordering + data-refs (§2.3). The plugin reads the **event vocabulary** off `ActionDefinition` to validate `onEvent` and to build `{sourceBlockId, eventName, alias}` sources; it does not run reconciliation.

### A.4 Hooked actions (`on`)

Lifecycle events fire hooked actions (`sendEmail`, `addLinkedEntity`, `sendMatrixDM`); config interpolates `{{payload.<field>}}` / `{{util.currentDate|…}}`. Stored as `block.props.hookedActions`. `set_step_hooks` writes it; `describe_action` reports available events + hook types.

### A.7 Diff & slide-to-sign (powers `explain_step`)

Action types register a **diff resolver** (`registerDiffResolver(actionType,{resolver})` → `DiffResult[]` of `{key,label,before,after,changeType,unit?,severity?}`) computing a before/after from merged inputs. The portal shows it above a slide-to-sign control at run time. `explain_step` surfaces the same data read-only so the agent can explain a step before the user runs it — no slider, no execution.

### A.8 Templates — **corrected**

`src/core/templates/*` (**carbonHarvest**, **entityTransfer**, **oracleInit**) are exported as legacy `FlowNode[]` with (vestigial) `activationCondition`, **not** `BaseUcanFlow`. `get_flow_template` ships **in-plugin FlowSpec templates** (or converts the exported legacy factories in-plugin, dropping `activationCondition`) — §7.4. No editor change.

_(UCAN/versioning/migration appendices from the earlier draft are omitted — they govern execution authorization, which is out of scope for the builder.)_

---

## Appendix B — Tracking the editor package

Pin `@ixo/editor` exactly; each bump is an intentional PR re-running this checklist.

1. **Core exports** — diff `src/core/index.ts` (compiler + read + registry + fragment helpers + survey helpers the plugin imports).
2. **Action registry** — `getAllActions()` deltas (new types, changed `outputSchema`/`events`). Feeds discovery/linkage + the §5 metadata.
3. **`BaseUcanFlow`/`CompiledFlow` shapes** — the translator's target.
4. **`FlowNodeRuntimeState`** — the read model for `flow_status` (new error/proposal fields).
5. **Block palette** — new executable `action` mappings or display blocks (A.1 boundary).
6. **Form block I/O** — confirm the schema source (`block.props.surveySchema`) and the answers path (runtime `output.form.answers`) the plugin reads/writes are unchanged (§7.2). A change here breaks `fill_form`.

**Drift canaries:** (1) a committed build-time snapshot of `getAllActions()` + `COMPILED_BLOCK_TYPE` — CI fails when it changes after a bump; (2) the FlowSpec round-trip + per-block-isolation tests (§9) — first to break when the compiler/registry/fragment shifts.
