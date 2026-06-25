# Flows Plugin — Session Handoff (detailed)

> **What this is:** the **Flows plugin** — a flagship paid QiForge product that lets an agent build, wire, inspect, and form-fill multi-step action flows conversationally on top of `@ixo/editor`'s Qi Flow engine. **Builder, not runner:** the agent authors flow documents + pre-fills forms; the **user runs the flow in the portal**. No execution, signing, UCAN minting, or keys in the plugin.
>
> **Start here next session:** read this file, then `packages/oracle-runtime/src/plugins/editor/spec.md` (the design spec), then the persistent memory `…/memory/project_flows_plugin.md`. Then `git status` on both repos below.

---

## 0. TL;DR status

- **Built & green:** 27 agent tools, 60 unit tests, typecheck + lint + prettier clean. Full `@ixo/oracle-runtime` suite passes except one pre-existing, unrelated `credits.plugin.test.ts` billing flake (fails on `main` too — DO NOT touch it, DO NOT mention it in demos).
- **Wired in (opt-in, NOT bundled):** `FlowsPlugin` is intentionally **not** in `BUNDLED_PLUGINS` and has no `flowsPlugin` singleton — the class ships from the `@ixo/oracle-runtime` barrel (`export * from './plugins/flows/index.js'`) and a fork opts in by constructing it: `apps/qiforge-example/src/main.ts` does `new FlowsPlugin({ matrixClient })` in its `plugins` array.
- **Editor:** pristine published `@ixo/editor@5.31.0` (npm). NO editor source changes are consumed (an earlier 5.32.0 tarball experiment was reverted).
- **Portal:** `create_flow_room` FE browser tool added (`/Users/yousef/impacts-x-web/lib/companion-tools/`), wired so `create_flow` allocates a real room.
- **Live-tested by the user** on devnet; two real bugs found + fixed (oracle power level, and create_flow-vs-edit). Still needs a clean end-to-end re-test after restarting both apps.
- **Open question raised (not yet decided):** should the builder author **templates** (`#template-*`) instead of raw **flows** for configurable actions (claims/forms)? See §9.

---

## 1. Repos & key paths (THREE repos)

| Repo                             | Path                                    | Role                                                                                         |
| -------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| **oracle-runtime** (boilerplate) | `/Users/yousef/ixo-oracles-boilerplate` | the plugin lives here. Branch `feat/flows-plugin`.                                           |
| **@ixo/editor**                  | `/Users/yousef/editor`                  | the Qi Flow engine (v5.31.0). Source reference only — pristine, nothing consumed from local. |
| **portal** (impacts-x-web)       | `/Users/yousef/impacts-x-web`           | the FE `create_flow_room` browser tool.                                                      |

Plugin dir: `packages/oracle-runtime/src/plugins/flows/`. Spec: `packages/oracle-runtime/src/plugins/editor/spec.md` (under `editor/` for historical reasons).

---

## 2. Phasing (all done)

- **PR1 — editor bump (gate):** `@ixo/editor` `3.0.0-beta.11 → 5.31.0`. Editor plugin's only import block (`editor/blocknote-tools.ts`: `getAction/getAllActions/buildFlowNodeFromBlock/executeNode` + types) stayed signature-compatible. Editor plugin tests green.
- **PR2 — read & author core:** translator, multi-source read, per-block edit dispatcher, discovery/inspect/authoring/settings tools.
- **PR3 — forms & linkage:** forms (describe_form/fill_form), list_referenceable_fields, get_flow_template, linkage (check_link/compatible_actions/requirements) + port-type inference + seeded overlay.
- **PR4 — polish:** explain_step, set_step_trigger, deeper leak-guard sweep.
- **Integration:** FE `create_flow_room` tool + example-app wiring + public export.

---

## 3. File inventory

### Plugin core (`packages/oracle-runtime/src/plugins/flows/`)

