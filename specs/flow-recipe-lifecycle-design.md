# Flow recipe lifecycle — corrected creation script + runtime plan

**Companion to:** `specs/flows-plugin-lifecycle-audit.md` (the gap analysis).
**Status:** design proposal. Nothing here is implemented.

**Clarified definition (from the product owner):** a **flow recipe is an entity of type
`protocol/flow`** that provides the template for instantiating flows, or for forking into new
flows. A user can keep a fork as a modified template for flow runs in their own domain, or
publish it as a new `protocol/flow` — kept private, or published to the domain registry for
others to find and use.

This supersedes the "recipe = VFS artifact" framing in §3.B of the audit. The recipe's **identity
is a chain entity**; the VFS (or any content-addressed store) holds the *resource* the entity
points at. Identity on chain, bytes in a store, working copy in Matrix.

---

## 1. What the clarification changes

Three verified facts make `protocol/flow` the right primitive rather than a new invention:

1. **`qi/protocol.select` already exists** as a flow action — "records a user/agent selection of a
   protocol (by DID) and echoes the chosen DID, name, and type forward". Protocol entities are
   already first-class inside flows.
2. **`qi/domain.sign` already imports protocol templates into a domain** — its `flowTemplateConfig`
   input is "flow template config with selected protocol templates to import into the new domain",
   and the action creates the entity, signs a Domain Card VC, uploads it, and **attaches it as a
   linked resource**. The mint-and-publish pipeline for a protocol entity is already an action,
   already PIN-gated, already behind a human approval gate (`qi/domain.card-preview`).
3. **The portal already forks from a protocol** — `cloneFromProtocol → { newRoomId }` is a
   documented room-op (`plugins/editor/spec.md`), alongside `instantiateTemplate` and
   `clearRuntimeForTemplateClone` + `source_template_id` stamping.

So the four-state model is:

| State                | Artifact                                        | Lives in                                    |
| -------------------- | ----------------------------------------------- | ------------------------------------------- |
| **Recipe**           | `protocol/flow` entity + Domain Card + linked resource | Chain (IID) + indexer + resource store |
| **Template**         | working copy being authored / a domain's own    | `#template-*` Matrix room in a flows space  |
| **Flow**             | running instance                                | `#flow-*` Matrix room                       |
| **Fork**             | a template cloned from a recipe, provenance-stamped | `#template-*` + `source_template_id`    |

**Publish is the loop-closer:** a published recipe is a domain card the indexer already ingests,
which is exactly what the *next* user's search hits. Recipe → fork → modify → publish → recipe.

**One naming hazard, verified in our own code:** `flow-manager/plugins/flow-workflows/blueprint-lookup.ts`
declares `BLUEPRINT_ENTITY_TYPE = 'protocol/dao'`, while the domain-indexer tool description in
`plugins/domain-indexer/domain-indexer-tools.ts` documents the same concept as `dao/protocol`.
They cannot both be right, and blueprint-lookup filters *client-side* — so a wrong string returns
silently empty rather than erroring. **Confirm the exact on-chain string for `protocol/flow`
against live entity data before writing any filter**, and fix the existing inconsistency at the
same time.

---

## 2. The corrected creation script

Rewritten from the draft. Verified tool names; `⚠️` marks a move that has no implementation today.

### Phase 0 — Recall before anything else

- `memory-engine__search_memory_engine` `{ query: "onboarding a team member", knowledge_level: "user", strategy: "contextual" }`
  — has this user already built, forked, or discussed a flow like this? Do they have a recipe of
  their own?
- Same tool, `knowledge_level: "oracle"` — what has this oracle learned about onboarding flows:
  recipes it has built before, pitfalls, which blocks were needed.
- (Flow Manager only) `get_flow_learnings` with the candidate `actionTypes` — block-level lessons
  recorded from earlier builds.

> The draft's `memory-engine:user/search` and `memory-engine:oracle/search` are two calls to one
> tool. The capability exists and is wired; the flows guide simply never invokes it.

### Phase 1 — Find an existing recipe

- `domain_indexer_search` `{ q: "<purpose>", scopes: "domain_cards", filters: { "dc.entity_type": "protocol/flow" } }`
  — the public registry of published recipes. ⚠️ Today the only wrapper,
  `find_blueprints_for_purpose`, hard-codes `protocol/dao` and filters client-side; it needs a
  `protocol/flow` path.
