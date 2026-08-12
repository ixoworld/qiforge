# Flows plugin audit — from "flow document editor" to "flow lifecycle orchestrator"

**Status:** analysis only. No code changes proposed in this document are implemented.
**Scope:** `packages/oracle-runtime/src/plugins/flows/` and the surrounding ecosystem it would
have to compose with.

**Repos inspected (verified, not assumed):** `ixoworld/qiforge`,
`ixoworld/flow-manager-oracle`, `ixoworld/ai-skills`, `ixoworld/ixo-virtual-filesystem`,
`ixoworld/topic-protocol`, `ixoworld/domain-indexer`, `ixoworld/ixo-portal`.

---

## 1. What the plugin actually is today

`FlowsPlugin` contributes **25 request tools** and nothing else — no Nest modules, no config
schema, no state fields, no dependencies. It is not bundled; a fork opts in
(`plugins/index.ts` carries an explicit note). Verified surface:

| Group     | Tools                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Discovery | `list_actions`, `describe_action`, `list_referenceable_fields`                                                    |
| Linkage   | `check_link`, `compatible_actions`, `requirements`                                                                |
| Inspect   | `read_flow`, `get_step`, `flow_status`, `explain_step`                                                            |
| Author    | `validate_flow`, `create_template`, `add_step`, `remove_step`, `reorder_step`, `update_flow_meta`, `connect_steps`, `update_step` |
| Tune      | `set_step_inputs`, `set_step_conditions`, `set_step_schedule`, `set_step_assignment`, `set_step_confirmation`, `set_step_trigger` |
| Forms     | `set_form_schema`, `describe_form`, `fill_form`                                                                   |

Behaviour is governed by `FLOWS_OPERATING_GUIDE` (`plugins/flows/prompts.ts`), injected into the
system prompt when `flows` is in `loadedPlugins`. Its build loop is
**discover → plan → confirm → build → hand off**, where "discover" means *discover action blocks*.

Storage model: a template is a Matrix room (`#template-*`, `docType:'template'`) allocated by the
portal browser tool `create_template_room`, authored through `@ixo/editor`'s compiler, and read
back through the editor's `readFlowDocument` family. `templateRef`/`flowRef` is the room id and is
deliberately opaque to the model.

Two boundaries are load-bearing and were decided on purpose
(`plugins/editor/HANDOFF-template-reframe.md` §8):

1. **Never execute, sign, or mint.** The user runs the flow in the portal.
2. **Never author authorization.** "UCAN at author time = metadata strings only
   (`props.parentCapability`, `props.authorisedActors`) — and even those may be out of scope…
   Default to NOT authoring authorization in a template."

Both matter for the gap analysis below: item 5 of the target experience is currently forbidden by
design decision (2), and item 16 by design decision (1).

---

## 2. Gap analysis — expected step vs. what actually exists

Names in the "Actually available" column are verified in source.

