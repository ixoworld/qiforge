# `@ixo/editor` Authoring API — Change Spec (for the Flows plugin)

> **Companion to `spec.md`.** That spec describes the **plugin**; this one describes the
> **small, additive `@ixo/editor/core` surface** the plugin imports so it can be a *thin
> translator* instead of a reverse-engineered shadow of editor internals.
>
> **Status:** design, pre-implementation. Every claim below was verified against
> `@ixo/editor@5.31.0` source (file:line cited). No code written yet.
>
> **Guiding rule (unchanged from `spec.md` §7):** never change the behaviour of an existing
> export; never reimplement the compiler. We only **add** functions, **re-export** existing
> internals, and make **one bug fix** (the condition operator), which is strictly corrective.

---

## 0. Why this exists (the one-paragraph case)

The plugin needs four things the editor doesn't currently expose cleanly: (1) read a flow
**with its per-block props** from a headless Y.Doc, (2) **edit one step's props without
wiping its runtime** or desyncing the node map, (3) **remove/reorder** a step, (4) **fill a
form**. Today the plugin spec plans to hand-roll all four in-plugin by parsing BlockNote's
internal XML shape and replicating unexported helpers — which is where every future
editor-bump bug will live (`spec.md` Appendix B). Since **we own the editor**, the correct
move is to put that shape-coupled logic *inside the editor*, tested against the editor's own
block shape, and let the plugin call ~7 functions. This makes the plugin **smaller, more
correct, and prod-ready**, and fixes a latent condition bug that currently hurts the portal
too.

---

## 1. Verified findings (the ground truth the design rests on)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **Per-block props live ONLY in the `document` XmlFragment**, written as XML attributes on the inner `blockContent` element (with `''`-valued props dropped, and `textColor`/`backgroundColor` hoisted to the container). | `documentFragment.ts:108-125` `createBlockContainer` | The fragment is the single prop store. Reads must parse it; writes must target it. |
| F2 | **The `qi.flow.nodes` map omits props** — `createYMapFromNode` never sets `props`. | `hydrate.ts:173-186` | `readCompiledFlowFromYDoc` returns `props: {}`; `decompileToBaseUcanFlow` recovers no `nb`/`ttl`/`trigger` despite its code trying to. The composed decompile read is **lossy in practice**. |
| F3 | **`title`/`description`/`actor` ARE in the node map** (denormalized — also present as fragment props). | `hydrate.ts:177-184`, `compileBlockProps` `blockMapping.ts:36-55` | A fragment-only edit of these desyncs the node map. A write helper must update both. |
| F4 | **`setupFlowFromBaseUcan(patch/merge)` re-inits runtime for `replaced` nodes** to `{state:'idle'}` unconditionally. | `setup.ts:286-287` → `initializeRuntimeForNodes` `hydrate.ts:161-168` | Editing an already-run step via `patch` **wipes its results/progress**. Edge edits need a runtime-preserving path. |
| F5 | **Condition operators are written verbatim and never evaluate.** Compiler writes `ConditionRef.operator` ∈ `eq\|neq\|gt\|lt\|in\|exists`; the evaluator only understands `equals\|not_equals\|greater_than\|less_than\|contains\|not_contains\|is_empty\|is_not_empty`; the normalizer only *inverts* operators, it does **not** map `eq→equals`. | compiler `compiler.ts:271`, evaluator `conditionEvaluator.ts:20-41`, normalizer `conditionNormalizer.ts:7-16` | A condition authored through `cap.condition` **silently never fires** — for the portal and the editor's own builder, not just the agent. Real bug. |
| F6 | **`classifyNodeState` / `classifyBlockerCause` / `snapshotNode` are exported** and operate on `block` objects with `.props` via `getBlockProps`/`getBlockId`/etc. | `core/index.ts:95-96`, `flowAgent/state.ts`, `flowAgent/utils.ts` | The plugin should **reuse** these for `flow_status`, not reimplement `classifyNodeState`. It just needs to supply `{id,type,props}` blocks. |
| F7 | **No headless "read blocks-with-props from a raw Y.Doc" function exists.** `buildFlowAgentContext` takes `blocks` from the caller (the live React `editor.document`). | `flowAgent/context.ts:22-32` | In a headless plugin (no React editor) the only way to get blocks-with-props today is to parse the fragment. **This is the one keystone primitive to add.** |
| F8 | **Form answers persist to RUNTIME, as a JSON string** at `runtime.output.form.answers`; schema is `block.props.surveySchema`. | `FormPanel.tsx:57-64,118-120` | `fill_form` writes `runtime[blockId].output.form.answers`, must deep-merge `output`, must NOT set `state:'completed'`. |
| F9 | **The snapshot's assignee comes from `props.assignment.assignedActor.did`** — not `authorisedActors`; **`Overdue` keys off `props.ttlAbsoluteDueDate` only**. | `flowAgent/utils.ts:69-82` | `set_step_assignment` must write `props.assignment`; `spec.md`'s mapping (assignTo→authorisedActors) is incomplete. |
| F10 | **`resolveRuntimeRefs` is exported.** | `core/index.ts:174` | The plugin can compute **true data-ref readiness** ("waiting on upstream X's output") — richer than `classifyNodeState`'s flat `Pending`. Feature opportunity (see §6). |

