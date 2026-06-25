# Handoff → Plugin Agent: Editor findings + the **Template reframe**

> **From:** the editor-side agent (working in `@ixo/editor`).
> **To:** the agent that authored `spec.md` and the editor plugin.
> **Read first:** `spec.md` (your plugin spec) and `editor-authoring-api.spec.md` (the editor
> API I scoped for you, verified against `@ixo/editor@5.31.0` with file:line citations).
>
> This doc tells you (1) **don't rewrite — refactor**, (2) the **template-not-flow reframe**
> and exactly what it changes, (3) the **editor API contract** we both build against, (4) the
> **corrections** to make in `spec.md` from verified findings.

---

## 0. IMPLEMENTATION STATUS (authoritative — read this first)

> Sections §1–§9 below record the reasoning and went through several scope refinements.
> **Where they differ, THIS section wins.** It reflects what is actually built.

**Shipped in `@ixo/editor` on branch `feat/flow-authoring-api`** (uncommitted, `tsc`-clean,
+22 new tests, full flowCompiler+actionRegistry suite green = 186 tests):

**Final scope (locked):**

- **Templates — author + edit.** The agent creates templates and edits their steps with
  **surgical per-block mutations** (no full rebuild, no compiler-patch). Create/add use the
  existing compiler; edit/remove/reorder use the new per-block functions.
- **Running flows — copilot only.** The agent **reads** (view status/errors), **fills** a live
  form, and **resets** a failed step so the user re-runs. It does **NOT** edit block props on a
  running flow, and never executes / signs / mints.
- **Dropped:** the F4/F6 runtime-preservation work (`preserveRuntime`, idempotent init). It was
  only needed for editing live flows — which is out. Surgical edits don't touch runtime, and
  templates are idle, so there is nothing to preserve.

**The contract — exports now in `@ixo/editor/core`:**

| Purpose                      | Functions                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read** (template + flow)   | `readFlowDocument(yDoc)` → structure + props + runtime; `readBlocksFromFragment`                                                                                                                                                       |
| **Template edit** (surgical) | `setBlockProps(yDoc, blockId, partial)`, `removeFlowNode(yDoc, nodeId)`, `reorderFlowNodes(yDoc, order)`                                                                                                                               |
| **Flow copilot** (runtime)   | `setFormAnswers(yDoc, blockId, answers)`, `resetStepRuntime(yDoc, blockId)`, `updateNodeRuntime`                                                                                                                                       |
| **Conditions**               | `buildBlockConditionsProp(conditions)`, `toEvaluatorOperator` (+ the compiler now emits the evaluator vocabulary — the silent-no-eval bug is fixed)                                                                                    |
| **Re-exports**               | `getEventsForBlock`, `getOutputSchemaForBlock`, `writeCompiledBlocksToFragment`, `replaceBlockInFragment`, `removeBlockFromFragment`                                                                                                   |
| **Reuse (pre-existing)**     | `setupFlowFromBaseUcan` (full/merge — create/add), `readCompiledFlowFromYDoc`, `classifyNodeState`/`classifyBlockerCause`/`snapshotNode` (flow_status), `getAllActions`/`getActionByCan`/`typeToCan`/`canToType`, `resolveRuntimeRefs` |

**Behavior notes for the plugin:**

- `setBlockProps` is surgical (fragment only, runtime untouched) and keeps the node-map
  `title`/`description`/`actor` in sync. Pass `''` to clear a prop.
- `removeFlowNode` returns `{ ok:false, referencedBy:[…] }` if another step references the node
  (trigger / condition / `{{node.output.*}}` input) — it never orphans a ref.
- `reorderFlowNodes` needs a permutation of the current order; it reorders the fragment too
  unless the doc contains inline prose (then logical order only — no content loss).
- Conditions: build the prop with `buildBlockConditionsProp(...)` and write it via
  `setBlockProps(blockId, { conditions })`. Survey mechanics for `form` vs `claim`: see
  Appendix A.

---

## 1. TL;DR decisions

1. **Do NOT start from zero.** The mechanics (FlowSpec/TemplateSpec ⇄ BaseUcanFlow, compile,
   read, per-step edit, discovery, linkage, validation, leak guard) are **identical** for
   templates and flows. Reframe + simplify the existing spec/plugin. Reasoning in §2.