- ⚠️ **Also search what the user already has** — their domain's flows space and their personal
  flows space. Registry search alone misses every unpublished template they own, which is most of
  them. The portal already resolves `domainFlowsSpaceId` / `personalFlowsSpaceId` and has
  `listWorkspacePagesTool`; no tool surfaces that to the builder.
- Project the candidates for selection **in the flow's entity-list block** — the mechanism
  `find_blueprints_for_purpose` already uses. ⚠️ The draft's `agui:list-selection` does not exist,
  and Flow Manager runs with `agui: false`.
- The user picks a recipe, or declines and starts fresh.

### Phase 2 — Fork or start fresh

- **Recipe selected → fork it.** ⚠️ `fork_recipe(protocolDid, target)` — a portal browser tool over
  the existing `cloneFromProtocol`, returning a new `#template-*` room stamped with the source
  protocol DID for provenance. The sibling tool `create_template_room` already exists and is the
  template to copy.
- **Nothing selected → `create_template`** (exists today).
- ⚠️ The draft's `skill "flow-creation"` does not exist in `ai-skills` and should not be created:
  this procedure is tool-driven sequencing, which belongs in the plugin's operating guide, not in a
  sandbox-loaded instruction capsule. (`design-pod-flow-builder` covers the *design method*, which
  is a different job.)

### Phase 3 — Compose the flow

- `list_actions` → `describe_action` → `requirements` on each candidate block. This is the
  in-process `@ixo/editor` registry; there is no `mcp:actions-registry/search` service, and
  building one is a separate project.
- `validate_flow`, then `add_step` / `update_step` / `connect_steps` / `set_step_*` /
  `set_form_schema` / `check_link` / `list_referenceable_fields`.
- Batch every unfillable `requires` into **one** question to the user. Never invent a collection
  id, DID, recipient, or endpoint.

### Phase 4 — Derive the capability document (do not sign it)

- ⚠️ `describe_required_capabilities(templateRef)` — every action carries a `can`
  (`translator.ts actionToCan`), so the flow's capability set is a **pure function of its steps**.
  Derive it, lint it (unknown `can`, over-broad wildcards, capabilities no step needs, steps whose
  `can` is missing from the parent, resource mismatches), and render it as the flow's permission
  summary.
- ⚠️ Hand it to the **portal to sign**. Signed delegations already land in the flow's Y.Doc, and
  `mint_invocation` already reads them back by CID — the storage and consumption halves exist; the
  authoring hand-off does not.
- The draft's `action:ucan/build` is the one step that crosses a standing boundary
  (`HANDOFF-template-reframe.md` §8: "Default to NOT authoring authorization in a template").
  **Deriving and linting is read-only and safe; signing stays with the human.** This needs an
  explicit re-decision, recorded, before it is built.
- On ordering: the draft puts the capability document *before* action discovery. That inversion
  only pays off against a remote, capability-indexed action registry. With a fixed local registry,
  derive-after-compose is strictly better.

### Phase 5 — Write the flow context page

- `update_page` (editor) — the narrative around the action blocks: intro, a lead-in before every
  block, outro.
- **Read the page first.** `update_page` replaces the whole page; any block not carried forward is
  destroyed, action blocks included. Flow Manager's prompt already defends against this by hand —
  ⚠️ it should be a tool-level guarantee, not a prompt instruction.

### Phase 6 — Review loop

- `read_flow` → present in plain language → apply the user's edits → repeat **until the user
  accepts**. ⚠️ Today the guide gates *before* building only; there is no post-build accept gate,
  and nothing records that acceptance happened.

### Phase 7 — Staff the flow with agents

- ⚠️ `find_capable_agents(can[])` — promote the existing `discoverCapableOracles`
  (flow-manager `plugins/oracle-delegation/oracle-discovery.ts`) to a tool. It already does
  indexer search on `dc.keywords=cap:<can>`, capability-declaration hydration, chain-verified
  provider→operator identity, and claim-schema constraint matching.
- Project candidates in the entity-list block; the user picks.
- **Assign with `set_step_assignment`** — it writes `props.assignment.assignedActor.did`, which is
  what the portal reads. The write path already exists.

### Phase 8 — Save to the right library

- Ask: **this domain's flows library, or your personal one?** Already supported —
  `create_template({ personalSpace })` routes to the FE's `domainFlowsSpaceId` vs
  `personalFlowsSpaceId`. The template room *is* the saved working artifact; there is no upload
  step for it.
- ⚠️ `export_recipe(templateRef) → recipe manifest` and store the manifest as the recipe's
  content-addressed resource (`vfs_write` returns the CID; verification is CID comparison, not a
  `vfs/verify` call). This is what makes a recipe forkable and publishable **outside** Matrix, and
  it is the artifact a `protocol/flow` entity links to.