> The headline: the plugin spec's central premise (the read is lossy → must assemble from
> the fragment) is **correct** (F1+F2). But (a) much of the *classification* it planned to
> rebuild already exists (F6), and (b) two traps it didn't catch (F4 runtime-wipe, F3
> desync) make the naive edit path unsafe. This spec closes all of that.

---

## 2. The change set at a glance

Six groups. New surface = **one module (`authoring.ts`) + a few re-exports + one bug fix.**

| Group | Change | Type | Replaces in plugin |
|---|---|---|---|
| **A** | `readFlowDocument(yDoc)` + `readBlocksFromFragment(fragment)` | **new (read)** | the entire multi-source read assembler + fragment XML parsing |
| **B** | `setBlockProps`, `removeFlowNode`, `reorderFlowNodes`, `setFormAnswers` | **new (write)** | the in-plugin `replaceBlockInFragment` replica + remove/reorder + runtime write |
| **C** | `buildBlockConditionsProp()` + compiler operator-map fix | **new helper + bug fix** | the in-plugin condition-operator translation layer |
| **D** | re-export `getEventsForBlock`, `getOutputSchemaForBlock`, fragment helpers | **re-export** | direct off-`ActionDefinition` reads / replicas |
| **E** | (none) document the **reuse** surface | **no change** | the plan to reimplement `classifyNodeState`, status, discovery |
| **F** | idempotent runtime init + `preserveRuntime` on patch | **behaviour-preserving fix** | (closes the F4 trap) |

Everything lives in `@ixo/editor/core` (pure yjs, no React) so the headless plugin can
import it. Physical layout: a new `src/core/lib/flowCompiler/authoring.ts`, re-exported via
`lib/flowCompiler/index.ts` → `core/index.ts`. The fragment-read primitive goes in
`documentFragment.ts` (next to its inverse, `writeCompiledBlocksToFragment`).

---

## 3. Group A — Reading a flow with all props

### A1. `readBlocksFromFragment(fragment: Y.XmlFragment): CompiledBlock[]`

The exact inverse of `writeCompiledBlocksToFragment`/`createBlockContainer`. Lives in
`documentFragment.ts`.

**What it does (move-by-move):**
1. Get the single `blockGroup` (reuse the existing `getExistingBlockGroup`).
2. For each `blockContainer` child: read `id`, `textColor`, `backgroundColor` attributes.
3. Read its first child (`blockContent`): `type = child.nodeName`, `props = child.getAttributes()`.
4. Re-merge `textColor`/`backgroundColor` into `props` (createBlockContainer hoisted them
   out, so to round-trip exactly we fold them back) → `{ id, type, props }`.

**Why this and not the existing reads:** `readCompiledFlowFromYDoc` returns propless nodes
(F2); `decompileToBaseUcanFlow` is lossy (F2). This is the *only* function that recovers the
real props from a headless doc. Putting it in the editor means the BlockNote-shape coupling
(`blockGroup > blockContainer > blockContent`) is **tested against the editor's own writer**
and travels with every version — deleting the biggest item in `spec.md` Appendix B.

**Risk:** couples to the XML shape — but that shape is *defined two functions up the file*,
so a writer change and this reader change land together. Far safer than the same coupling
sitting in a downstream repo.

**Test:** `writeCompiledBlocksToFragment(blocks)` → `readBlocksFromFragment` returns the same
blocks (props included), for empty/single/many blocks and props containing JSON strings.