2. **Reframe: the agent builds TEMPLATES, not flow instances.** A template is the _creation_
   artifact; a flow is the _running_ instance. The editor already models this split
   (`docType:'template'`, `clearRuntimeForTemplateClone`, `source_template_id`). Details §3.
3. **Consume the editor API, stop reverse-engineering internals.** I'm adding ~6 functions to
   `@ixo/editor/core` so your plugin is a thin translator. Contract in §4.
4. **Two modes, one hard boundary.** The agent **authors templates** (creation) **and fixes
   running flows** (view runtime errors + edit config to fix them). The _only_ thing it never
   does is **execute / sign / mint a UCAN** — the **user** runs each step. So the runtime
   APIs (read status/errors, runtime-preserving edits) **stay in scope**. See §3.3, §4, §6.

---

## 2. "Start from zero?" — verdict: **No. Redirect.**

Keep the spec and the plugin. Here's why a rewrite would be wasted motion:

- **The new editor info mostly REMOVES work, it doesn't invalidate your design.**
  `classifyNodeState`/`snapshotNode` already exist (don't reimplement); the lossy-read
  problem is solved by one editor function (`readFlowDocument`); the condition-operator bug
  is fixed at the source. Your §2 abstraction, §4 per-block-delta principle, §5 metadata
  overlay, §8 safety model, §9 tests are all still right.
- **The template reframe is a re-labelling + a room-type change, not a redirection.** Authoring
  targets `#template-*` docs; the _same_ read/status/edit machinery also serves fix-mode on
  `#flow-*` docs. The runtime/status half isn't removed — it's **reused** from the editor
  (`classifyNodeState` et al.) instead of hand-rolled, which is the drift win.
- **A rewrite throws away the verified research** (the §A.0 API surface, the sequencing
  model, the leak guard, the room model) that took real effort to get right.

So: **refactor in place.** Rename, delete the runtime tools, swap the read/edit internals for
the editor API, fix the four factual corrections in §5. That's a focused PR, not a restart.

---

## 3. The Template reframe — concretely

### 3.1 The model (why this is correct)

```
   AGENT builds            PORTAL instantiates            USER runs
   ┌──────────────┐        clearRuntimeForTemplateClone   ┌──────────────┐
   │  TEMPLATE    │  ──────────────────────────────────►  │   FLOW       │
   │ #template-*  │        (clone room, wipe runtime,      │  #flow-*     │
   │ docType:     │         stamp source_template_id)      │  docType:    │
   │ 'template'   │                                        │  'flow'      │
   └──────────────┘                                        └──────────────┘
   creation/design                                         running/execution
```

- A **template** is a flow document that has never been run: same `qi.flow.*` structure, same
  blocks/props/fragment, runtime all-idle. It lives in a `#template-*` room with
  `root.docType = 'template'`.
- The portal's existing **instantiate** path (`instantiateTemplate` / `cloneFromProtocol` +
  `clearRuntimeForTemplateClone`) turns a template into a running `#flow-*` flow.
- **The agent operates in BOTH places:**
  - **Author mode** (`#template-*`, `docType:'template'`): create/edit the blueprint.
  - **Fix mode** (`#flow-*`, `docType:'flow'`): the user runs the flow; when a step **errors**
    or the user **requests a change**, the agent **reads the runtime error** and **edits the
    live flow's config to fix it** — _runtime-preserving_ (completed steps keep their
    results), then the **user re-runs** the fixed step.
- **The hard boundary** (unchanged): the agent never **executes / signs / mints a UCAN**. In
  fix mode it reads runtime, edits config, and may **reset a failed step to idle** (clear the
  error so the user can re-run) — but the _running itself_ is always the user's action.

### 3.2 Rename map (search-and-replace, semantics preserved)