### Phase 9 — Publish as a `protocol/flow` recipe

- Ask whether to publish. If yes, the existing on-chain path applies:
  `qi/domain.card-preview` (human approval gate) → `qi/domain.sign` (mints the entity, signs the
  Domain Card, uploads it, attaches the recipe resource as a linked resource). PIN-gated and
  user-signed — the agent prepares, the user executes.
- ⚠️ The draft's `skill "registry-publisher"` does not exist and is the wrong shape: publication
  mints a chain entity, which crosses the signing boundary. It is a portal/user action with an
  agent-prepared payload, not a skill capsule.
- **Private vs public needs a decision.** A chain entity is public by construction, so "private"
  cannot mean "unminted-but-published". Recommended split:
  - *Private recipe* — template room in the user's own domain flows space, no entity minted. Fully
    usable for their own runs and forks; invisible to everyone else.
  - *Published recipe* — `protocol/flow` entity + Domain Card; the indexer ingests it and the next
    user finds it at Phase 1.
  - *In between*, if genuinely needed — entity minted, but the linked recipe resource stays
    UCAN-gated in the VFS, so the card is discoverable while the spec is not.

### Phase 10 — Attach to a Topic (optional)

- ⚠️ `topic_index_search` → project candidates → user picks → `topic_patch` to attach the recipe →
  `topic_capsule_assemble` to revision the capsule. The topic-protocol MCP tools exist; **the
  flow-attachment operation is not defined in the protocol**, and there is no topics plugin in the
  runtime. Both are prerequisites.

### Phase 11 — Run, and hand off

- ⚠️ `start_flow_run(templateRef)` — a portal browser tool over `instantiateTemplate` /
  `cloneFromProtocol`, producing a `#flow-*` room. The agent never executes: it opens the run for
  the user. The draft's `flow:orchestrate/initialise` does not exist and must not become an
  agent-side execution path.
- **No `oracle:transfer`.** Flow Manager is the oracle that hosts this plugin, so handing off to
  it is a no-op. The hand-off is portal navigation. When a second builder oracle exists, contract
  Flow Manager through the existing `@ixo/flow-work` mechanism rather than inventing session
  transfer.

### Phase 12 — Remember

- `memory-engine__add_memory` — what was built, from which recipe, for what purpose, which choices
  the user made and rejected. This is what makes Phase 0 useful next time. Nothing writes it today.

---

## 3. Plan to execute this reliably at runtime

Twelve phases with gates, loops and optional branches **cannot be driven by prose**. Today they
would be: ~5 KB of `customInstructions` in Flow Manager plus the plugin's operating guide, with the
runtime hard-coding `loadedSet.has(FLOWS_PLUGIN_NAME)` at `main-agent.ts:382`. Reliability requires
three structural changes before any new tool is worth building.

### 3.1 Structural prerequisites

**(a) Lifecycle state, not transcript memory.** Add a `flowLifecycle` state field alongside
`loadedPlugins` (same monotonic, per-thread pattern), recording: current phase, the source recipe
DID if forked, the working `templateRef`, which gates have been passed (plan confirmed, draft
accepted, capabilities approved, save target chosen, publish decision), and the artifacts produced
(recipe CID, entity DID, topic id, run room id). The agent then answers "what have I done, what did
the user already accept, what is next" from state rather than by re-reading the conversation. This
also makes the lifecycle **resumable** across sessions and checkpointer reloads — which matters,
because publishing and running happen days after building.

**(b) A real operating-guide hook.** Replace the hard-coded branch with
`OraclePlugin.getOperatingGuide(rtCtx): string | undefined`, collected like the other registries,
and make the guide **phase-aware** — inject only the current phase's instructions plus the gates
around it. A 12-phase guide injected wholesale is both expensive and less reliable than the three
paragraphs that matter now.

**(c) Gates as tools, not as prose.** Every irreversible or user-owned step gets an explicit gate
tool that records the decision in `flowLifecycle`: plan confirmation, draft acceptance, capability
approval, save target, publish decision, run start. A gate that exists only as an instruction is a
gate the model can skip; a gate that is a tool call is auditable and testable.

### 3.2 New surfaces, by owner