| #   | Expected step                                   | Actually available                                                                                                                                                                                                              | Verdict                             |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | `memory-engine:user/search`                     | `memory-engine__search_memory_engine` with `knowledge_level: 'user'`                                                                                                                                                           | **Exists**, never invoked by flows  |
| 2   | `memory-engine:oracle/search`                   | Same tool, `knowledge_level: 'oracle'` (`plugins/memory/types.ts`: `'user' \| 'oracle' \| 'both'`)                                                                                                                             | **Exists**, never invoked by flows  |
| 3a  | `mcp:domain-registry/search` for flow recipes   | `domain_indexer_search` (scopes: `domain_cards`, `agents`, `compositions`, `events`); flow-manager's `find_blueprints_for_purpose` narrows client-side to `entity_type: 'protocol/dao'`                                         | **Partial** — no flow-recipe index  |
| 3b  | `agui:list-selection`                           | AG-UI plugin renders only FE-declared actions; `ixo-portal/lib/companion-tools/getTools.ts` declares none for selection; flow-manager sets `agui: false`                                                                        | **Missing**                         |
| 4   | skill `flow-creation`                           | Not in `ai-skills`. Nearest: `design-pod-flow-builder` (a spec-authoring instruction skill), `capsule-creator`                                                                                                                 | **Missing** (name does not exist)   |
| 5   | `action:ucan/build` parent capability + linting | Only `mint_invocation` (editor sub-agent; mints *invocations* from delegations the user already signed). Compiler writes `props.parentCapability`; authoring authorization is explicitly out of scope                          | **Missing by prior decision**       |
| 6   | `mcp:actions-registry/search`                   | `list_actions` / `describe_action` over the in-process `@ixo/editor` registry (~41 action types) plus the in-plugin `ACTION_METADATA` overlay                                                                                   | **Exists**, different shape         |
| 7   | `page:create/flow-context`                      | Editor `create_page` / `update_page`; flow-manager's prompt already mandates narrative around action blocks. `update_page` replaces the whole page — the prompt has to defend action blocks by hand                             | **Partial / fragile**               |
| 8   | Validate + loop with the user                   | `validate_flow` plus the guide's pre-build confirm gate                                                                                                                                                                       | **Exists**, no post-build accept loop |
| 9   | `mcp:domain-registry/capability-match`          | `discoverCapableOracles` / `discoverOraclesForService` in flow-manager: domain-indexer `/search` with `dc.keywords=cap:<can>`, declaration hydration, chain-verified operator identity, claim-schema constraints                | **Exists as code, not as a tool**   |
| 10  | `agui:list-selection/oracles`                   | Nothing. (`@ixo/flow-work/input` has `select` / `entity-select` templates, but only for *running* flows)                                                                                                                       | **Missing**                         |
| 11  | Personal vs domain files                        | `create_template({ personalSpace })` → FE picks `personalFlowsSpaceId` vs `domainFlowsSpaceId`                                                                                                                                 | **Exists** (as spaces, not files)   |
| 12  | `mcp:vfs/upload` + `mcp:vfs/verify`             | VFS is real and mature (16 MCP tools: `vfs_write`, `vfs_fetch`, `vfs_read`, `vfs_search`, `vfs_set_public`, …) but **not wired into qiforge at all** — no VFS plugin, zero references                                          | **Missing integration**             |
| 13  | `topic:search` / `topics:update/flows`          | topic-protocol MCP: `topic_index_search`, `topic_get`, `topic_patch`, `topic_capsule_assemble`, `topic_agent_run`. No qiforge integration; no flow-attachment operation defined                                                | **Missing integration**             |
| 14  | Publish recipe to the public registry           | Nothing. Domain-registry publication means creating an on-chain entity + domain card                                                                                                                                          | **Missing**                         |
| 15  | skill `registry-publisher`                      | Not in `ai-skills`. Nearest: `capsule-creator` (publishes *skill* capsules)                                                                                                                                                    | **Missing** (name does not exist)   |
| 16  | `flow:orchestrate/initialise`                   | Out of scope by boundary (1). The portal owns `instantiateTemplate` / `cloneFromProtocol`, but no browser tool exposes it. flow-manager's `start_flow_workflow` is a different thing (autonomous review/repair/research runs)   | **Missing by prior decision**       |
| 17  | `oracle:transfer` → Flow Manager                | `@ixo/flow-work`: flow-manager discovers a capable helper-oracle, mints a node-scoped UCAN delegation, sends `ixo.flow.work.invoke` over Matrix, helper posts a receipt. That is *work contracting*, not session transfer      | **Architectural mismatch**          |

**Net:** of 17 expected moves, 4 exist and are wired (6, 8, 11, and the build core), 4 exist
somewhere in the ecosystem but are not reachable from the flow-building conversation (1, 2, 9,
and the VFS/topics services), and 9 do not exist in any form.

---

## 3. The conceptual findings

### A. Wrong altitude — the plugin is a CAD tool; the request describes a lifecycle

The plugin's mental model is *author one document*. The target experience is a **lifecycle**:
recall → search recipes → select → instantiate → authorize → compose → review → staff → store →
catalogue → publish → run → hand off. Only three phases of that live in the plugin. The rest are
owned by other capabilities (memory, registry, VFS, topics, skills, UCAN, orchestration) and
**nothing in the current design composes them** — `FlowsPlugin` declares no `dependsOn` and no
`softDependsOn`, and its operating guide never names another plugin's tool.

The plugin should not absorb those capabilities. It should become the **spine** that sequences
them, keeping each in its own plugin.