| Old (flow)                 | New (template)                                                                    |
| -------------------------- | --------------------------------------------------------------------------------- |
| `FlowSpec`                 | `TemplateSpec`                                                                    |
| `flowRef`                  | `templateRef` (still = the Matrix room id, opaque)                                |
| `create_flow`              | `create_template`                                                                 |
| FE tool `create_flow_room` | FE tool `create_template_room` (creates `#template-*`, sets `docType:'template'`) |
| `read_flow` / `get_step`   | `read_template` / `get_step` (no runtime/status fields)                           |
| `get_flow_template`        | `get_starter_template` (in-plugin starter TemplateSpecs)                          |
| "the user runs the flow"   | "the user instantiates the template into a flow and runs it"                      |

`TemplateSpec` = your `FlowSpec` **minus** `step.status` and any runtime-derived field. The
`steps[]` authoring shape (id, action, inputs, form schema, after, runWhen, onEvent, trigger,
due, assignTo, on, skills, requireConfirmation) is unchanged.

### 3.3 What's IN, and the one thing that's OUT

**IN — author mode (templates):** create/edit the blueprint (steps, actions, inputs,
conditions, triggers, schedule, assignee, hooks, skills, form _schema_ + defaults). No
runtime here — a fresh template is all-idle.

**IN — fix mode (running flows):** because the user runs the flow and hits errors/changes:

- **View errors / status:** `read_flow` (with runtime), `flow_status` — reuse the editor's
  **`classifyNodeState` / `classifyBlockerCause`** (they already exist — §6 of the editor
  spec). Gives `Done/Blocked/Overdue/Pending` + a typed cause (`missing_input`,
  `failed_upstream`, `service_error`, `external_confirmation_pending`, …) + run-error message.
- **Make changes (runtime-preserving):** edit the failed/affected step's config via
  **`setBlockProps`** (completed steps keep their results — this is why the F4/F6 fixes
  matter). Edge edits go through `setupFlowFromBaseUcan(patch, preserveRuntime:true)`.
- **Reset a fixed step:** clear its error → idle (`resetStepRuntime` / `updateNodeRuntime`,
  §4) so the user can cleanly re-run it. This is the editor's existing "Reset" recovery
  affordance, not execution.
- **Pre-fill a live form** (optional): `setFormAnswers` writes `runtime.output.form.answers`
  (never sets `completed` — the user submits).

**OUT — the hard boundary:** **executing a step, signing, minting a UCAN.** The agent reads
runtime, edits config, and resets errors; it never runs. The portal/user runs. This keeps the
security story trivial (`spec.md` §6.3) while still letting the agent diagnose and fix.

### 3.4 KEEP (both modes)

- All authoring: `add_step`, `update_step`, `remove_step`, `reorder_step`, the `set_step_*`
  mutators (inputs, conditions, trigger, sequence, event, schedule, assignment, hooks,
  skills, confirmation), `connect_steps`, `update_meta`, `validate`, `create_template`.
- Discovery + linkage: `list_actions`, `describe_action`, `list_referenceable_fields`,
  `check_link`, `compatible_actions`, `requirements` + the metadata overlay (`spec.md` §5/§7.5).
- **Status + diagnosis (fix mode):** `read_flow` (with runtime), `get_step` (incl. status),
  `flow_status`, `explain_step` — backed by the editor's `classifyNodeState`/
  `classifyBlockerCause` and the runtime/audit reads. This is how the agent **views the
  errors**.
- **Forms — two surfaces:**
  - _Template-time:_ `describe_form` reads `block.props.surveySchema`; `set_form_defaults`
    authors default values into the schema (not a runtime write).
  - _Fix-time:_ `fill_form` pre-fills a live flow's answers (`setFormAnswers` →
    `runtime.output.form.answers`), **never submitting** — the user submits in the portal.
- `read` (structure + props + runtime), `explain_step` (diff resolver, read-only).
- Starter templates as in-plugin `TemplateSpec` (`spec.md` §7.4).

### 3.5 Room creation (your decided FE-tool path, retargeted)

`create_template` → `callBrowserTool('create_template_room', { title, spaceId })`. The FE
creates a **`#template-*`** room, **owner = user**, **`root.docType = 'template'`**, returns
`{ roomId }`. Then `setupFlowFromBaseUcan({ plan, roomId, creatorDid: userDid })` authors into
it. (Editor change NOT needed for docType — the FE sets it at room creation. Optionally I can
add a `docType?` param to `setupFlowFromBaseUcan` as a belt-and-suspenders; tell me if you
want it.)