### A2. `readFlowDocument(yDoc: Y.Doc): FlowDocumentRead | null`

The one call the plugin's `read_flow`/`get_step` use. Composes the three sources.

```ts
interface FlowDocumentRead {
  meta:  CompiledFlow['meta'];
  order: string[];
  edges: CompiledEdge[];
  blockIndex: Record<string, string>;            // nodeId → blockId
  nodes: Array<{
    nodeId: string;
    blockId: string;
    can: string; with: string;
    props: Record<string, string>;               // ← from the fragment (authoritative)
    runtime: FlowNodeRuntimeState;                // ← from the runtime map
  }>;
}
```

**Moves:** `readCompiledFlowFromYDoc` (structure) → `readBlocksFromFragment` (props, keyed by
blockId) → for each node attach `props` (via `blockIndex`) **preferring the fragment value
for the denormalized fields** (F3: fragment wins over the node-map copy of `title`) → attach
`runtime` from `yDoc.getMap('runtime').get(blockId)`. Returns `null` only when there is no
flow at all (mirror `readCompiledFlowFromYDoc`'s null rule).

**What it unlocks:** a lossless, single-call read. The plugin's translator turns this into
FlowSpec; no XML parsing, no decompile, no runtime guessing. **This is the function that
makes the plugin a translator instead of a parser.**

---

## 4. Group B — Editing one step (lossless, runtime-preserving)

### B1. `setBlockProps(yDoc, blockId, partial: Record<string,string>): boolean`

The fast path for **value-only props that live only in the fragment** (`inputs`,
`conditions`, `trigger`, `ttl*`, `icon`, `requiresConfirmation`, `skills`, `hookedActions`,
`assignment`, `surveySchema`). Runtime is **never touched**.

**Moves (one `yDoc.transact`):**
1. Read the current block from the fragment (`readBlocksFromFragment` find by id).
2. Merge `partial` over current props (passing `''` **clears** a prop — documented, matches
   F1's drop-empty rule).
3. `replaceBlockInFragment(fragment, { id: blockId, type, props: merged })`.
4. **Keep the node map in sync (F3):** if `partial` touches `title`/`description`, set those
   on `qi.flow.nodes[nodeId]`; if it touches `authorisedActors`/`parentCapability`, rebuild
   and set the node's `actor` object. Nothing else in the node map carries props.

**Why NOT route this through `setupFlowFromBaseUcan(patch)`:** because **patch re-inits the
replaced node's runtime to idle (F4)** — editing a step that already ran would erase its
result. `setBlockProps` writes the fragment in place and leaves runtime alone. This is the
difference between "agent tweaks a completed step's label" being safe vs. destroying the
user's run. **Core prod-readiness guarantee.**

**Test:** set step B's `inputs`; assert B's runtime intact, A/C/D's props+runtime untouched,
and the node-map `title` stays consistent when `title` is the edited field.

### B2. `removeFlowNode(yDoc, nodeId): { ok: true } | { ok: false; referencedBy: string[] }`

One transaction, runtime-preserving for siblings.

**Moves:** ref-guard first (scan every other node's `trigger.sourceBlockId`/`sources[]`,
`conditions.sourceBlockId`, and `{{nodeId.output.*}}` refs inside `props.inputs`) → if
referenced, return `{ ok:false, referencedBy }` (don't orphan). Otherwise:
`removeBlockFromFragment` + delete from `qi.flow.nodes`/`qi.flow.blockIndex` + splice
`qi.flow.order` + delete touching `qi.flow.edges` + delete the `runtime[blockId]` entry.

**Why in the editor:** it spans fragment + four maps + runtime atomically against the
editor's own schema. Replicating it in the plugin (the `spec.md` §7.3 fallback) is ~30 lines
of shape-coupled yjs that drifts. One tested editor function removes that risk.

### B3. `reorderFlowNodes(yDoc, order: string[]): boolean`

**Moves:** validate `order` is a permutation of `qi.flow.order` → rewrite `qi.flow.order` →
reorder the `blockGroup` children to match (delete+reinsert containers in the new order).
Maps/edges/runtime untouched (sequence is display-only; `block.event` edges are id-based).

### B4. `setFormAnswers(yDoc, blockId, answers: Record<string,unknown>): void`

The headless equivalent of FormPanel's write (F8). **Moves:** read `runtime[blockId]`,
deep-merge `{ output: { ...output, form: { ...output?.form, answers: JSON.stringify(answers) } } }`,
write it back. **Never sets `state:'completed'`** — submission is the user's portal action.

**Fix-mode also needs a step reset.** When the agent fixes a *failed* step on a running flow,
the user must be able to cleanly re-run it — so the editor exposes a focused reset:

```ts
resetStepRuntime(yDoc, blockId): void   // sets { state:'idle', error:undefined, output:{} }
```

This is the headless twin of the editor's existing "Reset" recovery affordance (CLAUDE.md
stale-state recovery) — benign and **non-executing**. Implement both `setFormAnswers` and
`resetStepRuntime` as thin wrappers over one internal `updateNodeRuntime(yDoc, blockId, partial)`
(merge into the runtime entry); keep the public surface to those two focused functions so the
agent can't fake a `completed` state.

---

## 5. Group C — Conditions (fix the bug, share the shape)

### C1. `buildBlockConditionsProp(conditions: FriendlyCondition[]): string`

A single exported helper that produces the **evaluator-vocabulary** `props.conditions` JSON
(the shape `conditionEvaluator.ts` actually reads). Friendly `is` →
`equals|not_equals|greater_than|less_than|contains|is_empty|is_not_empty`.

**Used by two callers** so the shape has one source of truth:
- the plugin's `set_step_conditions` (via `setBlockProps('conditions', …)` — runtime-safe), and
- the compiler's `compileCondition`.

### C2. Compiler operator fix (`compiler.ts` `compileCondition`)

Map `ConditionRef.operator` (`eq/neq/gt/lt/contains/in/exists`) → the evaluator vocabulary
before writing (`eq→equals`, `neq→not_equals`, `gt→greater_than`, `lt→less_than`,
`in→contains`, `exists→is_not_empty`). This makes **every** condition authored through
`cap.condition` actually evaluate — fixing F5 for the portal and the editor's own condition
builder, not only the agent.

**Why both:** the plugin prefers `setBlockProps` for conditions (runtime-safe per F4), so it
needs the shared helper; but the compiler path must also be correct for `create_flow` and
for any non-plugin author. Fixing one without the other leaves a live landmine.

**Test:** author a `runWhen`; assert the written operator is in the evaluator's vocabulary
(never `eq`); a compiled condition round-trips back to the friendly `is`; and (regression) a
`disable`-action condition still normalizes correctly.

---

## 6. Group F — Don't let edits wipe runtime (the F4 fix)

Two minimal, behaviour-preserving editor changes so editing/adding never destroys progress:

1. **Make runtime init idempotent.** In `initializeRuntimeForNodes`, only set
   `{state:'idle'}` when the node has **no** existing runtime entry
   (`if (!runtimeMap.has(blockId))`). This is strictly safer for the portal too — re-running
   a `merge`/`patch` no longer resets a node that already ran. Added nodes still init; replaced
   nodes keep their state.
2. **`preserveRuntime?: boolean` on `SetupFlowOptions`** (default `false` to preserve current
   behaviour) that, when set, skips re-init for `replaced` nodes entirely. The plugin passes
   `true` for any edge-affecting edit of an existing step (`set_step_event`).

> Without this, `set_step_event` on a step that already ran erases its result — invisible
> until a user hits it. This is the single most important correctness fix for "edit a live
> flow," which is a v1 feature.

---

## 7. Group D — Re-exports (one line each, zero logic)

| Re-export | From | Why the plugin needs it |
|---|---|---|
| `getEventsForBlock`, `getOutputSchemaForBlock` | `actionRegistry/registry` | `onEvent` validation (event vocabulary) + `list_referenceable_fields` (output schema, incl. dynamic). Currently **not** in `core/index.ts`. |
| `readBlocksFromFragment`, `removeBlockFromFragment`, `replaceBlockInFragment` | `flowCompiler/documentFragment` | low-level escape hatches; A/B wrap them but exporting keeps the plugin unblocked if it needs a bespoke op. |
| `resolveRuntimeRefs` | already exported | data-ref readiness in `flow_status` (§6 feature). |

---

## 8. Group E — Reuse as-is (NO editor change — documented so the plugin doesn't rebuild it)

| Need | Use | Note |
|---|---|---|
| Validate (compile, no write) | `compileBaseUcanFlow(plan, { getActionByCan })` | catch throws → `validate_flow` |
| Create / add / edge-edit | `setupFlowFromBaseUcan({…, strategy, preserveRuntime})` | `full`/`merge`/`patch` (+ §6 flag) |
| Structure read | `readCompiledFlowFromYDoc` | inside `readFlowDocument` |
| **Per-step status** | **`snapshotNode` / `classifyNodeState` / `classifyBlockerCause`** | **F6 — feed it the `{id,type,props}` blocks from `readFlowDocument`. Do NOT reimplement.** |
| Audit / pending reads | `readRunRecords`, `readPendingInvocations`, `getActionForBlock` | `flow_status` history |
| Discovery / linkage | `getAllActions`, `getAction`, `getActionByCan`, `typeToCan`, `canToType` | + `events`/`outputSchema` off `ActionDefinition` |

### Explicitly DO NOT import (keeps the builder boundary, `spec.md` §6.3)

`executeNode`, `tickFlowAgent`, `FlowAgentService`, `executeFlowAgentCoreCommand`,
`queueAgentCommand`, leases, `createUcanService`, the delegation/invocation stores,
`mint-invocation`. These are the **runner** — the portal owns them. The plugin reads
classification and writes documents; it never executes, signs, or mints a UCAN. (Author-time
"UCAN" is just `props.parentCapability` / `props.authorisedActors` strings — plain metadata,
no crypto.)

---

## 9. How this makes the plugin production-ready & feature-rich

**Production-ready (correctness & maintenance):**
- **No runtime loss on edit** (B1 + F): the headline guarantee for editing live flows.
- **No node-map desync** (B1/F3): reads and writes agree on `title`/`actor`.
- **Conditions actually work** (C): authored gates fire instead of silently passing.
- **Drift contained**: the BlockNote-XML coupling moves into the editor where it's tested
  against the writer — `spec.md` Appendix B shrinks to "diff the action registry + the
  `FlowDocumentRead` shape," not "re-verify XML parsing every bump."
- **One status source of truth** (E/F6): `flow_status` mirrors exactly what the portal shows
  because it's the same `classifyNodeState` — no divergence between "what the agent says"
  and "what the user sees."

**Feature-rich (capabilities the API unlocks):**
- **True readiness in `flow_status`** (F10): layer `resolveRuntimeRefs` over `snapshotNode`
  to turn flat `Pending` into "ready to run" vs "waiting on `load-batches.output.x`" with a
  precise `blockedBy`. The agent can tell the user *exactly* what's missing.
- **Safe live editing**: add/remove/reorder/retune a flow the user is mid-run on, without
  resetting completed steps — enables conversational "actually, change step 3 to…".
- **Accurate diagnosis**: `classifyBlockerCause` gives `missing_input | failed_upstream |
  service_error | external_confirmation_pending | …` straight from the runtime, so
  `flow_status`/`explain_step` explain *why*, not just *that*, a step is stuck.
- **Correct assignment/forms** (F8/F9): `set_step_assignment` writes the prop the snapshot
  actually reads; `fill_form` writes the durable runtime path the portal renders.

---

## 10. Plugin tool → editor API (traceability — every tool is covered)

| Plugin tool | Editor API | Plugin-side logic |
|---|---|---|
| `validate_flow` | `compileBaseUcanFlow` (catch) | translator, friendly errors |
| `create_flow` | FE `create_flow_room` (WS) → `setupFlowFromBaseUcan(full)` | translator (room creation unchanged — FE tool) |
| `read_flow` / `get_step` | **`readFlowDocument`** | → FlowSpec, condition decode |
| `flow_status` | **`snapshotNode`/`classifyNodeState`** (+ `resolveRuntimeRefs`, `readRunRecords`) | blockId↔stepId join, readiness enrichment |
| `explain_step` | diff resolver (read-only) + `classifyBlockerCause` | plain-language render |
| `add_step` | `setupFlowFromBaseUcan(merge)` | delta capability |
| `set_step_*` (value props) | **`setBlockProps`** | route field → prop |
| `set_step_conditions` | **`setBlockProps` + `buildBlockConditionsProp`** | friendly `is` → evaluator vocab |
| `set_step_event` (onEvent) | `setupFlowFromBaseUcan(patch, preserveRuntime:true)` + `getEventsForBlock` (validate) | event-capability check |
| `set_step_assignment` | **`setBlockProps('assignment', …)`** (F9) | write `props.assignment.assignedActor.did` |
| `remove_step` | **`removeFlowNode`** | (ref-guard inside) |
| `reorder_step` / `set_step_sequence` | **`reorderFlowNodes`** | permutation/ordering |
| `fill_form` | **`setFormAnswers`** | SurveyJS validate first |
| `describe_form` | (props from `readFlowDocument`) | flatten SurveyJS |
| `list_actions` / `check_link` | `getAllActions` + **`getOutputSchemaForBlock`** | metadata overlay |

---

## 11. Risks & invariants to preserve

1. **Single prop store stays the fragment.** Never start writing props into `qi.flow.nodes`
   (that would create the dual-source-of-truth we're avoiding). The node map keeps only its
   existing denormalized fields (`title`/`description`/`actor`), and `setBlockProps` keeps
   *those* in sync (F3). Reads are fragment-authoritative.
2. **All writes inside `yDoc.transact()`** (mirror `hydrate.ts`).
3. **No behaviour change to existing exports.** `preserveRuntime` defaults to off; the
   idempotent-init change is strictly safer; the condition fix only corrects a non-working
   path. Existing portal behaviour is unchanged except conditions now actually evaluate.
4. **Version skew with the portal.** The plugin (5.31.0) writes a doc the portal (5.29.0)
   renders/runs. The new functions must emit the **same** fragment/map/runtime shapes 5.29.0
   reads. Add a compat check to the bump checklist: the `FlowDocumentRead` shape + condition
   JSON + `runtime.output.form.answers` path must match what the portal version understands.
5. **Builder boundary intact.** None of the new functions execute, sign, or mint UCANs.

---

## 12. Tests (added in the editor, beside the code)

- **A — round-trip:** `writeCompiledBlocksToFragment` → `readBlocksFromFragment` is identity
  (props, JSON values, color attrs). `readFlowDocument` assembles structure+props+runtime.
- **B1 — isolation & runtime safety:** edit step B's props → A/C/D untouched, B's runtime
  intact, node-map `title` consistent. Clearing a prop with `''` removes it.
- **B2/B3:** remove leaf → maps/fragment/runtime gone, siblings intact, order updated; remove
  referenced → `{ok:false, referencedBy}`; reorder → order+fragment reordered, runtime intact.
- **B4:** `setFormAnswers` writes `output.form.answers` (string), preserves other `output`
  keys, never sets `completed`.
- **C — operator correctness:** compiled & helper-built conditions use evaluator vocab; a
  compiled condition **evaluates** (mount/eval test); disable-normalization regression green.
- **F — no runtime wipe:** `setupFlowFromBaseUcan(patch)` on a node with prior runtime: with
  `preserveRuntime:true` keeps it; idempotent init keeps an already-present node’s state.

---

## 13. Phasing (maps onto `spec.md` §10)

- **PR-E1 (editor):** `documentFragment.readBlocksFromFragment` + `authoring.readFlowDocument`
  + the re-exports (D). Unblocks the plugin's read/translator (plugin PR 2). Lowest risk.
- **PR-E2 (editor):** `setBlockProps` (+ node-map sync), `removeFlowNode`, `reorderFlowNodes`,
  `setFormAnswers`. Unblocks plugin authoring + forms (plugin PR 2/3).
- **PR-E3 (editor):** condition fix (C) + `buildBlockConditionsProp` + runtime-safety (F).
  Can land in parallel; it's corrective. Gate plugin `set_step_conditions`/`set_step_event`
  on it.
- Each editor PR ships its tests (§12) in the editor repo; the plugin pins the new version.

---

## 14. Net surface added to `@ixo/editor`

**New functions (7):** `readBlocksFromFragment`, `readFlowDocument`, `setBlockProps`,
`removeFlowNode`, `reorderFlowNodes`, `setFormAnswers`, `buildBlockConditionsProp`.
**Re-exports (3):** `getEventsForBlock`, `getOutputSchemaForBlock`, the fragment helpers.
**Fixes (2, corrective):** compiler operator map; idempotent runtime init + `preserveRuntime`.

Everything else the plugin needs already exists and is reused. The plugin shrinks to:
**translator + tool surface + action-metadata overlay + in-plugin templates** — exactly the
"thin, leak-proof" shape `spec.md` is aiming for.