### B. There is no "flow recipe" as a first-class artifact — this is the root blocker

> **Superseded in part.** A later clarification defines a flow recipe as an **entity of type
> `protocol/flow`** — chain identity, Domain Card, linked resource — not a VFS artifact. The
> "recipe is missing" finding stands; the proposed home was wrong. See
> `specs/flow-recipe-lifecycle-design.md` for the corrected model and the creation script.

Today a template *is* a Matrix room. It has no portable form, no stable identity outside Matrix,
no manifest, no version, no provenance. (Note: the in-plugin starter templates and
`get_flow_template` / `get_starter_template` tool referenced in the older handoff are **gone** —
there is no recipe library of any kind in the plugin now.)

Every expected step from #3 (find an existing recipe) through #15 (publish one) presupposes a
recipe *object*. Without it: nothing to search for in the registry, nothing to upload to the VFS,
nothing to attach to a Topic, nothing to publish.

**Recommendation — define the Flow Recipe.** The serialization already exists: `FlowSpec` /
`TemplateSpec` (`plugins/flows/types.ts`) is the agent-facing, room-free description of a flow.
Wrap it in a manifest and it becomes an artifact:

```
recipe = {
  id, name, purpose, version, provenance (author DID, source recipe id),
  spec: FlowSpec,                     // the steps — already exists
  requiredCapabilities: [can…],       // derived from the actions (see D)
  requiredInputs: [...],              // already computable from `requirements`
  suggestedAgents: [did…],            // from capability-match (see F)
  tags/categories                     // for registry indexing
}
```

Then the three words the ecosystem currently overloads get one meaning each:

| Term         | Meaning                                              | Where it lives                          |
| ------------ | ---------------------------------------------------- | --------------------------------------- |
| **Recipe**   | Portable, publishable, versioned artifact            | VFS file / registry entry / Topic capsule |
| **Template** | Working copy being authored or instantiated          | `#template-*` Matrix room               |
| **Flow**     | Running instance                                     | `#flow-*` Matrix room                   |

This matters beyond tidiness: today "blueprint" (flow-manager) means a `protocol/dao` domain card,
"template" means a Matrix room, and "protocol" means an on-chain entity. The expected script's
"flow recipe (protocol)" collapses all three. Pick the vocabulary before building anything.

Two new tools fall straight out and are cheap: `export_recipe(templateRef) → recipe` and
`instantiate_recipe(recipe) → templateRef` (the latter is `create_template` with the spec supplied
rather than composed in conversation).

### C. Discovery is actions-first; it must become recall-first

The guide's step 1 is `list_actions`. The expected script's first three moves are *recall* (user
memory), *recall* (oracle memory), *search* (existing recipes). That ordering is not cosmetic — it
is the difference between rebuilding an onboarding flow from scratch every time and reusing the
one the team already has.

The memory capability for this **already exists and is unused**: one tool,
`memory-engine__search_memory_engine`, with `knowledge_level: 'user' | 'oracle' | 'both'`. The
expected `memory-engine:user/search` and `memory-engine:oracle/search` are two calls to that one
tool. This is a prompt-ordering change plus a recipe index to search (B) — not new plumbing.