---

## 4. Editor API contract (build against these — I own delivering them)

From `editor-authoring-api.spec.md`, **trimmed to the template scope** (runtime writers
dropped). These are the functions you import from `@ixo/editor/core`; do **not** reimplement
them:

```ts
// READ (replaces your multi-source fragment-parsing assembler) — runtime IS used (fix mode)
readFlowDocument(yDoc): {
  meta; order; edges; blockIndex;
  nodes: Array<{ nodeId; blockId; can; with; props: Record<string,string>; runtime }>;
} | null
readBlocksFromFragment(fragment): CompiledBlock[]   // low-level primitive (rarely needed directly)

// WRITE — config (replaces your in-plugin replaceBlockInFragment replica + remove/reorder)
setBlockProps(yDoc, blockId, partial): boolean      // value props; keeps node-map title/desc/actor in sync; RUNTIME-PRESERVING
removeFlowNode(yDoc, nodeId): { ok } | { ok:false; referencedBy: string[] }
reorderFlowNodes(yDoc, order): boolean

// WRITE — runtime (fix mode only; benign, non-executing)
setFormAnswers(yDoc, blockId, answers): void        // pre-fill a live form; never sets 'completed'
updateNodeRuntime(yDoc, blockId, partial): void     // headless twin of updateRuntime; used for resetStepRuntime
resetStepRuntime(yDoc, blockId): void               // { state:'idle', error:undefined, output:{} } — clear a failed step so user re-runs

// CONDITIONS (replaces your operator-translation layer; fixes the real bug)
buildBlockConditionsProp(conditions): string        // emits the evaluator's vocabulary

// RE-EXPORTS you also get
getEventsForBlock, getOutputSchemaForBlock          // onEvent validation + reference fields
```

**Already exported, reuse as-is:** `compileBaseUcanFlow`, `setupFlowFromBaseUcan`
(with `preserveRuntime:true` for edge edits on a live flow), `readCompiledFlowFromYDoc`,
`mergeCompiledFlows`, **`classifyNodeState` / `classifyBlockerCause` / `snapshotNode`** (your
`flow_status`/diagnosis — do NOT reimplement), `readRunRecords` / `readPendingInvocations`
(audit/history), `getAllActions`, `getAction`, `getActionByCan`, `typeToCan`, `canToType`,
`resolveRuntimeRefs` (data-ref readiness), `clearRuntimeForTemplateClone` (portal-only, FYI).

> **Coordination:** I deliver these in editor PRs E1 (read+re-exports) → E2 (config write +
> runtime write + the F4/F6 runtime-safety fixes) → E3 (condition fix). You pin the new
> `@ixo/editor` and build against E1+E2. Until E1 lands you can prototype against
> `readCompiledFlowFromYDoc` + a temporary local fragment read, but **delete that** once
> `readFlowDocument` ships — don't keep two readers.

---

## 5. Corrections to `spec.md` (verified against source — apply these)

1. **The composed decompile read IS lossy — confirmed.** `qi.flow.nodes` omits props
   (`hydrate.ts:173` `createYMapFromNode`), so `readCompiledFlowFromYDoc`/`decompile` return
   `props:{}`. Your multi-source-read instinct was right; just swap your hand-rolled assembler
   for `readFlowDocument` (§4).
2. **Condition operators never evaluate — confirmed real bug.** Compiler writes `eq` verbatim
   (`compiler.ts:271`); evaluator only reads `equals/...` (`conditionEvaluator.ts:20`); the
   normalizer does NOT map them (`conditionNormalizer.ts:7`, inversion only). Author
   conditions via `setBlockProps('conditions', buildBlockConditionsProp(...))`. I'm also
   fixing the compiler so the `cap.condition` path works for everyone.
3. **Assignment maps to the wrong prop in your table.** The snapshot/portal read the assignee
   from **`props.assignment.assignedActor.did`** (`flowAgent/utils.ts:69`), not
   `authorisedActors`. `set_step_assignment` must write `props.assignment`. (`authorisedActors`
   is the _authorization_ whitelist — separate concern, and authorization is the portal's, so
   you may not even author it.)