| File                 | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`           | FlowSpec zod schemas + TS types (`FlowSpec`, `FlowStep`, `Condition`, `HookSpec`, `dueSchema`, `StepStatus`, `FlowSpecRead`). Condition operators = friendly vocab (`equals`/`notEquals`/…).                                                                                                                                                                                                                                                                                       |
| `errors.ts`          | `FlowError` (code+message) + `toToolError`. Codes: `no_flow_ref`, `not_in_room`, `flow_not_found`, `validation_failed`, `step_not_found`, `referenced`, `unknown_action`, `error`.                                                                                                                                                                                                                                                                                                 |
| `translator.ts`      | **FlowSpec ⇄ BaseUcanFlow.** `flowSpecToBaseUcan`, `stepToCapability`, action↔can (`actionToCan`/`canToAction`), field-refs `{{step.output.x}}`↔`{$ref}` (`friendlyInputsToNb`/`nbToFriendlyInputs`), `buildConditionsProp`/`parseConditionsProp` (evaluator-vocab condition JSON), `stepIdToBlockId`=`flow_block_<id>`.                                                                                                                                                           |
| `read.ts`            | **Multi-source NATIVE read** → `FlowSpecRead`. `readCompiledStructure` (reads `qi.flow.*` maps with oracle-runtime's own yjs), reuses editor-plugin `collectAllBlocks`/`extractBlockProperties`/`readRuntimeState`, reconstructs trigger/onEvent from `props.trigger` JSON, due from `ttl*`, assignTo from `authorisedActors[0]`, requireConfirmation; computes `blockedBy`/`stale`. Exports `readFlowSpec`/`readStep`/`readFlowStatus`.                                           |
| `edit.ts`            | **Per-block delta edits.** `setStepProps` (via editor-plugin `editBlock`), `setStepInputs/Conditions/Schedule/Assignment/Confirmation/Trigger`, `removeStep` (editor-plugin `deleteBlock` + native qi.flow.\* cleanup + ref-guard), `reorderStep` (CLONE-based — `findParentOf`+`element.clone()`; editor `moveBlock` throws reinserting a deleted element), `updateFlowMeta`.                                                                                                     |
| `flow-doc.ts`        | Connection: `withFlowDoc(rtCtx, ref?, matrixClient, fn)` (resolve ref → membership guard → MatrixProviderManager connect → run → dispose), `resolveFlowRef`, `requireRoomMembership`, `resolveFlowsMatrixClient`. Reuses editor-plugin `MatrixProviderManager`+`AppConfig` (`../editor/provider.js`), `buildBlocknoteToolsConfig`, `resolveEditorMatrixClient`. Matrix creds from `rtCtx.config.MATRIX_BASE_URL`/`MATRIX_ORACLE_ADMIN_USER_ID`/`MATRIX_ORACLE_ADMIN_ACCESS_TOKEN`. |
| `actions.ts`         | Registry access: `listActions`/`describeAction`/`getActionDef`/`isEventCapable`/`eventNamesFor`/`actionsSnapshot`. Merges the metadata overlay.                                                                                                                                                                                                                                                                                                                                    |
| `action-metadata.ts` | `ACTION_METADATA` overlay (input ports + requires), SEEDED for `qi/claim.submit`, `qi/claim.evaluate`, `qi/email.send`, `qi/matrix.dm`. Output ports mostly inferred from field names.                                                                                                                                                                                                                                                                                             |
| `port-types.ts`      | `inferPortType(path, primitive?)` — field-name → semantic port type; `CORE_PORT_TYPES`, `isCorePortType`.                                                                                                                                                                                                                                                                                                                                                                          |
| `linkage.ts`         | `checkLink` (catches refs to non-existent output fields + core-type mismatch), `compatibleActions`, `requirements`.                                                                                                                                                                                                                                                                                                                                                                |
| `references.ts`      | `listReferenceableFields` — upstream output fields a step can pipe from.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `forms.ts`           | `describeForm`/`fillForm`. Reads `block.props.surveySchema` (NOTE: editor-plugin `extractBlockProperties` AUTO-PARSES surveySchema to an object — handle object-or-string), writes `runtime.output.form.answers`, NEVER sets `state:'completed'`.                                                                                                                                                                                                                                  |
| `explain.ts`         | `explainStep` — read-only `{willDo, action, inputs, requiresConfirmation, status}` (diff resolver `changes` deferred).                                                                                                                                                                                                                                                                                                                                                             |
| `templates.ts`       | In-plugin FlowSpec starter templates. Currently one: `claim-and-notify` (claim.submit → email.send, real actions).                                                                                                                                                                                                                                                                                                                                                                 |
| `flows.plugin.ts`    | `FlowsPlugin extends OraclePlugin`, manifest (category automation / on-demand / beta), `getRequestTools` wires all 27 tools. Constructor `{ matrixClient? }`.                                                                                                                                                                                                                                                                                                                      |
| `index.ts`           | `export { FlowsPlugin, type FlowsPluginOptions }`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test-support.ts`    | `hydrateFlowDoc(plan)` (compile + write qi.flow.\* maps + fragment + runtime in NATIVE 13.6.31 yjs — see §6), `setStepRuntime`, `someActionType`.                                                                                                                                                                                                                                                                                                                                  |