| Owner            | Work                                                                                                                                  | Blocks phase |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **flows plugin** | `export_recipe` / `instantiate_recipe` (pure `FlowSpec` ⇄ manifest)                                                                    | 8, 9         |
| **flows plugin** | `describe_required_capabilities` + lint (pure function over step `can`s)                                                               | 4            |
| **flows plugin** | `search_recipes` (registry + the user's own spaces, merged)                                                                            | 1            |
| **flows plugin** | `find_capable_agents` (promote `discoverCapableOracles`)                                                                               | 7            |
| **flows plugin** | gate tools + `flowLifecycle` state                                                                                                     | all          |
| **runtime**      | `getOperatingGuide` hook; phase-aware injection                                                                                        | all          |
| **runtime**      | VFS plugin (per-request UCAN, mirroring `memory-ucan.ts` / `skills-ucan.ts`; short-TTL least-ability tokens — MCP tokens are reusable-until-expiry) | 8 |
| **runtime**      | Topics plugin over the topic-protocol MCP                                                                                              | 10           |
| **portal**       | `fork_recipe` browser tool over `cloneFromProtocol`                                                                                    | 2            |
| **portal**       | `start_flow_run` browser tool over `instantiateTemplate`                                                                               | 11           |
| **portal**       | capability-document signing hand-off                                                                                                   | 4            |
| **portal**       | non-destructive page update (or an `append_page_content` that cannot drop blocks)                                                      | 5            |
| **topic-protocol** | define the flow/recipe attachment operation for `topic_patch`                                                                        | 10           |
| **chain / registry** | confirm the exact `protocol/flow` entity-type string; fix the `protocol/dao` vs `dao/protocol` inconsistency                       | 1, 9         |
| **ai-skills**    | nothing. Neither `flow-creation` nor `registry-publisher` should be built as skills                                                    | —            |

### 3.3 Recipe manifest (the contract everything else depends on)

Define once, in the flows plugin, versioned:

```
recipe = {
  schemaVersion,
  id,                        // protocol/flow entity DID once published; local id before that
  name, purpose, tags,
  version, createdAt, author,        // DID
  provenance: { sourceRecipeDid?, sourceTemplateRoom? },   // set on fork
  spec: FlowSpec,                    // exists today — types.ts
  requiredCapabilities: [can…],      // derived, Phase 4
  requiredInputs: [...],             // derived from `requirements`
  suggestedAgents: [{ can, did }],   // from Phase 7
}
```

`spec` is already the room-free description of a flow, so `export_recipe` is mostly assembly, not
new modelling. Everything downstream — VFS storage, linked resource, fork, registry card — consumes
this one object.

### 3.4 Sequencing

- **Wave 1 — no new services.** Recall-first opening (Phase 0 + 12), `flowLifecycle` state, gate
  tools, the operating-guide hook, `describe_required_capabilities` + lint, `find_capable_agents`,
  post-build accept loop. Every one of these uses surfaces that already exist. This alone converts
  the build from "author a document" into a gated lifecycle.
- **Wave 2 — the recipe artifact.** Manifest, `export_recipe` / `instantiate_recipe`, VFS plugin,
  `search_recipes` across registry + own spaces, `fork_recipe` in the portal. Depends on the
  entity-type string being confirmed.
- **Wave 3 — publish and catalogue.** Domain card build → `qi/domain.card-preview` →
  `qi/domain.sign` with the recipe as linked resource; the private/published decision; topics
  attachment once the protocol operation is defined.
- **Wave 4 — run and hand off.** `start_flow_run`; hand-off as navigation, or a `@ixo/flow-work`
  contract when a second builder oracle exists.

Wave 1 is independently valuable and independently shippable. Waves 2–4 each have an external
dependency (chain entity type, protocol operation, portal tools) — start those conversations in
parallel with Wave 1 rather than after it.

### 3.5 What "reliably" has to mean in tests

- **Per-phase unit tests** on the pure parts: capability derivation + lint, manifest round-trip
  (`FlowSpec → recipe → FlowSpec`), provenance stamping on fork, recipe search merge/dedup.
- **Integration tests against real services** for each external hop (indexer search, VFS write +
  CID verification, topic patch) — throwing on missing env, no skip flags, per the repo's standing
  rule.
- **A lifecycle eval**: one scripted conversation that walks Phase 0 → 12 and asserts the *gate
  sequence* recorded in `flowLifecycle`, not the prose. That is the only test that catches the
  failure mode this design exists to prevent — the agent skipping recall, skipping the accept gate,
  or publishing without an explicit decision.
- **Irreversibility check**: assert that no agent-side tool can mint, sign, or run. Publishing and
  running must fail closed without a human action, and the existing leak guard (no room ids, CIDs,
  `can`/`with`, block ids in tool I/O) must still hold for every new tool.