Note the second-order effect: today nothing writes flow-building outcomes into memory either.
flow-manager has a bespoke parallel memory (`get_flow_learnings` / `record_flow_learning`, keyed
by action type). That is a reasonable block-level lesson store but it is *not* "the user's flows",
and it will drift from memory-engine. Decide whether recipe-level recall lives in memory-engine
(recommended — it is the user's memory) or stays bespoke.

### D. The UCAN step was deliberately excluded, and that exclusion now blocks the design

The expected script puts a **parent capability document** at the centre: build it, lint it, derive
the actions from it. The current guardrail says the opposite. This needs an explicit re-decision,
not a quiet extension.

**Recommended middle path — the agent computes and lints; the human signs.** Every action in the
registry already carries a `can` (`translator.ts` `actionToCan` / `canToAction`), so the capability
set of a flow is a *pure function of its steps*. That means the builder can:

1. derive `requiredCapabilities` from the chosen steps — read-only, no keys, no signing;
2. lint it (unknown `can`, over-broad wildcards, capabilities with no step that needs them,
   steps whose `can` is absent from the parent, resource/`with` mismatches);
3. render it for the user as the flow's permission summary;
4. hand it to the **portal** to sign, which is where delegation signing already happens — signed
   delegations land in the flow's Y.Doc and `mint_invocation` reads them back by CID.

That delivers step 5 while keeping "the agent never holds a key" intact. The only genuinely new
surface is the portal signing hand-off; deriving and linting is a translator-level pure function
plus one tool (call it `describe_required_capabilities` / `lint_capabilities`).

Note the sequencing in the expected script — capability document *before* action search — reads as
"authority first, then find actions that fit". With a fixed local action registry that inversion
buys nothing today; it only pays off when the action registry is a remote, capability-indexed
service (see E). Recommend keeping actions-first for now and revisiting when #6 becomes remote.

### E. `actions-registry` as an MCP service is a real fork in the road

Today `list_actions` reads an **in-process registry compiled into `@ixo/editor`** (~41 action
types), plus a hand-maintained `ACTION_METADATA` overlay in the plugin (3,251 lines) that supplies
input ports and prerequisites for a handful of actions. Consequences: adding an action means
shipping a new editor version; the overlay is seeded for 4 actions and stale for the rest; and no
other oracle can contribute actions.

The expected `mcp:actions-registry/search` implies a service. That is a strategically sound
direction (it is what makes D's "capability first" ordering meaningful, and it is where the
metadata overlay should live), but it is a separate project with its own repo and migration. Flag
it as a dependency, do not smuggle it into the flows plugin.

### F. Agent capability-matching already exists in production code — it just is not a tool

`discoverCapableOracles` (flow-manager `plugins/oracle-delegation/oracle-discovery.ts`) does
precisely what step 9 asks: hybrid domain-indexer search filtered by `dc.keywords=cap:<can>`,
capability-declaration hydration from linked resources or the canonical domain card, chain-verified
provider→operator identity via Blocksync, and client-side claim-schema constraint matching. It is
invoked only internally when contracting `@ixo/flow-work`.

Exposing it as a builder tool — `find_capable_agents(can[])` → ranked candidates — is one of the
cheapest high-value moves available. And the write path already exists: adding an agent to a flow
means assigning a step's actor, which `set_step_assignment` does
(`props.assignment.assignedActor.did`).

### G. Human selection UI is missing everywhere, and three mechanisms compete

Steps 3, 10 and 13 all need "project candidates, let the user pick". Three mechanisms exist; flows
uses none:

1. **AG-UI actions** — declared by the front end per request. The portal declares no selection
   action, and flow-manager runs with `agui: false`.
2. **The editor's entity-list block** — how `find_blueprints_for_purpose` already projects
   blueprints into the open flow for the user to pick.
3. **`@ixo/flow-work/input` templates** (`select`, `entity-select`, `approval`, `text`) — durable
   structured input posted into the flow room, but scoped to *running* flows.

**Recommendation: standardise on (2)** for the building conversation. It needs no AG-UI, it works
in any client that renders the template page, it is already proven for blueprint selection, and it
keeps the "everything about this flow lives on its page" story. Reserve (3) for run-time input and
(1) for portal-only enrichment.

### H. Storage: rooms are not a library

Step 11-12 ("personal files or a domain's files", then upload + verify) is half-there: the
`personalSpace` flag on `create_template` already routes to `personalFlowsSpaceId` vs
`domainFlowsSpaceId`. But a Matrix space is not a library — it is not searchable by content, not
versioned as an artifact, not shareable by link, not publishable.

The VFS is exactly the missing half and is production-grade: per-user encrypted namespaces
(`user:<addr>` / `entity:<did>` — the personal/domain split already maps onto it), UCAN-scoped
delegation, IPFS CIDs over plaintext, version history, hybrid search, PROV-O provenance, and public
share links (`vfs_set_public`) — which is a credible *first* publication surface before on-chain
registry publication.

There is no `vfs/upload` or `vfs/verify`. The real names are `vfs_write` (returns the new `cid`)
and `vfs_fetch` / `vfs_read` / `vfs_list` for verification — so "upload then verify" is
`vfs_write` → compare returned CID, which is stronger than the expected script assumed.

Integration work: a VFS plugin in the runtime, minting a per-request UCAN exactly as the memory and
skills plugins already do (`memory-ucan.ts` / `skills-ucan.ts` are the templates). Note the caveat
in the VFS README: MCP session tokens are reusable-until-expiry rather than single-use, so mint
short-TTL, least-ability, narrowest-path tokens.

### I. Publication and the two registries are conflated

"Publish to the public domain registry" and "publish a skill capsule" are different pipelines.
`capsule-creator` + the skills registry publish *skills*; the domain registry indexes *chain
entities* with domain cards. A published recipe most plausibly becomes either (a) a public VFS
artifact referenced from a domain card, or (b) a `protocol/*` chain entity whose card carries the
recipe as a linked resource — which is precisely the shape `find_blueprints_for_purpose` already
searches, and `discoverCapableOracles` already parses (`linked_resource` hydration).

Option (b) closes the loop: publish → indexed as a blueprint → found by the next user's step 3.
That is the coherent design. It also means `registry-publisher` is not really a skill — it is a
capability that mints an entity, which crosses the signing boundary and therefore belongs to the
portal or to an explicit user-signed step.

### J. The final hand-off is inverted, and there is no transfer primitive

The expected script ends "hand off to the Flow Manager oracle". But **Flow Manager is the oracle
that hosts this plugin** (`flow-manager-oracle/apps/app/src/main.ts` wires `new FlowsPlugin()` with
`manifestOverrides: { flows: { visibility: 'always' } }`). Handing off to itself is a no-op.

Also verified: the runtime has **no session-transfer primitive**. `@ixo/flow-work` is not one — it
contracts a *helper oracle* to perform one node's work under a scoped delegation, with a receipt;
the user never talks to the helper.

Three options, in order of preference:

1. **Flow Manager is the orchestrator; the plugin is its toolbelt.** No transfer needed. The
   "hand-off" is a portal navigation ("open your flow and run it").
2. **Any oracle can build; running is contracted.** The end of the build mints a flow-work-style
   contract to Flow Manager. This is the natural extension of the existing mechanism.
3. **A real conversational transfer primitive** (`oracle:transfer`). New capability, new security
   model (whose UCAN, whose session, whose Matrix room), and out of proportion to the need.

Recommend (1) now, (2) when a second builder oracle exists. Do not build (3) on the strength of
this one script.

### K. The orchestration lives in prose, and the runtime hard-codes one plugin

Two structural problems that will bite as the lifecycle grows:

- `main-agent.ts:382` reads `loadedSet.has(FLOWS_PLUGIN_NAME) ? FLOWS_OPERATING_GUIDE : ''` —
  the *runtime* has a hard-coded branch for one plugin. Any second capability that needs an
  operating guide must edit the runtime. **Recommendation:** generalise to an `OraclePlugin` hook
  (`getOperatingGuide(rtCtx): string | undefined`), collected like the other registries.
- Flow Manager's `customInstructions` is ~5 KB of prose doing the sequencing, on top of the
  plugin's own guide. A 17-step lifecycle with gates, loops and optional branches **cannot be
  driven reliably by prose alone.** **Recommendation:** model the lifecycle as explicit phases with
  state — a `flowLifecycle` state field alongside `loadedPlugins` (monotonic, per thread) recording
  which phase the conversation is in and which gates have been passed — so the agent can answer
  "what have I already done, what is next, what did the user already accept" from state rather than
  from re-reading the transcript.

On skills: `flow-creation` and `registry-publisher` do not exist in `ai-skills`. Before creating
them, decide where a long procedure belongs. The repo currently has two answers — instruction
skills in `ai-skills` (e.g. `design-pod-flow-builder`, registry-versioned, loaded via the sandbox
path) and plugin operating guides (in-process, versioned with the runtime, no round trip). The
flows procedure is the second kind today, and the sequencing is tool-driven, so keeping it there is
the more coherent choice; a skill is the right vehicle for the *design* method (which
`design-pod-flow-builder` already covers), not for the tool-calling loop.

### L. Naming

The expected names use a namespaced `service:verb/object` convention; every real surface uses flat
snake_case (`search_memory_engine`, `vfs_write`, `list_actions`, `topic_index_search`,
`find_blueprints_for_purpose`) — LangChain/MCP convention, and what the models are trained on.
**Recommendation:** keep flat snake_case in code; treat the namespaced form as conceptual notation
in specs only. And fix the *vocabulary* collisions (B) — those are the ones that actually cost
engineering time.

---

## 4. Recommended sequencing

**Phase 0 — decisions (no code).** Recipe vs template vs flow vocabulary (B). Who orchestrates
(J.1). UCAN posture: does the builder derive+lint capabilities (D)? Selection UI mechanism (G.2).
Where recipe-level memory lives (C).

**Phase 1 — cheap wins inside the current boundaries.**

- Recall-first build loop: memory search (`knowledge_level: 'user'`, then `'oracle'`) before
  `list_actions`; write the outcome back with `add_memory`.
- `export_recipe` / `instantiate_recipe` — pure `FlowSpec` in/out, no new services.
- `describe_required_capabilities` + lint — pure function over the steps' `can` values.
- `find_capable_agents(can[])` — promote the existing `discoverCapableOracles` to a tool; pair it
  with `set_step_assignment` for "add this agent to the flow".
- Post-build accept loop: read back → present → edit → repeat until accepted (guide change).
- Generalise the operating-guide hook (K) so the guide stops being a runtime special case.

**Phase 2 — the recipe artifact.** VFS plugin (per-request UCAN, `vfs_write`/`vfs_fetch`), recipe
manifest, save to `user:<addr>` vs `entity:<did>` mirroring the existing personal/domain choice,
verify by returned CID.

**Phase 3 — catalogue and publish.** Topic attachment via `topic_patch` / `topic_capsule_assemble`
(define the flow-attachment operation with the topic-protocol owners first — it is not defined
today). Registry publication as a `protocol/*` entity + domain card with the recipe as a linked
resource, so published recipes become findable by the same `find_blueprints_for_purpose` path that
starts the next build (I).

**Phase 4 — run and hand off.** A portal browser tool for `instantiateTemplate` mirroring
`create_template_room`, so "start a run now" is one user-owned action; hand-off as portal
navigation (J.1) or a flow-work contract (J.2).

**Do not change:** the never-execute/sign/mint boundary; the leak guard (no room ids, CIDs, `can`,
`with`, block ids in tool I/O); surgical per-block edits; delegating document mechanics to the
editor API rather than re-implementing them.

---

## 5. Answers to the naming questions raised in the brief

| Expected name                     | Real name / status                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `memory-engine:user/search`       | `memory-engine__search_memory_engine` + `knowledge_level: 'user'`                        |
| `memory-engine:oracle/search`     | same tool + `knowledge_level: 'oracle'`                                                  |
| `mcp:domain-registry/search`      | `domain_indexer_search` (domain indexer); blueprint filter is client-side                |
| `mcp:domain-registry/capability-match` | `discoverCapableOracles` — internal function in flow-manager, not exposed as a tool  |
| `mcp:actions-registry/search`     | `list_actions` / `describe_action` — in-process `@ixo/editor` registry, no service       |
| `agui:list-selection`             | does not exist; nearest is the editor entity-list block used by `find_blueprints_for_purpose` |
| `agui:list-selection/oracles`     | does not exist                                                                           |
| `agui:list-selector/topics`       | does not exist                                                                           |
| `skill "flow-creation"`           | does not exist; nearest `design-pod-flow-builder`                                        |
| `skill "registry-publisher"`      | does not exist; nearest `capsule-creator` (skills registry, not domain registry)         |
| `action:ucan/build`               | does not exist; `mint_invocation` mints invocations, not delegations                     |
| `page:create/flow-context`        | `create_page` / `update_page` (editor plugin)                                            |
| `mcp:vfs/upload`                  | `vfs_write` (returns the new CID)                                                        |
| `mcp:vfs/verify`                  | `vfs_fetch` / `vfs_read` / `vfs_list`; CID comparison is the verification                |
| `topic:search`                    | `topic_index_search`                                                                     |
| `topics:update/flows`             | `topic_patch` (operation shape for flows is undefined) / `topic_capsule_assemble`        |
| `flow:orchestrate/initialise`     | does not exist; portal owns `instantiateTemplate` / `cloneFromProtocol`                  |
| `oracle:transfer`                 | does not exist; `@ixo/flow-work` contracts helper-oracle work, which is a different thing |
