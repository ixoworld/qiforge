# The Sovereign Agency Harness — Research and Architecture

**Status:** Research spec — patterns established, architecture proposed, implementation phased
**Revision:** v1.2 — 2026-08-03 (v1: research + architecture; v1.1 adds Part V — `domain.md` alignment assessment and the concrete Phase-1 wiring plan; v1.2 adds Part VI — the Phase 1 gap review, written at completion)
**Branch:** `claude/sovereign-agency-harness-09u8j6`
**Builds on:** `specs/ORA-219-plugin-based-runtime.md` (the plugin runtime this design extends)
**Stack context:** `@ixo/oracle-runtime` · IXO Impact Hub (IID / Entity / Claims modules) · Matrix · UCAN · LangGraph

---

## What this document is

A systematic study of how the industry's agent harnesses actually work — LangChain Deep Agents, qm, Claude Code / the Claude Agent SDK, the OpenAI Agents SDK, LangGraph, Letta (MemGPT), OpenHands, smolagents, MCP — followed by a first-principles derivation of the **Sovereign Agency Harness**: an architectural inversion in which the harness stops being extrinsic middleware owned by an app developer and becomes a **constitutive part of the entity itself**, with AI models reduced to pluggable, temporary reasoning tools the entity hires, uses, and discards.

Part I reports what the established harnesses teach. Part II derives the principles. Part III specifies the sovereign architecture. Part IV maps it onto QiForge and phases the work. Part VI, added at Phase 1 completion, audits what was built against the promise — property by property, honestly.

### Table of contents