4. **`title`/`description`/`actor` are denormalized into the node map AND the fragment**
   (`hydrate.ts:177-184`). A fragment-only write desyncs them — `setBlockProps` handles the
   sync for you, so always go through it, never a raw fragment poke.
5. **`activationCondition` is vestigial — confirmed** (only in type + template files; no engine
   reads it). Sequencing = `capabilities[]` order + data-refs, exactly as your §2.3 says. Keep
   that model; it's correct.

---

## 6. What the editor API replaces / reuses (the wins)

Brittle in-plugin code you **delete** (the editor now owns it, tested against its own shape):

- ❌ the multi-source read assembler + BlockNote XML parsing → ✅ one `readFlowDocument` call.
- ❌ the in-plugin `replaceBlockInFragment` replica + remove/reorder yjs → ✅ `setBlockProps` /
  `removeFlowNode` / `reorderFlowNodes`.
- ❌ the condition operator-translation layer → ✅ `buildBlockConditionsProp` + the compiler fix.
- ❌ your planned **reimplementation of `classifyNodeState`** for `flow_status` → ✅ reuse the
  exported `classifyNodeState` / `classifyBlockerCause` / `snapshotNode`.
- ❌ most of Appendix B's drift surface (the XML-shape coupling now lives in the editor).

What the runtime APIs **enable** (the fix-mode features — view errors + change live flows):

- ✅ **View errors:** `read_flow`/`flow_status` over `classifyNodeState`/`classifyBlockerCause`
  - run-error message — the agent sees exactly which step failed and why.
- ✅ **Change without losing progress:** `setBlockProps` edits a failed step in place while
  completed steps keep their results (the F4/F6 runtime-safety fixes make this safe — this is
  the headline correctness guarantee for editing a live flow).
- ✅ **Get the user re-running:** `resetStepRuntime` clears the fixed step's error → idle.

Net: the plugin becomes **translator + tool surface + metadata overlay + starter templates**,
with the heavy/brittle parts moved into one tested editor dependency. That's the prod-ready,
leak-proof shape `spec.md` was reaching for — now covering both authoring and live fixes.

---

## 7. Sequencing (who does what)

| Step                                                                                                                                                                               | Owner            | Output                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------ |
| Editor PR-E1: `readFlowDocument` + `readBlocksFromFragment` + re-exports                                                                                                           | **me (editor)**  | unblocks your read/translator                          |
| Editor PR-E2: `setBlockProps` / `removeFlowNode` / `reorderFlowNodes` + runtime writers (`setFormAnswers` / `updateNodeRuntime` / `resetStepRuntime`) + F4/F6 runtime-safety fixes | **me (editor)**  | unblocks authoring **and** runtime-preserving fix-mode |
| Editor PR-E3: condition fix + `buildBlockConditionsProp`                                                                                                                           | **me (editor)**  | unblocks conditions                                    |
| Plugin: add `create_template`/`#template-*`, swap in the editor read/edit/status API, wire fix-mode (view errors + runtime-preserving edit), apply §5 corrections                  | **you (plugin)** | template builder + flow fixer                          |
| Portal: add `create_template_room` FE browser tool (`#template-*`, docType:'template')                                                                                             | portal team      | unblocks `create_template`                             |

Confirm the editor API signatures (§4) work for your translator **before** I implement E1–E3
— if a return shape is awkward for you, say so now, that's the point of this handoff.

---

## 8. Guardrails (unchanged)

- **Builder boundary:** never import the runner (`executeNode`, `tickFlowAgent`,
  `FlowAgentService`, leases, `createUcanService`, delegation/invocation stores,
  `mint-invocation`). The plugin authors templates and reads their structure — nothing runs,
  signs, or mints a UCAN.
- **"UCAN" at author time = metadata strings only** (`props.parentCapability`,
  `props.authorisedActors`) — and even those may be out of scope since authorization is the
  portal's. Default to NOT authoring authorization in a template.
- **Leak guard holds:** no tool I/O mentions `block`/`blockId`/`props`/`yDoc`/`roomId`/`can`/
  `with`/`nb`/`CID`/`CAR`/`delegation`. `templateRef` stays opaque (= room id internally).
- **All Y.Doc writes in `yDoc.transact()`.**

---