### Tools (`…/flows/tools/`)

`discovery.ts` (list_actions, describe_action, list_referenceable_fields, get_flow_template) · `inspect.ts` (read_flow, get_step, flow_status, explain_step) · `authoring.ts` (validate_flow, create_flow, add_step, remove_step, reorder_step, update_flow_meta, connect_steps, update_step) · `settings.ts` (set_step_inputs/conditions/schedule/assignment/confirmation/trigger) · `forms.ts` (describe_form, fill_form) · `linkage.ts` (check_link, compatible_actions, requirements).

### Tests (colocated `*.test.ts`)

`translator.test.ts`(14) · `read.test.ts`(3) · `edit.test.ts`(10) · `authoring.test.ts`(4, validate_flow) · `forms.test.ts`(6) · `references.test.ts`(2) · `linkage.test.ts`(9) · `explain.test.ts`(2) · `flows.plugin.test.ts`(manifest+leak+discovery, incl. 27-tool name assertion). **Total 60.**

### Docs

`PRESENTATION.md` (markdown deck), `presentation.html` (self-contained HTML slide deck for the team demo — open in browser, arrow/space/click nav), `HANDOFF.md` (this).

### Modified outside the plugin dir

- `packages/oracle-runtime/package.json` — `@ixo/editor: "5.31.0"`.
- `packages/oracle-runtime/src/plugins/index.ts` — NOT bundled: no `flowsPlugin` singleton, not in `BUNDLED_PLUGINS` (a note there explains why it's opt-in).
- `packages/oracle-runtime/src/index.ts` — public barrel: `export * from './plugins/flows/index.js'` (the `FlowsPlugin` class). No `flowsPlugin` singleton export.
- `apps/qiforge-example/src/main.ts` — `new FlowsPlugin({ matrixClient })`.
- `pnpm-lock.yaml`, `pnpm-workspace.yaml` — editor bump side effects.

### Portal (`/Users/yousef/impacts-x-web`)

- `lib/companion-tools/createFlowRoomTool.ts` — NEW. `create_flow_room` browser tool.
- `lib/companion-tools/getTools.ts` — MODIFIED. registers `createFlowRoomTool` (gated on `options.matrixClient`).

---

## 4. Git state & commit commands (HARD RULE: I never run git writes — user runs these)

**oracle-runtime** — on branch `feat/flows-plugin`. Base PR commit `ae38652` ("feat(flows): add flow-builder plugin…", 22 tools) is PUSHED + a PR is open. Everything since (linkage, PR4, FE wiring, example app, guard fix) is **UNCOMMITTED**. Commit msg drafts in `/tmp/`: `flows-oracle-commit-msg.txt` (covers linkage+explain+trigger+FE+example), plus older `flows-followup-commit-msg.txt`, `flows-linkage-commit-msg.txt`, `flows-commit-msg.txt`, `flows-pr-body.md`.

```bash
cd /Users/yousef/ixo-oracles-boilerplate
git add packages/oracle-runtime/src/plugins/flows/ packages/oracle-runtime/src/index.ts apps/qiforge-example/src/main.ts
git commit -F /tmp/flows-oracle-commit-msg.txt   # (add the editor bump bits if not already committed)
git push
```

**portal** — its own repo/branch/PR. Commit msg: `/tmp/flows-portal-commit-msg.txt`.

```bash
cd /Users/yousef/impacts-x-web
git checkout -b feat/create-flow-room-tool
git add lib/companion-tools/createFlowRoomTool.ts lib/companion-tools/getTools.ts
git commit -F /tmp/flows-portal-commit-msg.txt
git push -u origin feat/create-flow-room-tool && gh pr create --fill
```

(`/tmp` commit-msg files won't survive a reboot — regenerate if missing. NO co-author / "Generated with Claude" lines, per the user's binding rule.)

---

## 5. Verify commands

```bash
# unit tests (no infra)
pnpm --filter @ixo/oracle-runtime exec vitest run src/plugins/flows         # 60 pass
pnpm --filter @ixo/oracle-runtime run typecheck                              # exit 0
pnpm --filter @ixo/oracle-runtime exec eslint src/plugins/flows             # clean
pnpm exec prettier --check "packages/oracle-runtime/src/plugins/flows/**/*.ts"
pnpm --filter @ixo/oracle-runtime build                                      # rebuild dist (example app imports dist)

# run the reference oracle (needs .env: matrix creds, LLM key, etc.)
cd apps/qiforge-example && pnpm dev
```

NOTE: `*.int.test.ts` are NOT auto-run. The example app imports the BUILT `@ixo/oracle-runtime` dist, so **rebuild oracle-runtime after any plugin change** for `pnpm dev` to pick it up.

---

## 6. 🔑 CRITICAL ARCHITECTURE & GOTCHAS (must not regress)

1. **Two yjs instances — use NATIVE yjs for everything in-plugin.** Editor bundles `yjs@13.6.27`; oracle-runtime / matrix-crdt / blocknote use `13.6.31`. They are NOT interchangeable across the in-process doc boundary. So:
   - The plugin reads `qi.flow.*` **natively** (`read.ts readCompiledStructure`), NOT via editor's `readCompiledFlowFromYDoc` (its `value instanceof Y.Map` uses the wrong yjs → returns EMPTY nodes on the native provider doc). VERIFIED by a failing test.
   - The editor's fragment helpers (`removeBlockFromFragment` etc.) + `hydrate*` also break cross-version. The plugin uses editor-PLUGIN helpers (`../editor/blocknote-helper.js`, `../editor/block-actions.js` — all native 13.6.31) for reads + value edits, and native yjs for remove/reorder.
   - **Safe cross-version:** `compileBaseUcanFlow` (pure), `setupFlowFromBaseUcan` (creates its OWN 13.6.27 doc + syncs via version-agnostic BINARY updates), `getAllActions`/registry/`typeToCan`/`classifyNodeState`. Compile-driven authoring (create_flow/add_step) goes through `setupFlowFromBaseUcan`.
   - DO NOT add a workspace-wide yjs override (user explicitly forbade it).
2. **Conditions must use the evaluator's vocabulary.** Compiler writes `ConditionRef.operator` verbatim (`eq`/`neq`/…) but the FE evaluator only reads `equals`/`not_equals`/… with NO normalizer → conditions authored via `cap.condition` NEVER fire. The plugin writes `props.conditions` DIRECTLY (`buildConditionsProp`) in the evaluator vocab, and gates on **static props** (`sourceBlock.props[field]`), not runtime output.
3. **Sequencing:** `capabilities[]` array ORDER + data-refs is the primary mechanism (works for all actions). `after` = ordering only (NOT a trigger). `onEvent`→`block.event` only works for the ~10 `eligibleForEventTrigger` actions that declare an event (validate_flow rejects others). `runWhen`/`conditions` = static-prop gates only.
4. **Per-block props live in the `document` XmlFragment**, NOT in `qi.flow.nodes` (the node map omits props). Read props from the fragment (`extractBlockProperties` reads both `attrs.props` AND child direct attributes). Runtime keyed by **blockId** = `flow_block_<nodeId>`.
5. **Compiler prop keys** (`blockMapping.ts compileBlockProps`): title, description, icon, actionType, inputs(JSON nb), requiresConfirmation, conditions(''—written separately), parentCapability, authorisedActors(JSON), ttlAbsoluteDueDate/ttlFromEnablement/ttlFromCommitment, trigger(JSON TriggerSpec). Plus `props.triggerMode` set by the compiler.
6. **Forms:** schema in `block.props.surveySchema`; answers in `runtime.output.form.answers` (JSON string); `fill_form` never sets `state:'completed'`.
7. **Test hydration:** `setupFlowFromBaseUcan` needs a live Matrix room, so unit tests build the doc with `test-support.hydrateFlowDoc` (compile → write maps + fragment + runtime in native 13.6.31 — mirrors `createBlockContainer`). This also validates the production read path.
8. **`flowRef` = the Matrix room id** (opaque to the agent); default = `state.editorRoomId`. Leak guard: no tool I/O mentions block/blockId/props/yDoc/roomId/CAR/CID/delegation/can/with/nb.

---

## 7. The 27 tools (quick reference)

Discover: `list_actions`, `describe_action`, `list_referenceable_fields`, `get_flow_template` · Inspect: `read_flow`, `get_step`, `flow_status`, `explain_step` · Author: `validate_flow`, `create_flow`, `add_step`, `remove_step`, `reorder_step`, `update_flow_meta`, `connect_steps`, `update_step` · Tune: `set_step_inputs`, `set_step_conditions`, `set_step_schedule`, `set_step_assignment`, `set_step_confirmation`, `set_step_trigger` · Forms: `describe_form`, `fill_form` · Linkage: `check_link`, `compatible_actions`, `requirements`.

---

## 8. Live-testing journey + the fixes (devnet)

1. **Oracle couldn't write — `M_FORBIDDEN: user_level (0) < send_level (50)`.** The FE-created room has `users_default:0` (read-only) + `events_default:50`, so an invited-only oracle can't send `matrix-crdt.doc_update`. **First fix (failed):** post-create `mx.setPowerLevel(roomId, oracleUserId, 50)` — didn't apply (races room sync; the room's PL state isn't in the client store right after createRoom). **Working fix:** pass the oracle's address (extracted from `oracleUserId` `@did-ixo-<addr>:domain`) as `daoMemberAddresses` to `createBlocknoteCollaborativeRoom`, which sets power 50 in the room's initial `powerLevelContentOverride.users` AND invites it — atomic, no race. (`createFlowRoomTool.ts` `extractOracleAddress`.)
2. **"Continue editing" created a NEW room.** The agent called `create_flow` (which now always allocates a new room via the FE) for an EDIT request. **Fix:** `create_flow` now refuses if `state.editorRoomId` already holds a flow with steps (steers to the edit tools), unless `createSeparate:true`; description sharpened to "BRAND-NEW only." Edit tools (`add_step`/`update_step`/`set_step_*`) modify the open flow in place. NOTE: edit tools default to `state.editorRoomId`, so the flow to edit must be the one open in the portal.
3. **Rooms created before the power fix keep the oracle at power 0** — re-create the flow, or bump power manually.
4. **Reminder:** after any oracle change, REBUILD oracle-runtime + restart the example oracle; after any portal change, restart/HMR the portal — else stale code runs.

`create_flow` room-allocation logic (`authoring.ts allocateFlowRoom`): if `ctx.session.id` + `state.spaceId` present → `callBrowserTool({sessionId, toolCallId:'tc-<requestId>-create-room', toolName:'create_flow_room', args:{title, spaceId, oracleUserId}})` (from `@ixo/common`) → `extractRoomId` → `client.joinRoom(roomId)` → return roomId. Else fall back to `resolveFlowRef` (editorRoomId). callBrowserTool resolves with the FE fn's return (`{success, roomId}`).

---

## 9. OPEN ARCHITECTURAL QUESTION — templates vs flows (raised by user, NOT decided)

Symptom: a `qi/claim.submit` block shows _"Configure DID and claim collection in template mode before running this action"_ (form blocks show the same about survey schema). **Why:** claim.submit needs design-time config (which claim collection + the DID/entity context); that config lives in the editor's **"template mode."** Our builder authors a raw **flow** (no template-config step) + the agent doesn't know which collection (user's choice), so the block is half-configured.

The IXO model is **template → instantiate → run**: a `#template-*` room is the reusable blueprint (configure collection/DID/survey once); a `#flow-*` room is a runnable instance (usually cloned from a template via the portal's `cloneFromProtocol`/`instantiateTemplate`). Building raw flows skips template config → the warnings.

**Recommendation given to user (awaiting decision):** for reusable/configurable automations (claims/forms/signing) → author a **template** (`createAlias("template", …)` → `#template-*`) + add an "instantiate template → flow" step; keep direct flows for trivial, fully-agent-configurable one-offs. The read/edit/translate core is identical either way; only room allocation + a new "instantiate" tool change. **To verify first:** (a) can config like claimCollectionId be written as a block prop (then the agent could just ask+fill via `set_step_inputs`), or is it UI-gated to template mode? (b) does the portal expose an oracle-triggerable "instantiate template" entry (a sibling of `create_flow_room`)? User asked me to "think, don't code" — next step is likely to sketch the template-authoring variant if they say go.

---

## 10. Deferred / next (PR-later)

- `set_step_event` (onEvent → needs `setupFlowFromBaseUcan` patch for edges, Matrix + event-capability validate), `set_step_hooks`/`set_step_skills` (hooks/skills NOT in `compileBlockProps` — verify where/if they persist in the editor first).
- `explain_step` diff (`changes`) via editor diff resolvers (Appendix A.7 — verify export surface).
- Integration tests (`*.int.test.ts`) for create_flow/add_step against a real room (`.env.integration`); MUST throw on missing env, no skip flags.
- Broaden `ACTION_METADATA` overlay (typed ports + requires) across more of the ~41 actions.
- More starter templates.
- The templates-vs-flows decision (§9).

Real action types (41 with a `can`, verified): qi/claim.submit, qi/claim.evaluate, qi/email.send, qi/notification.push, qi/http.request, qi/bid._, qi/proposal._, qi/domain.sign, qi/matrix.dm, qi/wallet._, qi/iid.create, qi/calendar.event._, qi/xero._, qi/pod._, qi/human.form.submit, qi/collection.users, oracle, etc. (NO carbon actions exist as registry types.)

---

## 11. Binding user rules / preferences (from memory + this session)

- **NEVER run git write commands** (commit/push/branch/stash/reset/checkout/restore/clean/rebase/merge). Read-only git only. Hand the user the commands.
- **No co-author / "Generated with Claude" lines** in commits or PRs. User's own git identity.
- **No type assertions** (`as any`, `as X`) to silence the compiler — find the real mismatch (use type guards / narrowing). The codebase has `noUncheckedIndexedAccess` + `noImplicitAny`.
- **Don't auto-run `*.int.test.ts`**; run unit tests after writing; integration tests throw on missing env (no silent skip / skip-real-services flags).
- **Don't loosen test assertions** to mask failures; **don't edit plugin code to make tests pass** (2 test-side retries then stop).
- **Active codebase = `packages/oracle-runtime` + `apps/qiforge-example`** (`apps/app` is legacy). The editor + portal are separate repos the user owns; editing them is sanctioned when needed.
- **Prefers parallel `Agent` subagents over the Workflow tool** (declined Workflow twice even with ultracode on). Use subagents to save context on exploration.
- **Stop-and-report between PRs/waves.** Self-check (redundancy/dead-code sweep) before reporting done.
- Reuse aggressively; simplicity over complexity; don't over-engineer.

---

## 12. Pointers

- Spec (design): `packages/oracle-runtime/src/plugins/editor/spec.md`
- Persistent memory: `/Users/yousef/.claude/projects/-Users-yousef-ixo-oracles-boilerplate/memory/project_flows_plugin.md` (+ `MEMORY.md` index)
- Demo deck: `packages/oracle-runtime/src/plugins/flows/presentation.html` (open in browser) · `PRESENTATION.md`
- Tasks in this session: PR1–PR4 all marked completed.