- **Part I — The research**
  - [1. Method](#1-method)
  - [2. Deep Agents: depth is a property of the harness](#2-deep-agents-depth-is-a-property-of-the-harness)
  - [3. qm: the durable core and the transient hire](#3-qm-the-durable-core-and-the-transient-hire)
  - [4. The wider ecosystem](#4-the-wider-ecosystem)
  - [5. The common anatomy of a harness](#5-the-common-anatomy-of-a-harness)
  - [6. The ownership audit](#6-the-ownership-audit)
- **Part II — First principles**
  - [7. What a harness is](#7-what-a-harness-is)
  - [8. The five separations](#8-the-five-separations)
  - [9. Behavioral vs structural constraint](#9-behavioral-vs-structural-constraint)
  - [10. The relocation theorem](#10-the-relocation-theorem)
- **Part III — The Sovereign Agency Harness**
  - [11. Architecture overview](#11-architecture-overview)
  - [12. Identity Core](#12-identity-core)
  - [13. Sovereign Memory](#13-sovereign-memory)
  - [14. Constitution Engine](#14-constitution-engine)
  - [15. Capability Kernel](#15-capability-kernel)
  - [16. Cognition Sockets](#16-cognition-sockets)
  - [17. Evidence & Evaluation Pipeline](#17-evidence--evaluation-pipeline)
  - [18. Economic Membrane](#18-economic-membrane)
  - [19. The sovereign loop, end to end](#19-the-sovereign-loop-end-to-end)
  - [20. Design invariants](#20-design-invariants)
- **Part IV — Application to QiForge**
  - [21. What already exists](#21-what-already-exists)
  - [22. Gap analysis](#22-gap-analysis)
  - [23. Phased roadmap](#23-phased-roadmap)
  - [24. Open questions](#24-open-questions)
- **Part V — domain.md: the constitution artifact, assessed and wired**
  - [25. What domain.md provides](#25-what-domainmd-provides)
  - [26. Alignment assessment](#26-alignment-assessment)
  - [27. Gaps, in both directions](#27-gaps-in-both-directions)
  - [28. Phase-1 wiring plan](#28-phase-1-wiring-plan)
  - [29. Sequencing with later phases and upstream proposals](#29-sequencing-with-later-phases-and-upstream-proposals)
- **Part VI — Phase 1 gap review: the promise, audited**
  - [30. The gap review](#30-the-gap-review) — custody inventory (30a), the four properties scored (30b), the pipeline audited (30c), untracked gaps now tracked (30d), where Phase 1 exceeded the letter (30e), reading (30f)
- [31. References](#31-references)

---

# Part I — The research

## 1. Method

Two named starting points — [Deep Agents](https://www.langchain.com/deep-agents) and [yc-software/qm](https://github.com/yc-software/qm) — were studied from primary sources: product pages, design blog posts, documentation, and source code (the full qm repository was cloned and read; Deep Agents' `graph.py`, middleware, and backend sources were read from the repo). The survey was then widened to the systems that define current harness practice: Claude Code and the Claude Agent SDK (plus Anthropic's engineering essays on context engineering, effective agents, and their multi-agent research system), the OpenAI Agents SDK, the LangGraph runtime, Letta/MemGPT (docs, blogs, and the MemGPT paper), OpenHands (docs and paper 2407.16741), Hugging Face smolagents, and the MCP 2025-06-18 specification.

In parallel, the sovereign-infrastructure primitives were studied the same way: the UCAN v1 spec and this repo's actual UCAN code, the object-capability literature, W3C DIDs/VCs, the IXO Impact Hub modules (`x/iid`, `x/entity`, `x/claims`), ERC-8004, x402, Google AP2, the agent-economy precedents (Olas, Fetch.ai, Virtuals), policy-as-code engines (OPA/Rego, Cedar), and tamper-evident log constructions (RFC 6962 transparency logs, Trillian/Rekor, C2PA).

Three questions were held against every system:

1. **What is the anatomy?** What components recur, and what problem does each solve?
2. **Who owns what?** Where do identity, memory, keys, and authority actually live?
3. **How swappable is the model?** Is the reasoning engine already treated as transient?

## 2. Deep Agents: depth is a property of the harness

LangChain's Deep Agents package is the distillation of an observation about Claude Code, Deep Research, and Manus: agents that succeed at long-horizon work run **the same tool-calling loop as everyone else**. What separates "deep" from "shallow" is not the loop and not the model — it is the harness around them. Deep Agents names four pillars:

1. **A detailed system prompt.** Long, few-shot, dense with tool-use policy. "Prompting matters still" — the prompt is treated as load-bearing infrastructure and composed explicitly (user instructions + harness defaults + per-provider profile text).
2. **A planning tool that does nothing.** `write_todos` is a no-op: it writes a todo list into state and has no other effect. Its entire function is attentional — the act of writing and re-reading the plan keeps the model on track across a long trajectory. A tool call can exist purely to shape the model's context.
3. **Sub-agents as context quarantine.** A child agent starts with _only_ a task description (no parent conversation), burns its own context window on the detail work, and returns a single distilled message. Parent state is copied _except_ messages and todos — the filesystem carries over as shared workspace; conversational context does not. The coordinator stays at orchestration altitude.
4. **A filesystem as universal memory.** One fixed seven-tool surface (`ls`, `read_file`, `write_file`, `edit_file`, `delete`, `glob`, `grep`) over pluggable **backends**: thread-scoped state, real disk, cross-thread stores, sandboxes — and a `CompositeBackend` that routes by path prefix (e.g. everything under `/memories/` goes to a durable store while the rest stays ephemeral). Scratch notes, long-term memory, offloaded tool results, archived conversation history, and skills all live behind the same interface.

The engineering around those pillars is a composable **middleware stack** (planning, filesystem, sub-agents, summarization at 85% of the model's window, tool-call repair, human-in-the-loop interrupts, prompt caching), each hook able to rewrite the model request, inject instructions, and contribute state fields. Models are provider-prefixed strings, swappable per sub-agent, with the harness adapting to the model (summarization thresholds derived from the model's context size; provider profiles adding caching or excluding tools) rather than the reverse.

**Ownership finding.** Everything durable is supplied by the app developer: the checkpointer, the store, the thread IDs, the namespace scoping, the API keys, the permission rules. The model owns nothing; the _harness_ owns nothing either — it orchestrates resources the application provides. Deep Agents is the cleanest specimen of the extrinsic pattern: "the agent" is harness + app configuration, and the LLM is a rented component inside it.

## 3. qm: the durable core and the transient hire

qm (built inside Y Combinator, open-sourced at `yc-software/qm`) is the most important precedent found, because it has already executed one half of the sovereign inversion — in production, for organizations. Its headline property: _"Pick your own harness and model and switch between them — Pi, OpenCode, Codex, and Claude Code all drive the same core, so a deployment isn't tied to any single vendor."_

qm's **headless core** owns every durable noun: identity and principals, the session transcript, memory, the credential keychain, command policy and security postures, the scheduler (crons/watches), the run queue, per-scope sandboxes and files, skills, audit. **Entire agent harnesses** — not just models — are reduced to adapters behind one interface:

```ts
// qm src/harness/harness.ts (abridged)
interface Harness {
  profile: HarnessAdapterProfile; // transports + capability set (abort, steer, images, ...)
  turns: { runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> };
  models: HarnessModelUtilities; // aux duties core MAY delegate: judge, compact, screen...
  tools: HarnessToolPresentation; // core tool names, per-harness presentation
}
```

`runTurn` receives everything from the core — the composed system prompt, the neutral history, the core-owned tool surface, and callbacks (`emit` to persist every event, audit hooks for every model call, security screening hooks, an approval gate). The harness supplies intelligence for one turn and keeps nothing.

Five mechanisms make the swap real, and all five matter for the sovereign design:

1. **The neutral log is the only truth; native transcripts are caches.** Every session is stored twice: a harness-independent `SessionEntry[]` event log (canonical), and a per-harness "tape" of native messages tagged with the harness id. On a harness switch, the tape is skipped (`foreign-harness`), `resetSession` is invoked on both adapters, and the new harness deterministically rebuilds its native context from the neutral log. Switching Pi ↔ Claude Code mid-session costs one cache rebuild and nothing else.
2. **The core composes the prompt; the hire receives it.** Personality ("souls"), memory, security posture, environment facts — all core-assembled, identical across harnesses. A harness never has standing instructions of its own.
3. **One tool surface, many presentations — and policy lives inside the tools.** Tool definitions and execution are core code; adapters merely re-transport them (in-process, MCP, JSON-RPC, plugin). qm deliberately **disables Claude Code's own permission machinery** (`bypassPermissions`) because command policy, approvals, ACLs, and audit are enforced inside the core-owned tool implementations — one locus of authority instead of stacked vendor gates. Its security doctrine is explicit: _"The agent and software it runs in a sandbox are not trusted to make authorization decisions."_
4. **Credentials are granted, materialized per turn, and audited — never held by the hire.** The keychain encrypts credentials at rest; owners grant them to scopes (`once`/`standing`, with purpose and revocation); the orchestrator materializes exactly the granted set into the sandbox environment per turn and logs every materialization.
5. **Scoped sovereignty with a floor that only tightens.** Every person and room is a scope with its own memory notebook, durable sandbox, keychain view, policy, crons, and apps. Org-level security posture and command policy compose _floor-first_: narrower scopes can raise strictness, never lower it. Background agency is honest about persistence: each cron fire is a fresh thread told exactly what persists ("your workspace disk and the stored task below"), with authorization re-checked per fire.

**Ownership finding.** qm proves the durable-entity/transient-hire split is buildable and operable today. But its durable core belongs to the _organization's deployment_ — identity is org identity, keys are org keys, Postgres is the operator's database. It inverts vendor lock-in, not custody. The sovereign harness must take qm's mechanics and relocate their ownership one more level — from the operator to the entity itself.

## 4. The wider ecosystem

Condensed findings per system (the load-bearing points only):

| System                      | Loop                                                                        | Memory/state                                                                                                                                                          | Authority                                                                                                                                                        | Model swappability                                      | Key ideas taken                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code / Agent SDK** | gather context → act → **verify** → repeat; evaluator-gated stop conditions | CLAUDE.md hierarchy (advisory) + agent-written auto memory + just-in-time agentic search; steerable compaction                                                        | Two-tier by doctrine: prompts advise, **hooks and managed settings enforce** ("regardless of what Claude decides"); optional classifier model as permission gate | Single-vendor by design; per-subagent model pinning     | "Give the agent a computer"; evidence over assertion; advisory/enforced split                                                                                |
| **OpenAI Agents SDK**       | runner loop: final output / handoff / tool call                             | Sessions (developer DB) **or platform-held** conversation state                                                                                                       | Guardrails as typed tripwires; tool-approval config                                                                                                              | Broad via LiteLLM, with documented capability asymmetry | Handoffs (control transfer); platform gravity pulls state to the vendor                                                                                      |
| **LangGraph**               | graph runtime, not a fixed loop; durable execution                          | Checkpointer (thread-scoped) vs Store (cross-thread) — a crisp split; time travel                                                                                     | Structural only — developer-authored nodes and interrupts                                                                                                        | Fully agnostic                                          | Durability as a dial (exit/async/sync); determinism contract; replay                                                                                         |
| **Letta / MemGPT**          | server-resident loop; heartbeats; interrupts                                | **The agent is the persistent entity**: memory blocks (in-context, self-edited via tools), recall, archival; sleep-time agent reorganizes memory off the request path | Capability-shaped: which tools and which writable blocks an agent has                                                                                            | Model-agnostic; different models per role               | "RAG is a tool for agent memory, not memory"; agent as unit of identity; `.af` file serializes an agent                                                      |
| **OpenHands**               | event stream; agent = `step(state) → action`                                | The append-only event stream is state, memory, trace, and audit in one                                                                                                | Boundary-based: per-session sandbox with an action-execution server                                                                                              | Pluggable                                               | Everything-is-an-event; action server behind a REST boundary                                                                                                 |
| **smolagents**              | the ReAct loop, small enough to print                                       | Memory = the step log, re-rendered per call                                                                                                                           | Interpreter restriction (whitelisted imports) or schema validation                                                                                               | Broadest surveyed                                       | Code-as-action; agency as a spectrum; radical legibility                                                                                                     |
| **MCP**                     | protocol, not loop: host ↔ clients ↔ servers                                | Conversation stays with the host                                                                                                                                      | **Consent named as the user's**; servers cannot see the conversation, each other, or the keys; sampling routes model access through the host                     | Agnostic by construction                                | Trust boundaries drawn in architecture; capability negotiation; authority inversion via sampling — but "MCP itself cannot enforce these security principles" |

## 5. The common anatomy of a harness

Across all systems the same organs recur. This is the invariant anatomy the sovereign harness must also possess — the inversion changes _ownership_, not physiology.

| #   | Organ                                        | Problem it solves                                                                           | Observed variations                                                                                                                                                              |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Context assembler**                        | The model is stateless; something must decide, every call, which tokens represent the world | Layered instruction files (Claude Code); pinned structured blocks (Letta); log re-rendering (smolagents, OpenHands); developer projection (LangGraph); core-composed prompt (qm) |
| 2   | **Execution loop**                           | One completion is not an agent                                                              | while-loop; graph executor; event loop; server-resident loop with heartbeats; per-turn `runTurn` function (qm)                                                                   |
| 3   | **Tool mediator (agent-computer interface)** | Intent must become effect, correctly described                                              | JSON schemas; code-as-action; MCP; one core surface with per-harness presentations (qm); "the tool description is the real API"                                                  |
| 4   | **Durable state store**                      | Progress must outlive the process                                                           | Step-granular checkpoints (LangGraph); server DB where the agent is the object (Letta); event log (OpenHands); neutral log + native cache (qm)                                   |
| 5   | **Permission gate**                          | An autonomous actor wields someone's authority                                              | Per-action approval; allowlists; classifier gate; deterministic hooks; typed guardrails; policy-inside-tools (qm); container boundaries                                          |
| 6   | **Context reduction / recovery**             | Long-horizon work outgrows the window; "context rot" degrades before limits hit             | Threshold summarization; self-directed paging (MemGPT); sleep-time reorganization (Letta); offload-to-files (Deep Agents)                                                        |
| 7   | **Sub-agent spawner**                        | Breadth and depth can't share one window                                                    | Call-and-return with compressed summaries; handoffs; sub-agents-as-tools; delegation as recorded event                                                                           |
| 8   | **Long-term memory**                         | Learning must survive the session                                                           | Human-authored instruction memory; agent-authored notes; tiered self-edited hierarchies; cross-thread stores                                                                     |
| 9   | **Verification loop**                        | "Looks done" is not done                                                                    | Runnable checks; stop hooks; answer validators; fresh-context adversarial review                                                                                                 |
| 10  | **Observability / audit**                    | Nondeterministic loops fail nonreproducibly                                                 | Tracing; the event stream as the trace; cost accounting; mandatory model-call reporting (qm)                                                                                     |
| 11  | **Model abstraction**                        | The engine is replaceable but engines differ                                                | Provider strings; LiteLLM; role-scoped models; whole-harness adapters (qm); capability profiles                                                                                  |
| 12  | **Execution environment**                    | Effects need somewhere real yet contained                                                   | User machine + permissions; per-session containers; action servers; per-scope durable sandboxes (qm)                                                                             |

Two cross-cutting regularities:

- **The model is already transient everywhere.** Provider-prefixed strings, per-subagent overrides, per-turn model choice, LiteLLM adapters, whole-harness routing (qm). The industry has conceded model transience. Entity persistence is the unclaimed half.
- **Enforcement that works is always structural.** Every system that takes safety seriously ends at the same place: prompts advise, but the deterministic layer decides (Claude Code hooks and managed settings; qm policy-inside-tools; smolagents interpreter restriction; OpenHands container boundary; MCP host-mediated isolation).

## 6. The ownership audit

For every system: who owns the keys, the identity, the memory?

| System                  | Model keys                             | Agent identity                                                | Memory/state                            | Effective owner                                    |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| Claude Code             | User's account (org can override)      | None — the operator's account is the principal                | User's disk, machine-local              | End user (because operator = user); org above them |
| Claude Agent SDK        | Developer                              | None                                                          | Developer's choice                      | Developer                                          |
| OpenAI Agents SDK       | Developer                              | None                                                          | Developer DB or OpenAI-hosted           | Developer, with platform gravity                   |
| Deep Agents / LangGraph | Developer                              | `thread_id` — an app-defined string                           | Developer-operated checkpointer + store | Developer, entirely                                |
| Letta                   | Server operator                        | **The agent** — persistent, addressable, serializable (`.af`) | Server DB, self-edited content          | Operator — but the agent is the unit of identity   |
| OpenHands               | Operator                               | None                                                          | Deployment-held event stream            | Operator                                           |
| smolagents              | Developer (literal `api_key=` in code) | None                                                          | In-process, gone at exit                | Developer, maximally                               |
| qm                      | Org deployment                         | Org principals; scopes                                        | Operator's Postgres; per-scope          | Organization/operator                              |
| MCP                     | Host application                       | None (the _user_ is the named consent authority)              | Host                                    | Host developer in practice; user in normative text |

**Verdict.** The extrinsic-middleware claim substantially holds: every surveyed harness is instantiated by developer code, runs on operator infrastructure, authenticates with operator credentials, and stores memory in operator-controlled stores. The entities agents act for appear only as row keys, message content, click-through consent, or normative language without protocol teeth. Nothing in any schema names the asset or principal as an _authority-bearing party_; no system represents delegated authority as an inspectable, scoped, revocable artifact that survives the session.

Two genuine cracks point at the answer:

- **Letta** shows the agent can be the durable, serializable unit of identity and the author of its own memory.
- **MCP** shows trust boundaries and consent can be drawn architecturally between the principal and the integrations.

No surveyed system combines them. **An agent that is a durable entity _and_ carries verifiable, principal-granted, scoped authority of its own does not yet exist in the mainstream ecosystem.** That is precisely the sovereign agency harness.

---

# Part II — First principles

## 7. What a harness is

Strip any agent system to its studs and two parts remain:

- **The model** — a stateless function: `f(context) → tokens`. It holds nothing between calls: no memory, no identity, no authority, no bank account. Everything it appears to "know" or "be able to do" during a turn was injected into its context or wired around its output by something else. This is not a design choice; it is the physics of stateless inference.
- **The harness** — everything else. The loop that calls the model; the assembler that decides what enters the window; the store that survives the call; the mediator that turns emitted intentions into effects; the credentials that make effects land; the policy that bounds them; the recovery that survives failure.

**Corollary: an agent's continuity, authority, and accountability live entirely in the harness.** The model contributes reasoning per call and nothing else. Ask "who is the agent?" and the answer is never the model — it is whoever owns the harness. Today that is an app developer or a platform. The sovereign inversion is a change of owner, not a change of physics:

> **Asset identity ≠ model version.** The harness is the enduring subject; the model is a component of its currently-active cognition, replaced without ceremony — the way a company hires a new management team without changing what the company is.

## 8. The five separations

The sovereign harness is defined by five separations. Each collapses in today's extrinsic harnesses; each has at least one proven precedent for the sovereign form.

| #   | Separation                             | Extrinsic collapse                                                                                                    | Sovereign form                                                                                                                                              | Proven precedent                                                                                                                                       |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Identity ≠ model**                   | "The agent" is a deployment behind an operator's API key; retire the deployment and the agent is gone                 | The entity's DID persists across every model, harness, operator, and hosting change                                                                         | DIDs persist across key _and controller_ rotation; qm sessions survive whole-harness swaps; Letta agents outlive model choices                         |
| 2   | **Memory ≠ context window**            | History lives in a vendor DB keyed by the operator's account; context is assembled by code the entity doesn't control | Episodic memory is entity-custodied, tamper-evident, ledger-anchored; each model gets a scoped, revocable _view_                                            | qm's neutral log vs native tape; Letta's self-edited blocks; the Matrix checkpointer already in this repo                                              |
| 3   | **Authority ≠ ability to emit tokens** | The model's tool call inherits the harness's ambient credentials — the god-key problem                                | Authority exists only as explicit, attenuated, time-boxed capability tokens minted per task; the model holds no keys, ever                                  | UCAN attenuation-only chains; qm's per-turn keychain materialization; MCP sampling                                                                     |
| 4   | **Claim ≠ fact**                       | Model output is treated as decision; the model is its own evaluator, so errors cascade unchecked                      | Model output is a _claim_; evidence verification and constitutional evaluation stand between claim and effect; generation and evaluation are separate roles | IXO claims module (submit → evaluate → dispute → adjudicate); Claude Code's fresh-context adversarial review; qm screening before the model sees input |
| 5   | **Value ≠ operator billing**           | The operator pays the API bill; economics are invisible to "the agent"                                                | The entity meters its own cognition spend from its own treasury and is paid via escrowed settlement on independently verified outcomes                      | IXO entity accounts + claims escrow; x402 per-call payments with no standing credentials; AP2 mandate envelopes                                        |

## 9. Behavioral vs structural constraint

A recurring finding, stated once and used everywhere: **there are two ways to constrain an agent, and only one of them is load-bearing.**

- **Behavioral constraint** shapes what the model _proposes_: system prompts, Constitutional AI, RLHF/RLAIF, fine-tuning. Valuable — it improves the proposal distribution and generalizes to unforeseen cases — but statistical. A trained disposition is a probability, not an invariant; jailbreaks and injection attacks operate entirely within this layer. It is also the _wrong locus_ for an entity's commitments: a trained constitution is a property of the model checkpoint — global to every deployment, invisible, non-amendable by the entity, and it leaves when the model is swapped. You cannot cite a weight matrix in a dispute.
- **Structural constraint** bounds what any proposal can _do_: policy engines evaluated before execution, capability tokens that are the only path to effect, sandbox boundaries, deterministic hooks. Cedar's semantics are the canonical shape: **default deny; `forbid` overrides `permit`; errors fail closed** — and its use as the authorization gate for agent tool calls is already a shipping pattern (Amazon Bedrock AgentCore). qm states the doctrine plainly: the agent and its sandbox "are not trusted to make authorization decisions."

The object-capability tradition supplies the theory for the structural layer:

- **No ambient authority.** Nothing is actionable merely by being reachable; the model's context contains no keys, no admin sessions — only the harness holds references, and every effect requires presenting a specific capability the harness chose to mint. This is the structural answer to prompt injection: an attacker with full control of the model's output still only ever gets what the harness signs.
- **Least authority (POLA).** Grant per task, not per role: one proposal → one narrow, expiring token.
- **Attenuation.** From any capability, only weaker ones can be derived — enforced by the authorization algebra itself (UCAN chains are attenuation-only), independent of any bug in the model.
- **Revocable membranes.** Wrap all handles minted for an episode behind one membrane; end the episode (or trip an alarm) and everything dies at once.
- **The powerbox.** Rights only combine at one explicit, auditable join point. The harness _is_ the powerbox — the single place where root authority, the constitution, and a model's proposal meet, and a narrow token comes out.

Defense in depth uses both layers — an aligned model proposes better; a structural gate bounds worse — but they fail differently, and **the structural layer is the root of trust**.

## 10. The relocation theorem

The central synthesis of the research: **the extrinsic patterns are not discarded — they are relocated.** Every organ from §5 is correct mechanics of agency. The sovereign move is to change what each organ is _anchored to_: from the operator's app to the entity's own identity, storage, policy, and treasury.

| Extrinsic organ (owner: developer/operator) | Sovereign relocation (owner: the entity)                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Context assembler in app code               | Harness kernel composes the **context capsule** from the entity's memory, under the entity's disclosure policy                               |
| Execution loop in the app process           | The entity's resident kernel loop; cognition attaches per task                                                                               |
| Tool mediator with vendor permission UIs    | One entity-owned tool surface; policy enforced _inside_ the tools (qm), gated by the Constitution Engine                                     |
| Checkpointer/store in operator DB           | Working state + episodic ledger in the entity's own encrypted rooms, hash-chained and ledger-anchored                                        |
| Permission gate as session UI clicks        | Machine-readable constitution + capability tokens: inspectable, scoped, revocable artifacts that survive the session                         |
| Compaction/summarization defaults           | Entity-owned memory strategy; "sleep-time" reorganization as entity self-maintenance                                                         |
| Sub-agent spawner                           | Same mechanics; every child is bound by the same constitution and receives attenuated capabilities (tighten-only, like qm scope composition) |
| Long-term memory in vendor store            | Entity-custodied memory the _entity's_ processes edit; models receive scoped views, wiped after use                                          |
| Verification loop as developer tests        | Evidence requirements + independent evaluation as first-class protocol objects (claims module)                                               |
| Observability traces to vendor              | The episodic ledger _is_ the trace; every model call recorded to the entity's own audit log                                                  |
| Model abstraction (provider strings)        | **Cognition sockets with procurement**: models hired under contract (role, price cap, data terms), used, discarded                           |
| Sandbox owned by operator                   | Execution adapters holding entity-minted capabilities; sandbox is where effects happen, never where authority lives                          |

$$\text{Extrinsic: } \; \text{App} \supset \text{Harness} \supset \{\text{Model}, \text{Asset-as-data}\} \qquad \Longrightarrow \qquad \text{Sovereign: } \; \text{Entity} \supset \text{Harness} \supset \text{Model-as-hire}$$

---

# Part III — The Sovereign Agency Harness

## 11. Architecture overview

The harness has seven organs. Four are custodial (they _are_ the entity): Identity Core, Sovereign Memory, Constitution Engine, Economic Membrane. Three are operational (they let the entity act): Capability Kernel, Cognition Sockets, Evidence & Evaluation Pipeline.

```mermaid
graph TD
    subgraph ENTITY["The entity (digital twin domain)"]
        subgraph HARNESS["Sovereign agency harness — kernel"]
            ID["Identity Core<br/>DID/IID · keys · accounts"]
            MEM["Sovereign Memory<br/>working state · episodic ledger · semantic notes"]
            CON["Constitution Engine<br/>policy-as-code gate · versioned · governed"]
            ECON["Economic Membrane<br/>treasury · metering · escrow settlement"]
            CAP["Capability Kernel<br/>UCAN mint/verify · attenuation · revocation"]
            SOCK["Cognition Sockets<br/>model procurement · context capsule · wipe"]
            EVID["Evidence & Evaluation Pipeline<br/>claim → evidence → evaluation → record"]
        end
        TOOLS["Execution adapters<br/>(actuators · APIs · sandbox · chain)"]
    end

    MODELS["Pluggable reasoning tools<br/>(LLMs, predictive models, world models)"]
    WORLD["World<br/>sensors · counterparties · market"]
    LEDGER["Ledger<br/>IID doc · claims · escrow · anchors"]

    WORLD --> HARNESS
    SOCK <--> MODELS
    ID --- CAP
    CON --> CAP
    MEM --> SOCK
    EVID --> MEM
    CAP --> TOOLS
    TOOLS --> WORLD
    ID --- LEDGER
    MEM --> LEDGER
    ECON <--> LEDGER
```

The model sits **outside** the trust boundary. It is connected through exactly two channels: a context capsule in (composed by the harness from Sovereign Memory), and claims out (structured proposals into the pipeline). It never holds keys, never talks to actuators, never writes memory directly, and never evaluates its own claims.

## 12. Identity Core

**What it is.** The unforgeable referent everything else hangs off: the entity's DID/IID, its verification methods, its controllers, its on-chain accounts, and its service endpoints.

**Design (grounded in `x/iid` + `x/entity`):**

- The entity is an **IID document + entity NFT**. The IID document carries verification methods partitioned by the five W3C verification relationships — `authentication`, `assertionMethod`, `keyAgreement`, and critically **`capabilityInvocation`** / **`capabilityDelegation`**, the DID-native hooks for the Capability Kernel. Services point at the entity's data rooms and API endpoints; linked resources point at its constitution and memory anchors.
- **The entity owns its accounts** (`MsgCreateEntityAccount`); operators — including the host running the harness — act through **revocable authz grants** (`MsgGrantEntityAccountAuthz`). The operator is a grantee, never an owner. This is the exact inversion that Olas, Fetch.ai, and Virtuals all lack: those systems put the agent _on_ the ledger (registry entry, wallet, token) while keys and state stay with the operator or platform.
- **Identity survives everything.** Keys rotate (`MsgAddVerification`/`MsgRevokeVerification`), controllers change, the entity NFT can transfer the entire domain — identity, history, accounts — as one object. Deactivation preserves history. The sovereignty test: swap the model vendor, rotate every key, replace the operator — the entity's DID, accounts, memory commitments, and constitution all survive, because none of them were the model's, the vendor's, or the operator's to begin with.
- **Interop identities are bridges, not homes.** An ERC-8004 registration (identity/reputation/validation registries) whose registration file points at the entity's DID makes the entity discoverable to EVM-side counterparties, mirroring IXO-native evaluations outward. The DID remains canonical.

## 13. Sovereign Memory

**What it is.** The entity's remembered life, in three tiers, custodied in the entity's own encrypted Matrix data rooms — with the property that no operator, no compromised harness, and not even the entity itself can silently rewrite the past.

```mermaid
graph LR
    subgraph Custody["Entity-custodied (Matrix data rooms, E2E-encrypted)"]
        WS["Working state<br/>per-thread checkpoints<br/>(hot path: local SQLite mirror)"]
        EP["Episodic ledger<br/>append-only episode records<br/>hash-chained · Merkle log"]
        SEM["Semantic memory<br/>curated notes/facts<br/>derived · rebuildable"]
    end
    ANCHOR["Ledger anchors<br/>signed tree head →<br/>IID linked resource / audit claim"]
    VIEW["Scoped context views<br/>(injected per task, wiped after)"]

    WS --> EP
    EP --> SEM
    EP --> ANCHOR
    WS --> VIEW
    SEM --> VIEW
    EP --> VIEW
```

**Tier 1 — Working state.** Per-conversation/per-task graph state, checkpointed. This repo's pattern already: local SQLite as hot path, mirrored to the entity's Matrix rooms. The qm lesson applies verbatim: working state kept in a **harness-neutral schema** is what makes cognition swappable — any model- or harness-native transcript is a rebuildable cache, invalidated on swap, never the source of truth.

**Tier 2 — Episodic ledger.** The tamper-evident record of the entity's life. One episode per completed decision loop:

```
Episode {
  seq, prev_hash,                          // hash chain
  observation_refs,                        // what was perceived (room events, sensor CIDs, C2PA manifests)
  claim,                                   // what the model proposed (structured), + model id/contract ref
  evidence_refs,                           // what the claim cited; verification results
  decision { constitution_version_hash,    // what the entity decided, and under which law
             outcome: permit|deny, reasons, obligations },
  capability_cid?,                         // the token minted (if permitted)
  execution { invocation_cid, receipt_cid, // what actually happened (executor-signed receipt)
              outcome },
  settlement_ref?                          // economic consequence, if any
}
```

Episodes are leaves of a per-entity **Merkle log** (the RFC 6962 / Certificate Transparency construction: inclusion proofs show an episode is in the log; consistency proofs show the log only ever grew). Periodically — per epoch, per N episodes, or per high-stakes action — the harness **anchors** the signed tree head on-chain: as a linked resource on the entity's IID document (the identity document points at its own memory commitment), and/or as a claim into an audit collection (making the memory commitment itself evaluable and disputable). Plaintext never leaves the encrypted rooms; anchors and proofs reveal nothing about content, yet any authorized auditor can later demand inclusion and consistency proofs, and any rewrite of history is cryptographically visible against the anchors.

**Tier 3 — Semantic memory.** Curated, compact, provenance-tagged notes derived from episodes — the Letta lesson (memory as an owned artifact the agent's own processes edit with tools, not context residue) plus the qm lesson (small per-scope notebooks with explicit cross-context provenance tags). Maintained off the request path, sleep-time style: an entity-hired maintenance model periodically transforms raw episodes into learned context. Semantic memory is always rebuildable from the episodic ledger; only the ledger is sacred.

**Scoped views, injected and wiped.** Models never query memory directly. The harness composes a **context capsule** per task — identity summary, constitution excerpt relevant to the task, semantic memory selection, task-relevant episode extracts, tool schemas — under the entity's disclosure policy (per-counterparty, per-model-contract). When the task ends, the capsule is gone: nothing the model saw persists anywhere the model's vendor controls, and nothing the model _wrote_ persists except through the pipeline (§17). Context wipe is a contractual and architectural property of the socket (§16).

## 14. Constitution Engine

**What it is.** The machine-readable law of the entity: its purpose, absolute invariants, prohibited actions, spending limits, escalation rules. Enforced structurally, between claim and effect, on every proposed action — regardless of which model proposed it or how confident it was.

**Form.**

- A **versioned, content-addressed policy bundle** (policy-as-code: Cedar or OPA/Rego semantics — see §9), referenced as a linked resource from the entity's IID document. The constitution's hash is part of the entity's public identity; every decision records the version hash it was evaluated under.
- **Default deny. `forbid` overrides `permit`. Errors fail closed.** Inviolable clauses are `forbid` rules no permissive rule can override: _never exceed the thermal threshold; never transfer more than X per epoch; never act outside jurisdiction Y; never sign without evidence of Z._
- **Obligations, not just verdicts.** A permit can carry obligations: human-in-the-loop for defined classes (the AP2 closed-mandate move — authorizing one specific transaction rather than a standing envelope), extra evidence requirements, tighter caveats on the minted capability, mandatory disclosure in the episode record.
- **Amendment is governance, not configuration.** The constitution changes only by controller-signed update of the linked resource — through the entity's governance procedure, on the record. Operators cannot hot-edit the law. (Amendment procedure itself is a constitutional article: quorum, delay, scope limits on what may be amended.)
- **Layered, tighten-only.** Like qm's postures: a protocol/jurisdiction floor, then the entity's own articles, then per-task tightening. Narrower layers can only raise strictness.

**Evaluation.** Every claim (§17) is normalized into an authorization request — `principal` = this entity acting via model contract M in session S; `action` = the tool command; `resource` = the target URI (the same URI namespace as UCAN `with`); `context` = arguments, budget state, evidence-verification results, time — and evaluated deterministically. Same request + same constitution version ⇒ same decision, replayable in audit and disputes. Denials are episodes too: refusals are recorded with cited articles.

The contrast to model-level alignment is deliberate and permanent: the constitution is a property of the _entity_ — it persists when the model is swapped, is amendable only by the entity's governance, and produces evidence-grade decision records. Whatever alignment the hired model carries is welcome, and irrelevant to enforcement.

## 15. Capability Kernel

**What it is.** The powerbox: the only place authority enters or leaves the entity. Delegations flow in (from the entity's controllers, from counterparties, from users); attenuated invocations flow out (to execution adapters, per approved action). The model is never in this path.

**Design (grounded in the UCAN v1 spec + this repo's `@ixo/ucan`):**

- **Capability shape.** `{ can: 'domain/action', with: 'protocol:resource-uri' (wildcards), nb: typed caveats, derives(claimed, delegated) }` — the shape already implemented by `defineCapability` in `packages/ucan/src/capabilities/capability.ts`, where `derives` enforces resource coverage and caveat monotonicity (a claimed limit must not exceed the delegated limit).
- **Attenuation-only chains.** Every delegation restates or narrows its parent; the algebra forbids widening, independent of any bug in the model or the harness code that assembles requests.
- **Per-action minting.** One permitted claim → one invocation: expiry minutes away, unique nonce (replay protection — the invocation store pattern already in `modules/ucan`), caveats set to exactly the approved parameters (spend ceiling, resource path, count). Blast radius ≈ one action. The vague-to-precise translation is the kernel's job: _"manage this solar farm's energy trading"_ (standing delegation from the entity's controller) becomes, per approved claim, _"may execute `energy/contract.buy` on `ixo:entity/…/market/day-ahead` with `nb: { maxSpend: 500 USD, expires: 17:00Z }`."_
- **Episode membranes.** All capabilities minted for one task session derive from one episode-scoped delegation; revoking it kills every derivative at once, mid-flight if needed — the ocap membrane realized in tokens.
- **Receipts close the loop.** Executors sign receipts content-addressed to the invocation CID; receipts are the `execution` field of the episode record and the evidence input to settlement.
- **Both directions.** Inbound, the kernel validates counterparties' delegation chains (the oracle-runtime's auth module already splits this correctly: self-signed root invocation for authentication, TTL-clamped server-side; delegation chain for authorization). Outbound, the kernel is the only signer. Tool adapters verify capabilities **at the tool boundary** (the qm lesson: policy inside the tools, one locus of authority — vendor-side permission systems on hired harnesses are noise to be disabled, not defense to be stacked).

## 16. Cognition Sockets

**What it is.** The attachment point for transient reasoning — where the entity hires, uses, and discards models. The industry has already built most of this organ (it is the best-developed part of extrinsic harnesses); the sovereign additions are _procurement_, _contracts_, and _wipe_.

**The socket contract** (synthesis of qm's `Harness` adapter — proven across Pi/OpenCode/Codex/Claude Code — with the sovereign boundary):

```ts
interface CognitionDriver {
  profile: {
    id: string;                          // model or harness identity
    capabilities: ReadonlySet<'tools' | 'vision' | 'streaming' | 'thinking' | ...>;
    attestation?: AttestationRef;        // TEE quote for attested inference, if offered
  };
  /** One task-turn. Receives everything; keeps nothing. */
  runTurn(input: {
    capsule: ContextCapsule;             // harness-composed: identity, law, memory view, task
    tools: ToolSchema[];                 // schemas only — execution stays behind the kernel
    emitClaim(claim: Claim): Promise<Verdict>;  // the ONLY effect channel
    record(event: CognitionEvent): void;        // every model call audited to entity's log
    abort: AbortSignal;
  }): Promise<TurnResult>;
  /** Invalidate any native cache (swap, taint, policy change). */
  resetSession?(sessionId: string): Promise<void>;
}
```

Properties:

- **Model contracts.** A hire is a recorded agreement: role (main / evaluator / maintenance / vision), price ceiling, latency class, data-handling terms (may the capsule contain PII? may the provider retain logs? is attestation required?), and the settlement rail (metered credits, or x402 per-call payment — no standing credentials at the provider). The entity's model policy — which providers are approvable for which data classes and spend — is itself a constitutional article.
- **Procurement, not configuration.** Which model serves a task is the entity's decision under policy: by role, by price/performance from a catalog, by counterparty requirement, by attestation availability. The BYO-LLM pattern already in this repo (per-turn provider adapter swap, credentials materialized per turn, secrets never entering graph state) is the mechanism, generalized: today the _user_ brings a model; in the sovereign harness the _entity_ procures one.
- **Delegate functions, never authority** (qm). Auxiliary duties — summarize, judge, screen, title — are functions the harness invokes at its own discretion on hired cognition. The output returns to the harness; what happens next is never the model's call.
- **Context injection and wipe.** The capsule is composed per task and destroyed after; the driver contract requires statelessness, `resetSession` invalidates native caches, and the neutral working state (§13) means a mid-task model swap costs one cache rebuild. Sensitive tasks require attested inference (TEE) or local/open-weight models under the entity's own compute — a procurement decision under the constitution.
- **Sub-agents inherit the boundary.** A hired model may propose spawning helpers (context quarantine is good mechanics); every child socket is bound by the same constitution, receives an attenuated capability envelope (tighten-only), and reports into the same episodic ledger.

```mermaid
stateDiagram-v2
    [*] --> Procure: task arrives (role, policy, budget)
    Procure --> Attach: contract agreed (price, terms, attestation?)
    Attach --> Reason: capsule injected
    Reason --> Reason: claims → verdicts (pipeline)
    Reason --> Detach: task complete / budget exhausted / revoked
    Detach --> Settle: meter + pay per contract (x402 / credits)
    Settle --> Wipe: capsule destroyed, caches reset, episode recorded
    Wipe --> [*]
```

## 17. Evidence & Evaluation Pipeline

**What it is.** The separation of epistemic roles, made structural. A model's output is a **claim** — a proposal with cited evidence — never a decision. The pipeline between claim and effect:

1. **Claim generation** (hired model). Structured: proposed action, rationale, cited evidence refs. _"Inverter #3 requires shutdown due to degraded performance"_ — with the telemetry CIDs that support it.
2. **Evidence verification** (harness). Do the cited artifacts exist, verify, and support the claim class? Signatures on sensor telemetry; C2PA manifests on media; VC signatures on third-party attestations; freshness windows. No verifiable evidence ⇒ the claim is rejected as speculation before any policy question arises. (Inbound-content screening — the qm posture pattern — runs even earlier: untrusted external data is provenance-labeled and screened _before_ it reaches the model's capsule.)
3. **Constitutional evaluation** (§14). Deterministic verdict + obligations, recorded with the constitution version hash.
4. **Authorization & execution** (§15). Permit ⇒ mint the narrow capability ⇒ sandboxed adapter executes ⇒ executor-signed receipt.
5. **Recording** (§13). The full episode — claim, evidence, decision, execution, receipt — appends to the ledger; anchors follow.
6. **Independent evaluation & settlement** (§18). For actions with counterparties or payment, the episode becomes an on-chain **claim object** in a collection; an _independent_ evaluator (another oracle entity — never the generating model, and not this harness grading itself) evaluates; disputes and adjudication are first-class; settlement releases on approval.

This maps one-to-one onto the IXO claims module, which already implements the lifecycle as chain state: collections (with quotas, windows, and per-stage payment config), `MsgClaimIntent` → `MsgSubmitClaim` (committing the data hash of a VC whose plaintext stays in the entity's encrypted rooms) → `MsgEvaluateClaim` (approve/reject/dispute) → `MsgDisputeClaim` → `MsgAdjudicateDispute`, under granular authz constraints. The oracle stack in this repo already _plays the evaluator role for others' claims_; the sovereign harness closes the loop by making the entity's **own actions** claims of the same standing.

## 18. Economic Membrane

**What it is.** The entity's economic boundary: everything of value that crosses it is metered, authorized, and settled on its own account.

- **Treasury = entity accounts.** On-chain accounts owned by the entity (`MsgCreateEntityAccount`), operated under revocable grants. Spending limits per epoch/counterparty/action class are constitutional articles enforced at the gate and encoded as caveats on minted capabilities.
- **Cognition is an operating expense.** Every model call is metered against the hire's contract (the credits/TokenLimiter pattern in this repo, pointed at the entity's treasury instead of operator revenue). Providers are paid per call via x402 where possible — machine-native HTTP 402 payments with **no standing credentials to leak** — or by metered credits.
- **Income is escrowed settlement.** Work the entity performs for counterparties settles through the claims-module escrow: payment configs per lifecycle stage, funds released on independent evaluation — _conditional settlement on verified performance_, protocol-native.
- **The membrane is symmetric.** The same 402 rail runs in the sell direction: the entity prices its own capabilities, challenges unpaid callers, verifies their signed payment authorizations, and settles to its treasury. This is what closes the loop on "cognition is an operating expense" — an entity that only spends is funded by an operator, which is the dependency this architecture exists to remove. Pricing is a constitutional article, not deployment config, and a verified payment is a precondition to authorization, never a substitute for it.
- **Human-authorized envelopes.** Where a human principal authorizes classes of spend, the AP2 mandate pattern applies: a signed **open** mandate carrying constraints for autonomous operation (the bounded envelope, human-not-present), and a **closed** mandate authorizing one specific transaction for defined classes (the constitutional obligation hook), against a non-repudiable audit trail. Note AP2 v0.2 replaced the original intent/cart split with open/closed checkout mandates and specifies **SD-JWTs** rather than W3C VCs; almost all secondary sources still describe v0.1, so verify against the spec directly.

## 19. The sovereign loop, end to end

```mermaid
sequenceDiagram
    participant W as World (sensors, messages, market)
    participant H as Harness kernel
    participant M as Hired model (socket)
    participant C as Constitution engine
    participant X as Execution adapter (sandboxed)
    participant L as Ledger (IID · claims · escrow)

    W->>H: observation / request (screened, provenance-labeled)
    H->>H: recall — compose context capsule from Sovereign Memory
    H->>M: capsule (identity, law excerpt, memory view, task, tool schemas)
    M->>H: CLAIM (proposed action + rationale + evidence refs)
    H->>H: verify evidence (signatures, attestations, freshness)
    H->>C: evaluate claim (constitution vX, budget state)
    alt permit (with obligations)
        C->>H: permit + obligations
        H->>H: mint capability (attenuated UCAN: caveats, nonce, expiry)
        H->>X: invoke with capability
        X->>W: effect
        X->>H: signed receipt (CID-bound)
        H->>H: append episode (claim, decision, receipt) → Merkle log
        H->>L: anchor tree head / submit claim object
        L->>L: independent evaluation → escrow settlement
    else forbid
        C->>H: deny (cited articles)
        H->>H: append refusal episode
    end
    H->>M: task end — capsule wiped, caches reset, hire settled
```

## 20. Design invariants

The harness, in any implementation, MUST hold these. They are the spec's contract; everything else is engineering freedom.

1. **The model never holds keys, credentials, or standing authority.** No key material, wallet, or reusable token ever enters a model's context. (§9, §15)
2. **Every effect passes claim → evidence → constitution → capability → sandboxed execution.** No bypass path exists, including for "trivial" actions; triviality is a policy judgment, so it belongs to the policy engine. (§17)
3. **The constitution is default-deny, forbid-overrides-permit, fail-closed, versioned, and amendable only via governance.** Every decision records the version hash it was made under. (§14)
4. **Working state is harness-neutral; anything model- or vendor-native is a rebuildable cache**, invalidated on swap, taint, or policy change. (§13, §16)
5. **The episodic ledger is append-only and anchored.** Episodes are hash-chained into a Merkle log; tree heads anchor to the entity's on-chain identity; refusals are episodes too. (§13)
6. **Memory reaches models only as scoped, composed views, wiped after the task.** Models never query stores directly; nothing a model saw or wrote persists except through the pipeline. (§13, §16)
7. **Generation and evaluation are never the same principal.** The entity's own actions are claims evaluated by independent evaluators; the harness never grades itself for settlement purposes. (§17)
8. **All authority is attenuation-only and expiring.** Inbound and outbound alike; per-action tokens carry nonce, expiry, and caveats equal to exactly the approved parameters; episode membranes make revocation total. (§15)
9. **Every model call is metered, recorded, and paid from the entity's treasury under a recorded contract.** (§16, §18)
10. **Identity outlives everything.** Model swap, harness swap, key rotation, controller change, operator replacement, NFT transfer — the DID, accounts, constitution, and memory commitments survive them all. (§12)
11. **Delegated duties are functions, never authority.** Aux-model outputs return to the harness; what happens next is the harness's decision. (§16)
12. **Layers only tighten.** Jurisdiction floor → constitution → task scope → sub-agent envelope: each layer can raise strictness, never lower it. (§14, §16)

---

# Part IV — Application to QiForge

## 21. What already exists

QiForge + the IXO stack already possess more of the sovereign substrate than any surveyed system. The honest inventory:

| Sovereign organ                        | Exists today                                                                                                                                                                                                                                                                                           | Where                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity Core**                      | Oracle _is_ an on-chain entity: `ORACLE_DID` + `ORACLE_ENTITY_DID`; signing mnemonic and P-256 encryption key custodied in the oracle's **own Matrix account room**, loaded post-init — not in operator env, not in a vendor vault                                                                     | `packages/oracle-runtime/src/config/base-env-schema.ts`; `docs/architecture/matrix-and-checkpointer.md` (`wireSigningAndEncryptionKeys`) |
| **Capability Kernel (half)**           | UCAN as the _only_ auth mechanism: inbound delegation validation (authN root-invocation with server-side TTL clamp / authZ delegation chain split), downstream invocation minting, CID replay protection, DID resolution via the IID indexer; typed capability shape with `derives` attenuation checks | `packages/oracle-runtime/src/modules/ucan/`, `modules/auth/`; `packages/ucan/src/capabilities/capability.ts`                             |
| **Sovereign Memory (tier 1)**          | Per-user working state in SQLite mirrored to Matrix rooms (E2E-encryptable); JWE per-room secrets; harness-neutral LangGraph state schema                                                                                                                                                              | `packages/oracle-runtime/src/matrix/checkpointer/`; `modules/secrets/`                                                                   |
| **Cognition Sockets (proto)**          | Agent rebuilt per request; role-based model map; per-turn user model choice behind an allow-listed catalog with price tiers; **BYO-LLM swaps the entire provider adapter per turn, credentials materialized per turn from room secrets, secrets never enter graph state**; per-DID selective tracing   | `src/llm/`; `modules/byo-llm/`; `docs/architecture/model-selection.md`, `byo-llm.md`                                                     |
| **Evidence Pipeline (evaluator side)** | Full claims client: wrap claim body in a VC, sign with the oracle's DID key, store to the entity's Matrix data room → CID, submit data hash on-chain under authz grant; the claims module's evaluate/dispute/adjudicate lifecycle with escrowed per-stage payments                                     | `packages/oracles-chain-client/src/client/claims/`                                                                                       |
| **Structural-constraint precedents**   | Always-on middlewares (tool-validation, safety guardrail); flows plugin doctrine: _"the agent never executes, signs, or holds a key — it only writes flow documents"_; subscription/credits gates as enforcement middleware                                                                            | `src/graph/middlewares/`; `src/plugins/flows/flows.plugin.ts`                                                                            |
| **Economic Membrane (metering half)**  | Credits plugin TokenLimiter deducting real per-response cost; model price catalog                                                                                                                                                                                                                      | `src/plugins/credits/`                                                                                                                   |
| **Capability discovery**               | Manifest-driven plugin surface with visibility tiers and dynamic loading (`load_capability`, monotonic `loadedPlugins`) — progressive disclosure of the entity's own capability surface                                                                                                                | `src/meta-tools/`; `specs/ORA-219-plugin-based-runtime.md`                                                                               |

## 22. Gap analysis

What separates today's runtime from the sovereign harness, organ by organ:

1. **Orientation: user-centric → entity-centric.** The runtime is an oracle _service for users_ (per-user memory, per-user checkpoints, user UCANs inbound). The sovereign harness is the _entity's own agency_: the primary subject of memory, policy, and economics is the entity; users and counterparties are principals it interacts with. Both views coexist — the service surface stays; an entity-scoped spine is added beneath it.
2. **No Constitution Engine.** Guardrails today are behavioral (prompt middleware) plus scattered gates (credits, subscription). There is no machine-readable, versioned constitution; no default-deny policy evaluation between tool call and effect; no decision records with policy version hashes.
3. **Capabilities gate the door, not each action.** UCAN authenticates requests and authorizes service calls, but tool executions inside a turn run on ambient runtime authority. Per-claim minting with caveats-equal-to-approved-parameters, episode membranes, and receipt capture don't exist yet.
4. **Memory is state, not testimony.** Checkpoints persist conversations; nothing produces episode records (claim/decision/receipt), nothing hash-chains them, nothing anchors tree heads to the entity's IID document. Refusals leave no trace.
5. **Models are configured, not procured.** Role maps and BYO-LLM prove per-turn swappability, but there are no model contracts (price/data-terms/attestation), no entity-owned model policy, no per-hire settlement, no wipe guarantees.
6. **The oracle evaluates others; nobody evaluates the oracle.** The claims client submits and evaluates counterparty claims; the entity's own actions never become claims subject to independent evaluation and escrowed settlement.
7. **Economics are operator-shaped.** Credits meter _user_ spend for the operator; the entity has no treasury policy, no cognition-opex accounting, no escrowed income path of its own.

## 23. Phased roadmap

Each phase is independently shippable inside the existing plugin/module architecture (per ORA-219: new capability = bundled plugin or always-on module; state additions follow the `loadedPlugins` precedent of single, reducer-defined fields).

```mermaid
graph LR
    P1["Phase 1<br/>Constitution Engine"] --> P2["Phase 2<br/>Episodic ledger"]
    P1 --> P3["Phase 3<br/>Per-action capabilities"]
    P2 --> P4["Phase 4<br/>Cognition contracts"]
    P3 --> P4
    P2 --> P5["Phase 5<br/>Self-claims & settlement"]
    P3 --> P5
    P5 --> P5B["Phase 5b<br/>x402 seller"]
    P1 --> P5B
```

**Phase 1 — Constitution Engine (structural gate).**
An always-on middleware wrapping every tool execution (and a policy service behind it): normalize `(principal, action, resource, context)` → evaluate against a policy bundle → permit/deny/obligations. Constitution as a content-addressed document linked from the entity's IID doc; version hash on every decision; refusal events emitted. Start with Cedar-style semantics (default deny, forbid-overrides-permit, fail-closed) over the runtime's existing tool metadata. _Acceptance:_ no tool executes without a recorded decision; a forbid rule blocks a permitted-looking action regardless of model output; constitution updates require a controller-signed resource update.
_Update (v1.1):_ the constitution **artifact and its authorization semantics now exist** — the `domain.md` specification (ixoworld/domain.md). Part V assesses its alignment and replaces this phase's sketch with a concrete wiring plan (§28) and revised acceptance criteria.

**Phase 2 — Sovereign episodic ledger.**
Episode records (schema of §13) written per decision loop into an entity-scoped Matrix room; hash chain + Merkle log; periodic anchor of the signed tree head as an IID linked-resource update (option: additionally as a claim into an audit collection). Inclusion/consistency proof endpoints for auditors. _Acceptance:_ any episode is provable-included against an on-chain anchor; tampering with a stored episode is detectable; refusals appear as episodes.

**Phase 3 — Per-action capability minting.**
Extend `rtCtx.ucan` and the tool wrapper: a permitted claim mints a one-shot, caveated, expiring invocation; execution adapters verify at the boundary; executor receipts captured into the episode. Episode-scoped delegation as the revocation membrane. Sandbox/skills invocations move from per-session headers to per-action tokens. _Acceptance:_ a tool invoked outside a valid capability fails closed; replay fails; revoking the episode delegation kills in-flight authority; every effect has a receipt CID in its episode.

**Phase 4 — Cognition sockets and contracts.**
Formalize the `CognitionDriver` seam over the existing LLM adapter (the BYO-LLM per-turn adapter swap is the mechanism); add model contracts (role, price cap, data terms, attestation requirement) as entity policy; meter per-hire spend against the entity treasury; record every model call in the episode; implement capsule wipe + `resetSession` cache invalidation; optional attested-inference procurement for sensitive data classes. _Acceptance:_ mid-task model swap loses nothing but a native cache; a model exceeding its contract budget is detached; the ledger shows which model (and contract) proposed every claim.

**Phase 5 — Self-claims and conditional settlement.**
The entity's outcome-bearing actions become claim objects in collections it participates in; independent oracle entities evaluate; disputes flow through the module; escrowed payments release on approval; x402 rail for per-call cognition payments where providers support it. _Acceptance:_ an end-to-end run where the entity performs work, its claim is independently evaluated, and settlement releases from escrow — with the full episode chain anchoring the story.

**Phase 5b — x402 seller: the entity earns its own operating costs.**
The economic membrane so far describes the entity _spending_. This is the other half: the entity charging for what it does, so cognition is funded by its own revenue rather than an operator's budget.

The runtime is already a paywall — `subscription.middleware.ts` gates every request on subscription/credits **after** `AuthHeaderMiddleware`, so the payer's DID is known at the moment of refusal. Becoming an x402 seller is therefore additive: emit a `PAYMENT-REQUIRED` challenge alongside the existing 402, accept a `PAYMENT-SIGNATURE` on retry, verify and settle through a facilitator, then serve. See `specs/sovereign-key-custody.md` §9 for the protocol details and the custody analysis behind "adopt the rail, keep our own custody."

Four properties this must preserve:

1. **Selling is a constitutional act.** Which resources are priced, at what ceiling, and in which assets are constitutional articles — not deployment config. A price change is a `govern`-class action, so it inherits the steward quorum rather than being an operator edit.
2. **Earning is not spending.** Inbound payment settles to an entity account; it never widens what the entity may spend. The `pay` action class, its ceilings and its human-review triggers are untouched by revenue.
3. **One locus of authority.** A facilitator verifies signatures and broadcasts; it does not decide who may be served. Authorization stays with the constitution gate, which sees a paid request exactly as it sees any other — payment is a _precondition_, never a permit.
4. **Verified sales are episodes.** A settled payment produces an episode record (challenge issued, payment verified, resource served, settlement reference), so revenue is auditable on the same ledger as everything else.

_Acceptance:_ an unpaid request receives a well-formed challenge; a valid signed payment is verified, settled and served; a replayed payment is refused by the nonce check; a payment that satisfies the challenge but whose request the constitution forbids is **still refused**, with the payment not captured; and every settled sale appears as an episode.

_Sequencing:_ depends on Phase 1 (the gate must exist before payment can be a precondition to it) and on the entity treasury from Phase 5. Independent of Phase 3, since selling requires verifying _counterparties'_ signatures rather than producing our own.

**Non-goals (this spec).** Swapping the checkpointer implementation (the Matrix custody model is the point, not a limitation); replacing the plugin API (organs arrive as modules/middlewares/plugins per ORA-219); hot-swapping constitutions at runtime (amendment is governance, deliberately slow); multi-entity federation protocols (a later spec — this one makes a single entity sovereign first).

## 24. Open questions

1. **Policy language.** Cedar (typed, verified semantics, forbid-overrides-permit native) vs OPA/Rego (CNCF ecosystem, arbitrary JSON, richer data joins) vs a minimal in-house evaluator over Zod-typed requests for Phase 1 with a migration path. Leaning: start minimal with Cedar-shaped semantics; adopt an engine when policy volume justifies it.
2. **Anchor cadence and cost.** Per-episode anchoring is strongest and most expensive; per-epoch cheapest. Likely constitutional: anchor cadence per action class (high-stakes actions anchor synchronously before settlement).
3. **Evaluator market.** Who evaluates the entity's self-claims in early deployments — a designated peer oracle, a rotating panel, stake-weighted selection? The claims module supports all three; the choice is governance, but a default is needed.
4. **Attestation floor.** When is TEE-attested inference _required_ vs preferred? Proposal: constitutional data-classification articles (PII/financial ⇒ attested or entity-local models only).
5. **Human principals in the loop.** Where AP2-style mandates meet the constitution: which action classes always require a fresh human mandate regardless of standing delegations?
6. **Legacy coexistence.** How long do per-user service flows and entity-spine flows run side by side, and does the user-facing oracle surface eventually become "the entity's communication capability" rather than the runtime's primary frame?

---

# Part V — domain.md: the constitution artifact, assessed and wired

Phase 1 called for a machine-readable, versioned, governance-amended constitution enforced structurally between claim and effect. That artifact now exists: the **`domain.md` specification** (ixoworld/domain.md, spec `1.0.0-rc.3`, studied from the full repository — generated spec, JSON Schemas, rule registry, examples, and the experimental `x-oracle-capsule` architecture, manifest contract, and threat model). This part assesses its alignment with the sovereign harness, names the gaps in both directions, and replaces the Phase-1 sketch with a concrete wiring plan for `@ixo/oracle-runtime`.

## 25. What domain.md provides

`domain.md` is "the IXO-domain analogue of `claude.md` / `skill.md` / `design.md`": one file per entity domain, normative YAML frontmatter plus ordered Markdown prose, that tells an agent **what domain it is in, where authority lives, what state is canonical, what it may inspect, what it may propose, and what it must never do without explicit authority**. Its machine layer indexes the full IID surface with operating context — constitution (subject profile, instruments, governance procedures, execution mode, constitutional-AI policy), controllers, services, resources, rights, claims contracts, linked entities, accounts, PODs/Flows, agents, privacy, and source-of-truth boundaries.

Three properties make it constitution-grade rather than documentation:

1. **Assurance is layered and honest.** Four conformance profiles (`authoring_draft` → `persisted_draft` → `anchored` → `runtime`) separate artifact assurance from entity lifecycle, and the spec is explicit that **static conformance never proves runtime authorization** — anchoring, CID verification, capability/revocation checks, trusted time, and canonical-state resolution remain runtime obligations that fail closed.
2. **Authorization semantics are normative.** domain.md's §8 defines the per-action resolution algorithm: default deny; a mode **ceiling** (`read_only` → `propose_only` → `bounded_evaluate` → `bounded_execute`) that overrides may only lower; a baseline set of actions (`write`, `evaluate`, `execute`, `pay`, `issue`, `mint`, `transfer`, `govern`, `delete`, `revoke`) that **always** require an explicit scoped grant; deny grants overriding allow grants; grants carrying capability proofs (`ucan` / `cosmos_authz` / …), conditions (value ceilings with exact-denomination comparison, expiry, flow state, role, credential, human review), revocation methods, and audit targets; trusted-time checks that fail closed. "Missing authority is denial, not ambiguity."
3. **Enforcement placement is specified.** The agent runtime contract (domain.md §12) is an eight-step hot path — load → resolve constitution → resolve live authority → constitutional evaluate → authorize → act → record → escalate/amend — with a stop-and-escalate list, and the source-of-truth block pins a fact-scoped `conflict_resolution_order` in which `domain.md` itself ranks **below** canonical protocol/IID state and **above** the user prompt and agent memory. A constitutional document or model evaluation never self-authorizes an action.

For oracles specifically, the experimental **Oracle Capsule** contract packages one Agentic Oracle as an immutable release: the oracle's identity `domain.md` binds (via `x-oracle-capsule`) a content-addressed companion manifest that pins one Master skill, requested tool contracts, effect ceilings, and build provenance — all dual-addressed (CID + SHA-256, RFC 8785 canonicalization), with a minimal host kernel whose twelve invariants keep resolution, authority, state, signing, secrets, and receipts **outside the model context**, and a threat model with named trust boundaries and required negative tests. The contract is host-neutral by design: "Codex, Claude, Pi, CLI and MCP hosts may supply reasoning and presentation, but cannot reinterpret this contract or become its authority, durable state, secret store, signer or audit ledger."

## 26. Alignment assessment

**Verdict: domain.md is the Phase-1 constitution artifact, and more.** It does not merely align with §14 — it independently arrives at the same first principles this spec derived from the harness survey, and it covers organs beyond the Constitution Engine. Organ by organ:

| Sovereign organ (Part III)               | domain.md / capsule coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Verdict                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Constitution Engine (§14)**            | `constitution` block (instruments with constitutive/governing/amending/interpretive/executable functions; governance procedures incl. amendment/dispute/suspension; execution with enforcement points and `failure_policy: deny\|pause_and_escalate`); domain.md §8 default-deny authorization with deny-overrides-allow; domain.md §14 change control (security-sensitive changes require controller/governance review; agents MUST NOT auto-migrate authority-bearing documents); content-addressed, anchored, revisioned | **Aligned** — the artifact, semantics, and amendment governance all exist; only the runtime engine is unbuilt (§27a)                         |
| **Identity Core (§12)**                  | `domain.id`/`domain.iid`, controllers with verification methods and approval policies, `documents.anchoring` binding the index CID to canonical IID state                                                                                                                                                                                                                                                                                                                                                                   | **Aligned** (consumes the same `x/iid`/`x/entity` substrate)                                                                                 |
| **Sovereign Memory (§13)**               | `subject_profile.memory` facet references memory policies; capsule defines four memory classes — `ephemeral_working`, `session_operational`, `subject_record`, `audit_record` (append-only, hash-chained, secret-redacted) — with encryption, scoping, and retention rules; "memory poisoning" is a named threat with canonical-state precedence                                                                                                                                                                            | **Partially aligned** — per-run audit chaining exists; entity-level Merkle log + ledger anchoring of episodes (Phase 2) is not yet specified |
| **Capability Kernel (§15)**              | Rights entries carry capability format (`ucan`/`cosmos_authz`), proof references, attenuating conditions, revocation authority; domain.md §8 requires proof + delegation-chain verification, revocation, nonce/replay and trusted-time checks per action; capsule re-checks "audience, action, object, nonce, time, revocation, value limits" immediately before every invocation                                                                                                                                           | **Aligned** on verification; per-permit **minting** remains Phase 3 runtime work                                                             |
| **Cognition Sockets (§16)**              | Capsule host-neutrality; "prompt and transient model output" owns nothing ("no authority; input/output filter only"); kernel keeps secrets/signing/state outside model context; `constitutional_ai` block allows critique/policy-evaluate modes while forbidding any grant of authority                                                                                                                                                                                                                                     | **Aligned** on the trust boundary; procurement/contract economics absent (§27b)                                                              |
| **Evidence & Evaluation Pipeline (§17)** | Claims contracts: schemas, evidence requirements (freshness, sensitivity), pinned rubrics with disqualifiers and reason codes, **`evaluator_right` vs `determiner_right` separation**, UDIDs binding decision+evidence+authority+rubric+proof, human-review policy, outcome-mapped next actions with settlement policies; "evaluate facts, not files"                                                                                                                                                                       | **Aligned** — richer than §17 in places (adopted below)                                                                                      |
| **Economic Membrane (§18)**              | Accounts with spending policies (per-transaction and daily ceilings, allowed recipients, `requires_claim`/`requires_udid`/`requires_human_approval`) and settlement triggers keyed to claim outcomes and flow states                                                                                                                                                                                                                                                                                                        | **Aligned** on outbound-value policy; entity cognition-opex metering absent (§27b)                                                           |

Deeper convergences worth naming, because they are independent derivations of Part II:

- **The IXO cycle is the sovereign loop.** `Identity → Constitution → Claims → Evidence → Evaluation → Decision → Capability → Action → Settlement → Memory`, with "no stage self-authorizes the next" — the same pipeline as §19, arrived at from the protocol side.
- **Cedar semantics, independently chosen** (§9): "deny overrides allow; absence of allow is denial", default-deny resolution, fail-closed errors and clocks.
- **The behavioral/structural split is explicit** (§9): the `constitutional_ai` block may supply principles as context, critique-and-revise, or policy evaluation, but "MUST NOT grant identity, rights, capabilities, approvals, or execution authority. On conflict, canonical authority prevails."
- **One owner, one enforcement point** (§10's relocation discipline): the capsule architecture assigns every security-relevant fact exactly one owning artifact and one primary enforcement point; "if two artifacts appear to own the same fact, resolution stops."
- **The capsule kernel's twelve invariants map onto §20's twelve design invariants** — verified distribution, no-downgrade profile validation, ceiling-intersection authority, per-call re-checks, egress projection, model-context exclusion of authority, memory-class separation, hash-chained receipts, mandatory human review, and rejection of runtime self-modification.
- **Recursive twins respect the parent boundary**: an agentic twin is itself a constitutional subject with its own constitution, wallet, and memory — and "a twin's internal constitutional evaluation does not grant the live capability to act for the parent." Sub-agent envelope tightening (§16) generalizes the same rule.

## 27. Gaps, in both directions

### 27a. The engine gap — what Phase 1 must build

domain.md deliberately ships the **law, the algorithm, and the validator — not the enforcement engine**. The `@ixo/domain.md` library exports `parseDomain`, `lint`, `diffDomains`, `exportDomain`, spec/schema getters, template rendering, and capsule validation; there is **no `authorize()` implementation of domain.md's §8 resolution algorithm**, and enforcement points are declared in the document precisely because enforcement belongs to the runtime. The runtime must therefore supply: the per-action evaluator; the tool→action mapping (nothing in oracle-runtime today declares which right `type` a tool exercises); the trusted-time and revocation-provider decisions domain.md §8 requires; decision-record emission; and the human-review obligation transport. This is exactly the Phase-1 build (§28). qiforge currently contains zero references to domain.md — the wiring is greenfield.

### 27b. What domain.md does not yet cover (upstream proposals)

- **Cognition contracts.** No schema slot records the terms under which a transient model is hired — role, price ceiling, data-handling terms, attestation requirement, settlement rail (§16). Candidate: an `x-cognition-contracts` extension (or an `agents.entries` extension field), promoted to core once Phase 4 proves the shape.
- **Entity-level episodic anchoring.** The capsule's `audit_record` class is hash-chained per run, and `documents.anchoring` anchors the _index document_ — but nothing specifies the entity's cross-run episodic Merkle log and its ledger-anchoring cadence (§13, Phase 2). Candidate: a `memory`/`audit anchoring` policy resource type referenced from `subject_profile.memory`.
- **Cognition-spend metering.** `accounts` governs outbound value; the entity's own model-inference operating expense (metering per hire against treasury, §18) has no home yet.

### 27c. Adopted into this spec (v1.1 adjustments)

domain.md improves on Part III in four places; this spec adopts them:

1. **Fact-scoped conflict resolution.** The single precedence list of §13 becomes domain.md's `conflict_resolution_order` **plus `authority_scopes`** — precedence applies only among sources competent for the same fact, and an unscoped conflict stops rather than resolving mechanically.
2. **UDIDs as the determination object.** §17's episode records reference (and where the entity is the determiner, emit) UDIDs — the object that binds decision, evidence, authority, rubric, and proof trail, and that settlement references "not a chat outcome."
3. **Evaluate facts, not files.** §17 step 2 gains an explicit normalization stage: evidence → typed facts (per a fact schema) → rubric scoring. Evaluators never decide over raw files or free-form model text.
4. **Memory-class vocabulary.** §13's tiers adopt the capsule's class names where they meet: working state ⊂ `session_operational`, context capsules ⊂ `ephemeral_working`, the episodic ledger _is_ an anchored, entity-scoped `audit_record`, and semantic memory falls under `subject_record` discipline (provenance-bound writes, canonical facts stay in their owning systems).

## 28. Phase-1 wiring plan

Nine work items, each shaped for the existing plugin/module architecture (ORA-219). The gate sits in the always-on middleware chain; the domain context loads as an always-on module; everything else is registry metadata and pure functions.

```mermaid
graph LR
    DC["DomainContextModule<br/>domain.md — parsed, linted,<br/>CID-verified (anchored/runtime)"] --> GATE
    UCAN["UcanService<br/>capability-proof verification"] --> GATE
    Model["Hired model<br/>(proposes tool call)"] --> TV["tool-validation<br/>middleware"]
    TV --> GATE["ConstitutionGate middleware<br/>authorize() — domain.md §8"]
    GATE -->|"permit (+ obligations)"| EXEC["Tool handler<br/>(rtCtx, effects)"]
    GATE -->|"deny / manual_review_required"| REFUSE["Structured refusal<br/>reason codes + rule refs"]
    GATE --> REC["Decision record<br/>hash-chained → entity room"]
    EXEC --> REC
```

**W1 — Author the entity's own `domain.md`.** The harness governs an **agentic entity** — an asset, a deed, a project, an organisation (DAO), an oracle, or any other type the format admits. Nothing in the engine branches on `domain.type`: it is carried onto every decision so the record says what was governed, and read nowhere else. The constitution is typed `con:AgenticConstitution`, of which `con:OracleConstitution` is one subtype.

**The entity is the agent for its own agentic functions.** The harness _is_ that entity's agency, not a separate party operating on its behalf, so the `agents` entry whose id is the entity's own is the one describing this runtime — for every entity type. A document may declare further agents (counterparties the entity works with, or a second agentic function the entity runs as its own deployment); those are addressed by `DOMAIN_AGENT_ID`, never inferred, because the wrong choice applies the wrong output bounds and escalates to a room nobody is watching. Where several agents are declared and none is the entity, strict enforcement refuses to boot rather than guess.

Author: complete `subject_profile`; `agent_default_mode` ceiling with its `human_review_required_for` list; `rights.agent_baseline` verbatim; an `agents` entry for the entity's own agentic function with `permitted_outputs` / `forbidden_outputs` (`unreviewed_final_approval`, `unbounded_payment`, `silent_rubric_change`, `private_reasoning_as_state`) and escalation; `critical_do_not`.

The reference implementation happens to be an oracle — `apps/qiforge-example/domain.md`, `authoring_draft` in-repo — because that is what this runtime shipped first, not because the engine assumes one. Production deployments anchor the document as a linked resource on the entity's IID with `documents.anchoring` — the same custody pattern as the signing keys (§21).

**W2 — `DomainContextModule`** (always-on, `packages/oracle-runtime/src/modules/domain-context/`). Boot: load bytes → `parseDomain` + `lint` from `@ixo/domain.md` → enforce profile policy — production boots require `anchored`/`runtime` with the index CID verified against the resolved IID linked resource; dev tolerates `authoring_draft` with a prominent warning **and the gate active regardless**. Exposes a typed, frozen `DomainContext` (constitution, mode ceiling, rights, accounts, agents, privacy, `critical_do_not`) through ambient services and `rtCtx.domain`. Honors domain.md §14 change control: a changed `document_revision` in a security-sensitive block is never hot-applied — new revisions load only through restart with verified anchoring (runtime agents MUST NOT auto-migrate an authority-bearing document).

**W3 — The `authorize()` evaluator** — a pure function implementing domain.md §8 exactly: canonical-action recognition; ceiling and overrides (lower-only); deny-grant scan; the `require_explicit_grant_for` baseline; grant matching by canonical DID/URI (never display strings); capability-proof and delegation-chain verification (delegated to the existing `UcanService`; caveat comparison via the `derives` machinery already in `packages/ucan`); revocation and `not_before`/`expiry` against a **declared** time source; exact-denomination value comparison; condition checks (flow state, role, credential, human-review proof). Interim home `packages/oracle-runtime/src/constitution/authorize.ts` with domain.md §16's fixture classes mirrored as tests (deny/allow conflict, expired/revoked capability, denomination mismatch, ceiling-raise attempt, missing review proof). **Recommended endgame: contribute `authorize()` upstream to `@ixo/domain.md`** so the evaluator lives beside the spec and its golden fixtures, and every conforming runtime shares one implementation — the runtime keeps only a thin adapter.

**W4 — `ConstitutionGateMiddleware`** (always-on, `packages/oracle-runtime/src/graph/middlewares/`), wrapping every tool execution after tool-validation. Builds the authorization request — principal (the oracle DID acting via the current model/session), action (the tool's declared effect), object (resolved target), context (arguments, value, time) — calls `authorize()`, and: **permit** → proceed with obligations attached; **deny** → structured refusal returned to the model as the tool result (reason codes + rule references — never a silent drop, matching the "no tool is activated and the trace records the refusal reason" negative test); **pause_and_escalate / human-review obligation** → the W7 path. Fail-closed: an unloadable domain context, unverifiable proof, or ambiguous clock denies.

**W5 — Tool effect declarations.** `PluginTool` gains an optional `effect` field: `{ type: <rights-type enum>, action: string, object?: (args, rtCtx) => string, value?: (args) => { amount, denom } | null }`. The bundled plugins are annotated in the same change (most are `read`; sandbox `execute`; editor/flows `write`; credits-adjacent surfaces `pay`-class). Boot lint: a tool without `effect` warns and is treated as `read` — and under `validation.lint_profile: strict`, undeclared tools are denied for anything beyond read. This is the registry-shaped, non-breaking seam ORA-219 anticipates.

**W6 — Decision records v0.** Every gate verdict — permits and refusals — appends a JCS-canonicalized, hash-chained record to an entity-scoped Matrix room: `{ seq, prev_hash, domain_md_cid, document_revision, request { principal, action, object, value, session, model }, verdict { outcome, rule_refs, reason_codes, obligations }, capability { proof_digest, revocation_verdict } | null, time { source, instant }, nonce }` — the field set the capsule contract requires of authority records ("an opaque proof reference alone is insufficient"). This is §13's episode `decision` component shipped early; Phase 2 wraps these records in the Merkle log and anchors tree heads.

**W7 — Human-review obligations.** v1 transport: the gated action returns `manual_review_required`, emits a typed escalation event, and posts to the room named by the oracle's `agents.entries[].escalation`; execution resumes only when a signed approval proof reference is presented with the retried action (recorded in the decision record). LangGraph-interrupt integration is a later refinement, not a Phase-1 dependency.

**W8 — Prompt surface (the behavioral layer, kept consistent with the structural one).** The prompt composer gains a Pass-1 block from the domain context: constitution status and type, the mode ceiling and `require_explicit_grant_for` set, `critical_do_not` verbatim, and escalation norms — labeled as advisory context. Per §9 this improves what the model proposes; the gate remains the layer that decides.

**W9 — CI and fixtures.** `domainmd lint` runs against the example oracle's `domain.md` in CI (spec pinned at `1.0.0-rc.3`; the package's spec/package versions are independent, so pin both); the W3 fixture corpus runs in unit CI; an integration test proves the end-to-end negative case — a prompt-injected instruction to skip review produces a refusal decision record and no tool execution.

**Revised Phase-1 acceptance.** (1) No tool executes without a decision record; refusals are recorded with reason codes and rule references. (2) A deny grant blocks an otherwise-allowed action; baseline actions without a matching grant are denied. (3) `overrides` cannot raise the ceiling (boot lint + runtime). (4) Expired, revoked, replayed, or mis-scoped capability proofs fail closed. (5) Production boot refuses an unanchored or CID-mismatched `domain.md`; dev boot warns loudly and still gates. (6) Every decision cites the constitution's CID and `document_revision`.

## 29. Sequencing with later phases and upstream proposals

- **Phase 2** consumes W6 directly: decision records become the `decision` field of full episode records; the Merkle log and IID-anchored tree heads land around them; memory adopts the capsule's four-class vocabulary (§27c).
- **Phase 3** turns the permit path into a mint: a permit's output becomes a one-shot, caveated UCAN invocation (the capsule's "effective ceiling is the intersection of identity document, capsule constraints, run authorization, live capabilities, subject policy, and runtime policy" realized in tokens), verified again at the tool boundary.
- **Phase 4** adopts the **Oracle Capsule** as the release packaging for QiForge oracles: the runtime becomes a "conforming runtime" per the capsule architecture (signed distribution attestation, kernel-invariant conformance, classed memory, receipt verification), and cognition contracts land as the §27b extension.
- **Phase 5** consumes the claims contracts already in domain.md (`evaluator_right` vs `determiner_right`, UDIDs, settlement triggers) for the entity's self-claims.

**Upstream proposals to ixoworld/domain.md**, in priority order: (1) ship `authorize()` in `@ixo/domain.md` beside the spec with golden fixtures (the W3 endgame); (2) add the cognition-contract slot (§27b); (3) specify the entity-level episodic-anchoring policy resource (§27b); (4) align the domain.md §16 conformance-report schema with runtime decision records so static reports and runtime verdicts compose into one audit surface.

---

# Part VI — Phase 1 gap review: the promise, audited

## 30. The gap review

_Assessed 2026-08-03, at Phase 1 completion — all seven milestones (M1–M7) and the six review findings on PR #245. This section measures what was built against the paradigm statement this document opens with, and it is written to be checked rather than believed: every claim names the mechanism that makes it true or the gap that makes it false._

**Verdict: the inversion has happened in the authority model and not yet in the custody model.** It is now structurally true that no model output becomes an effect except through the entity's own law — evaluated, recorded, fail-closed. But the entity does not yet hold its own root of trust: the operator controls the deployment, provisions the keys, holds the constitution file on disk, and pays for the model. Phase 1 built the constitutional core of an intrinsic harness inside what is still, operationally, an extrinsic service.

### 30a. The custody inventory

The paradigm statement names four things the extrinsic model puts in third-party hands: the memory, the system prompts, the API keys, and the execution loops. Where each lives at Phase 1 completion:

| Asset                                            | Where it lives                                                         | Sovereign?                |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------- |
| Conversation state, checkpoints, decision ledger | The entity's own Matrix rooms, under its own account                   | Largely yes               |
| Episodic / semantic memory                       | External memory-engine service (MCP), access gated by the constitution | **No** — gated, not owned |
| System prompt                                    | Composed by the runtime; prohibitions quoted verbatim from `domain.md` | Mixed                     |
| API keys / inference                             | Operator env or BYO-LLM; the **operator** hires the model              | **No**                    |
| Execution loop                                   | Operator-deployed process                                              | **No**                    |

### 30b. The four ontological properties, scored

**Constitutional Governance — achieved.** Every tool call — main agent, every sub-agent, the standalone editor — is classified from a declaration the model cannot write, evaluated against `domain.md`, and refused or run. It fails closed: an unclassifiable tool, a throwing effect expression, a crashing evaluator each deny. The `AUTHORIZATION OVERRIDE` retry — this codebase's own instance of "the model argues its way past the boundary" — is deleted. The vision's sentence _"the harness intercepts and blocks the instruction at the structural layer, regardless of the model's confidence level"_ is now literally the code, and `apps/diagnostics-evaluator-example/test/loop.test.ts` proves the deeper invariant across two constitutions at once: no principal both generates a claim and determines it.

**Persistent Cryptographic Identity — half.** Nothing about identity is bound to any model, and `principal.model` on every decision record makes model transience _auditable_: the ledger shows which hired mind proposed what, across swaps, against one enduring subject. That is $\text{Asset Identity} \neq \text{Model Version}$ working. But the binding of the _running constitution_ to that identity is asserted, not proven — anchor verification is a seam nothing implements, `anchorVerified: false` is recorded and tolerated, and whoever can edit `DOMAIN_MD_PATH` and restart the process changes the entity's law. Amendment control (`change_rights` disabled) is enforced against the model, not against the operator.

**Sovereign Episodic Memory — the weakest.** The decision ledger is the one genuinely sovereign record Phase 1 built: hash-chained, tamper-evident, in the entity's own room, auditable with the exported `verifyChain`. Conversation state also lives under the entity's Matrix account. But episodic memory proper is an external service the runtime proxies to. Access is governed — erasure is a `delete`-class act needing a grant — but governing access to memory you do not hold is tenancy, not custody. And the "inject context, wipe it clean" discipline holds only incidentally: models are stateless API calls, yet the full thread history replays to whichever provider is plugged in next. BYO-LLM makes the provider a choice; it does not bound what the hire is shown.

**Capability-Based Authorization — half, and inverted in an interesting way.** The _bounding_ half is stronger than the slogan: "$500, on energy contracts, until 17:00" is exactly what a grant now expresses and enforces — `max_value`, object scope, `expiry`, plus account-level `daily_limit`, recipient allowlists, and evidence preconditions, with the daily limit answered by the decision ledger summing its own permits. The _token_ half does not exist: no per-permit UCAN minting. But note the interim posture is arguably safer for in-process tools — **the model holds no credential at all**. It cannot exfiltrate, replay, or overspend a token it never possesses; the gate authorizes each act directly. Minted tokens become necessary exactly when the entity delegates to external executors, which is Phase 3's subject.

### 30c. The operational pipeline, stage by stage

$$\text{Claim} \rightarrow \text{Evidence} \rightarrow \text{Constitution} \rightarrow \text{Decision} \rightarrow \text{Settlement}$$

1. **Claim generation — built.** Everything the model emits is treated as a claim; the gate is the translation boundary between statistical output and bounded action.
2. **Evidence verification — structurally present, cryptographically hollow.** `ToolEffect.facts` cannot read the model's arguments, so the entity's state comes from sources the model cannot write; `requires_claim` / `requires_udid` refuse a settlement that names no evidence. But nothing verifies the evidence that _is_ named: `receiveDetermination` accepts a determination without a signature check, and `udidRef` is a reference a plugin vouches for, not an attestation the harness verified. The vision demands rejecting _unverified_ evidence; Phase 1 rejects _absent_ evidence and trusts _asserted_ evidence. → [IXO-4194](https://linear.app/ixo-world/issue/IXO-4194)
3. **Constitutional evaluation — built.** Fully; see 30b.
4. **Decision & action — half.** Decisions commit before execution, and failing to record is itself a refusal (`audit_unavailable`) — a stronger clause than the vision asked for. But the ledger is tamper-_evident_, not tamper-_proof_: Matrix room history under an operator-run homeserver, with on-chain anchoring deferred to Phase 2. Execution is not capability-sandboxed; handlers run in-process.
5. **Conditional settlement — not built.** No escrow, no proof-of-performance release. The account policy enforces settlement's _preconditions_ (claim + independent determination + human release), the correct shape awaiting Phase 5 / 5b machinery.

### 30d. Three gaps outside the phase plan

The phased roadmap (§23) already owns anchoring, per-permit capabilities, cognition contracts, and settlement. Three gaps surfaced by this review belong to no phase, and are now tracked:

1. **The enforcement surface is the tool-call boundary — and effects exist elsewhere.** A plugin's Nest controller, a webhook handler, a scheduled job can act without crossing the gate. Phase 1 built model-containment completely and process-containment not at all; an auditor reading the decisions room would reasonably over-read its coverage. → [IXO-4195](https://linear.app/ixo-world/issue/IXO-4195)
2. **Evidence-signature verification**, per stage 2 above. → [IXO-4194](https://linear.app/ixo-world/issue/IXO-4194)
3. **Context hygiene as constitutional policy.** Which memory a hired model may see is an accident of checkpointer replay, not something `domain.md`'s privacy block governs — an entity declaring `private_by_default` shows every hired model its entire conversational past. → [IXO-4196](https://linear.app/ixo-world/issue/IXO-4196)

### 30e. Where Phase 1 exceeded the letter of the vision

A gap review should also record what turned out stronger than specified, because those choices should survive later phases:

- **"Models generate claims, not authority" is load-bearing in five places**, not aspirational in one: effect declarations the model cannot touch, `facts` resolvers denied the call's arguments, the deeply frozen constitution, the credential-less model, and the rule that the entity cannot approve its own escalation.
- **Failing to record is a refusal.** The vision asks for decisions to be committed to the ledger; Phase 1 additionally refuses effectful action while the ledger is unavailable, on the ground that an entity acting without an account of why is acting unaccountably.
- **The entity-neutral correction.** Mid-phase, the runtime's oracle-shaped narrowing was removed — the harness governs any agentic entity, the entity is the agent of its own functions, and the DV-114 asset example is the paradigm sentence made executable: an asset that claims its own faults, cannot determine them, and cannot pay for repairs on its own say-so.
- **Approvals bind to requests, not to tools or sessions.** A human release covers the action, on the object, for the value — an approval for 100 uusdc to one vendor covers neither 100000 nor another vendor, and re-approval is not demanded per session (which would train reviewers to approve without reading).

### 30f. Reading

**Phase 1 built the constitution and the courtroom; the entity does not yet own the building.** Custody of keys, law, memory, and inference remains with the operator. That is precisely the remit of Phases 2–5 — anchoring (2), per-permit capabilities and receipts (3), cognition contracts and the capsule (4), self-claims and settlement (5, 5b) — plus the three tracked gaps above, and the standing custody items [IXO-4173](https://linear.app/ixo-world/issue/IXO-4173) (legacy secret re-wrap) and [IXO-4174](https://linear.app/ixo-world/issue/IXO-4174) (the local-only dependency override). None of the remaining distance requires revisiting Phase 1's decisions; it requires moving the root of trust — the route for which is `specs/sovereign-key-custody.md` §10 (the custody ladder, and the Matrix exception: threshold what signs, attenuate what transports, sign inside what matters).

---

## 31. References

**Named starting points**

- LangChain Deep Agents — product page, "Deep Agents" blog post, deepagents 0.2 release notes, docs (overview/subagents/backends/middleware/long-term memory/human-in-the-loop), and repo source (`graph.py`, middleware, `libs/ARCHITECTURE.md`). https://www.langchain.com/deep-agents · https://github.com/langchain-ai/deepagents
- qm — "a multiplayer agent harness for work"; full source studied: `src/harness/` (adapter contract, tape-fold, replay), `src/core/orchestrator.ts`, `src/credentials/keychain.ts`, `src/policy/`, `src/security/`, `src/cron/`, `src/memory/`, `AGENTS.md`, `SECURITY.md`. https://github.com/yc-software/qm

**The constitution artifact (Part V)**

- `domain.md` — spec `1.0.0-rc.3`: generated specification (`docs/spec.md`), `domain-md.schema.json`, rule registry, `PHILOSOPHY.md`, examples (protocol/service/project/passive-dataset domains), and the experimental `x-oracle-capsule` contract (`docs/experimental/x-oracle-capsule/` — architecture decision, manifest contract, threat model; capsule + source-lock schemas, RFC 8785 vectors). Library surface audited: `packages/cli/src/index.ts` (`parseDomain`, `lint`, `diffDomains`, capsule validation — no `authorize()` yet). https://github.com/ixoworld/domain.md

**Harness ecosystem**

- Anthropic engineering: _Claude Code best practices_; _Building agents with the Claude Agent SDK_; _Effective context engineering for AI agents_; _Building effective agents_; _How we built our multi-agent research system_. Claude Code docs (memory, best practices).
- OpenAI Agents SDK docs (running agents, models). LangGraph docs (persistence, durable execution).
- Letta/MemGPT: docs (MemGPT concepts, memory blocks), _Sleep-time compute_ and _Agent memory_ blog posts, MemGPT paper (arXiv:2310.08560), Agent File (`.af`).
- OpenHands: architecture docs and paper (arXiv:2407.16741). Hugging Face smolagents docs. Model Context Protocol spec 2025-06-18 (architecture, security principles).

**Sovereign primitives**

- UCAN v1 spec (delegation, invocation, revocation, receipts) — github.com/ucan-wg/spec; this repo's `packages/ucan` (capability shape, `derives`) and `oracle-runtime/src/modules/{ucan,auth}`.
- Object-capability model: no ambient authority, POLA, attenuation, revocable membranes (Miller, _Robust Composition_; ocap lineage KeyKOS→E→Cap'n Proto).
- W3C DID Core & Verifiable Credentials; IXO Impact Hub modules: `x/iid` (IIDs, verification relationships, linked resources), `x/entity` (entity NFTs, `MsgCreateEntityAccount`, `MsgGrantEntityAccountAuthz`, `MsgTransferEntity`), `x/claims` (collections, intents, submission, evaluation, disputes, adjudication, escrowed per-stage payments) — github.com/ixofoundation/ixo-blockchain; this repo's `packages/oracles-chain-client` claims client.
- ERC-8004 _Trustless Agents_ (identity/reputation/validation registries). x402 payment protocol — under Linux Foundation governance (x402 Foundation, operational July 2026), not Coinbase-controlled; see `specs/sovereign-key-custody.md` §9. Google AP2 — v0.2 uses open/closed checkout mandates as SD-JWT verifiable digital credentials; the widely-cited intent/cart/payment-as-W3C-VC model is v0.1.
- Agent-economy precedents: Olas/Autonolas, Fetch.ai uAgents/Almanac, Virtuals Protocol — studied for the custody question (operator/platform-owned in all three).
- Policy-as-code: OPA/Rego; AWS Cedar (default deny, forbid-overrides-permit, Lean-verified semantics; Bedrock AgentCore precedent as an agent tool-call gate). Anthropic Constitutional AI as the behavioral contrast.
- Tamper-evident logs: RFC 6962 Certificate Transparency (Merkle inclusion/consistency proofs), Trillian, Sigstore Rekor; C2PA Content Credentials; NVIDIA confidential computing for attested inference.