## 9. Scope decision — **RESOLVED** ✅

The agent has **two modes** on the same kind of document:

1. **Author templates** (`#template-*`, `docType:'template'`) — the creation product. Forms
   here = author **questions + defaults** in the survey schema.
2. **Fix running flows** (`#flow-*`, `docType:'flow'`) — the user runs the flow; when a step
   **errors** or the user **requests a change**, the agent **views the runtime error** and
   **edits the live flow's config to fix it** (runtime-preserving), then the **user re-runs**.
   Forms here = `fill_form` pre-fills live answers (never submits).

**Hard boundary (never crossed):** the agent does not **execute / sign / mint a UCAN**. It
reads runtime, edits config, and resets a fixed step's error to idle — running is always the
user's action. This keeps `spec.md`'s trivial security story intact while delivering "view
errors + make changes."

> Both modes share the same translator, read, and edit machinery — there is no second plugin.
> The runtime APIs (`flow_status`, `classifyNodeState` reuse, `setBlockProps` runtime-preserving,
> `setFormAnswers`, `resetStepRuntime`, the F4/F6 safety fixes) are **in scope** and back in
> the editor contract (§4).

---

## Appendix A — Survey mechanics: `form` vs `claim` (READ THIS before building form tools)

**Decision (user, 2026): the claim block's survey mechanism stays exactly as-is — no editor
change. This is documentation so you handle the two block families correctly.** There are
**two different survey models**, and your `describe_form` / `set_form_defaults` / `fill_form`
tools must branch on which one a step is.

### Model A — `form` / `domainCreator` blocks: schema **stored in the block**

```
author writes SurveyJS JSON  →  block.props.surveySchema  (JSON string, in the fragment → Y.Doc)
FE renders:  JSON.parse(props.surveySchema) → new SurveyModel(schema) → <Survey/>   (FormPanel.tsx)
answers persist to:  runtime.output.form.answers  (JSON string)
```

- The schema **is the block's own data.** You can author it directly: `setBlockProps(blockId,
{ surveySchema: <json> })`. `describe_form` reads `props.surveySchema`; `set_form_defaults`
  writes default values into that schema; `fill_form` writes `runtime.output.form.answers`
  (via `setFormAnswers`).
- This is the model your form tools target. Clean and self-contained.

### Model B — `claim` block (`qi/claim.submit`): schema **fetched from chain, NOT stored**

```
author picks deedDid + collectionId   ← the ONLY survey-related thing the block stores
FE renders:  handlers.getDeedSurveyTemplate(deedDid, collectionId) → SurveyModel → <Survey/>
the block also stores a DERIVED `surveyAnswersSchema` (flat field list) in inputs — for the
reference picker / event payloads only, NOT the SurveyJS JSON itself.
```

- The claim block is a **pointer to an on-chain collection's survey**, not a container of one.
  You **cannot** "set a survey" on a claim step — you bind a **collection** and the survey
  follows from chain. `surveyAnswersSchema` is materialised from that collection's survey
  (`extractSurveyAnswerSchema`) at config time and drives `output.surveyAnswers.<q>` refs.
- Implication for your tools on a **claim** step:
  - `describe_form` must read the collection's survey via the host (`getDeedSurveyTemplate`),
    **not** a stored `surveySchema` prop (there is none).
  - There is **no author-set survey** to write — so `set_form_defaults` doesn't apply; the
    survey is collection-defined.
  - Filling a claim is the **on-chain submission** flow (PIN, signing) — that's _running_, so
    it stays the user's job in the portal, not a builder action.
  - (There is a latent `surveyJson` override branch in `ClaimFlowDetail`, but it is **not**
    wired to any input and we are **not** changing that — treat the claim survey as
    chain-sourced.)

### Net rule for your form tools

| Step type               | survey source                       | `describe_form`                                     | author/fill                                                            |
| ----------------------- | ----------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `form`, `domainCreator` | `props.surveySchema` (in the block) | read the prop                                       | author schema + `set_form_defaults`; `fill_form` → runtime             |
| `claim`                 | on-chain collection (fetched)       | call `getDeedSurveyTemplate(deedDid, collectionId)` | bind a collection (no author-set survey); submission is the user's run |
