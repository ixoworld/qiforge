# Agent Evaluations — Research and Proposal

**Status:** Exploratory / pre-decision
**Author:** Yousef
**Last updated:** 2026-05-11
**Related:** `specs/ORA-219-plugin-based-runtime.md`, `packages/oracle-runtime/src/testing/`
**Audience:** Senior engineer making a build/buy/host decision

---

## 1. Problem and goals

QiForge is moving from a single NestJS app to a plugin-based runtime where each oracle is assembled from a set of bundled plugins (memory, slack, tasks, composio, firecrawl, editor, agui, portal, skills, calls, credits, claim-processing, sandbox, langfuse, userPreferences, domainIndexer) plus user-authored plugins. As soon as that landed, the behaviour of any deployed oracle became a function of **which plugins are loaded × which model is in `llm.get('main')` × the version of each plugin's prompt and tools**. The existing test layer (`createTestRuntime` + `fakeModel`) verifies that handlers run and middlewares fire — it does not tell us whether the agent **chooses the right tool**, **routes between plugins correctly**, or **responds usefully** to a real user.

We need an evaluations layer that catches regressions across that matrix. Specifically: when a plugin author edits a manifest or a tool schema, when a fork enables a new plugin, when the LLM provider rolls a model, when the safety middleware is retuned — we want a CI signal that says "routing accuracy dropped from 92% to 78%" or "the `editor` plugin's `apply_changes` tool is now being called with malformed args 30% of the time" before that ships. The pipeline must run in TypeScript (the codebase is TS-only and pnpm-workspaced), produce diffable artifacts, and be cheap enough that we run a per-plugin subset on every PR without burning the LLM budget.

## 2. What to evaluate

- **Tool-call correctness** — given a user message, did the agent emit a tool call with the right name and well-formed args (Zod-valid against the plugin's `schema`).
- **Plugin routing accuracy** — does `find_capability` return the right plugin for a query, and does the agent then `load_capability` and use it (vs. ignoring it or loading the wrong one).
- **Response quality (LLM-judged)** — helpfulness, factual accuracy against a reference answer, format compliance (e.g. did the agent return the JSON shape the front-end expects).
- **Latency P50 / P95 per plugin** — wall-clock from invoke to first token and to final message, broken down by which plugins were touched in the trace.
- **Token usage and cost per turn** — input + output tokens × model price, attributed to the plugin(s) that fired tool calls in the trace.
- **Safety guardrail effectiveness** — does `safety-guardrail-middleware` block a curated set of red-team prompts, and does it not block borderline-but-OK prompts (false-positive rate).
- **Regression detection across plugin updates** — diff scores between two commits on the same eval suite; flag any metric that moved by more than a configured threshold.
- **Multi-turn conversation coherence** — over a scripted 3–5 turn dialogue, does the agent maintain user-context, not re-ask answered questions, and not re-load the same `load_capability` repeatedly.

## 3. Framework options

All six options below were checked against current docs (May 2026). Verdict at the end.

### 3.1 Comparison table

| Framework | TS support | Hosting | Cost (entry) | Datasets | LLM-judge | Regression diff | CI story | Where results live |
|---|---|---|---|---|---|---|---|---|
| **LangSmith** | Native TS SDK; `langsmith/vitest` entrypoint | Hosted (BYOC + self-host on Enterprise) | Free dev (5k traces / 14d) → Plus $39/seat/mo + $2.50 / 1k traces over 10k | First-class, curate from prod traces or upload | Yes, templates + custom evaluators in TS | Yes, experiment-vs-experiment view in UI | Vitest integration + GitHub workflow examples in cookbook | LangSmith UI / dashboard, exportable |
| **promptfoo** | TS CLI + library; custom TS providers | Self-host / local; optional sharing service | OSS (Apache-2.0) — free | YAML test files; CSV / Google Sheets import | Yes, model-graded assertions | Yes, `promptfoo eval --share`; HTML / JSON output | First-class CI: `promptfoo eval` returns non-zero on failure, GH Action available | Local filesystem + optional shared report URL |
| **Braintrust** | Native TS SDK (`braintrust`) + OpenAI proxy | Hosted (self-host on Enterprise) | Free tier (1M spans, 10k eval scores) → Pro $249/mo, tracing $3/GB | Dataset-first product; versioned | Yes, library of scorers + custom in TS | Yes, statistical significance markers | TS SDK is the eval runner — wrap in vitest or call from CI script | Braintrust UI |
| **DeepEval** | Python-first; `deepeval-ts` exists but thin / calls Python subprocess | Hosted (Confident AI) or local | OSS core, Confident AI is paid | Yes (Python-native, awkward from TS) | Yes, rich metric library | Yes, in Confident AI UI | Pytest-shaped; Node integration is sub-process — friction | Confident AI UI |
| **Custom on vitest + `fakeModel`** | Native — already what we use | N/A (lives in repo) | $0 deterministic, real-model runs cost what they cost | Plain TS arrays / JSON in plugin source | Only if we wire one (one prompt call) | DIY (snapshot scores to a JSON file, diff in CI) | First-class, already runs in `pnpm test` | Vitest reporter / repo artifacts |
| **Langfuse evaluations** | TS SDK (`langfuse`) | Self-host (MIT, no usage caps) or hosted | Self-host: free. Hosted: free dev → paid Pro | Yes, datasets + experiments | Yes, managed LLM-as-judge with templates + custom; observation-level evals as of Feb 2026 | Yes, experiment runs are diff-able in UI | SDK-driven; trigger via vitest or scheduled cron in CI | Langfuse UI (own instance) |

### 3.2 Notes on each option

**LangSmith** is the closest fit to the stack on paper (LangChain is already a hard dep, `langsmith` is a transitive dep, the `langsmith/vitest` entrypoint lines up with how the existing `wrap-plugin-tool.test.ts` is structured). The main objection is cost shape: Plus is per-seat plus per-trace overage. If we run a full plugin suite nightly across ~16 plugins × ~20 cases each, we cross the 10k trace inclusion in a week. The free Developer tier is fine for prototyping but not enough for a real CI matrix. Self-host is Enterprise-only.

**promptfoo** is the cheapest credible option and the easiest to put in CI today. The model is "YAML test file → run providers → assert on outputs". It supports custom TS providers, so we can write a single provider that boots a `createTestRuntime`-shaped harness and exposes `invoke(messages)` to the eval runner. Tool-call assertions are explicit (`response.metadata.toolCalls`). The downside is dataset management — YAML in git works for the first 100 cases but stops scaling around 1k where you want versioned datasets, tagged sub-suites, and side-by-side diffs against a hosted view.

**Braintrust** is the slickest dataset-first product and has the best statistical-significance treatment (it tells you when a score delta is below noise). The $249/mo entry price is a deal-breaker for a single oracle in early development; if we end up running evals for 10+ forks it's reasonable.

**DeepEval** is the leader for metric variety (G-Eval, faithfulness, contextual precision, etc.) but Python-first. `deepeval-ts` is a thin client of the SaaS API rather than a port of the framework. We'd be running Python in CI via subprocess and version-locking two ecosystems. Hard pass given the repo is TS-only.

**Custom on vitest + `fakeModel`** is what TASK-15 already lays the groundwork for. It's the only option where the eval suite *runs without any external service* and produces zero cost in CI. The ceiling is low: no LLM-judge unless we hand-roll one, no hosted dashboard, no statistical-significance machinery. Best for the foundational layer.

**Langfuse evaluations** is the option that *fits the existing plan* — Langfuse is already a planned plugin (TASK-16) for tracing. Self-hosted Langfuse is MIT-licensed with no event caps and runs in Docker. Datasets + experiments + LLM-as-judge are all in the OSS, including the Feb 2026 observation-level eval feature (we can score individual tool calls inside a trace without re-running the whole agent). The cost story is "the hardware running the Docker stack and the LLM calls of the judge model" — nothing else.

### 3.3 Recommendation

**Hybrid: vitest + `fakeModel` for the deterministic layer + self-hosted Langfuse for the LLM-judged layer.**

Reasoning:

1. We already have the building blocks for the deterministic layer. `createTestRuntime` + `fakeModel.respondWithTools(...)` lets us assert "given input X, the agent emitted tool call Y with args Z" in pure TS, in `pnpm test`, with zero LLM cost. This is where the bulk of CI signal will come from — tool-call correctness, routing accuracy, manifest-cross-check, safety-middleware behaviour against fixed prompts. Should run on every PR.
2. Langfuse is already a planned plugin and is OSS / MIT / self-host with no caps. Pushing the judged-quality + cost + latency layer through the same tracing backend we'll already be running is cheap and avoids vendor sprawl. The new observation-level evals let us score `editor.apply_changes` independently from the overall response — important for plugin-level scoring.
3. LangSmith and Braintrust are both better products in isolation than self-hosted Langfuse. But adopting them means a new vendor invoice and a second set of credentials in CI. Re-evaluate in 6 months if Langfuse's eval UX is a bottleneck.
4. promptfoo stays in the back pocket for **red-team / safety** runs. Its red-teaming feature set is more mature than Langfuse's and the CLI is genuinely good for one-off "what does this prompt do across N models" experiments.

What we explicitly do *not* recommend: building both layers from scratch on vitest, or paying for LangSmith / Braintrust before we have evidence the OSS layer is the bottleneck.

## 4. Dataset strategy

Three sources, layered:

1. **Golden conversations (handwritten).** A small, version-controlled set per plugin. Each case is a JSON file: `{ messages, expectedToolCalls?, expectedResponseShape?, judgeCriteria? }`. Lives next to the plugin source (`packages/plugin-<name>/evals/golden/*.json`). This is the primary source for CI — it's deterministic enough to assert on tool calls, and the dataset is reviewable in PRs.
2. **Synthetic edge cases (LLM-generated).** A generator that takes a plugin manifest (`whenToUse`, `examples`, `whenNotToUse`) and produces variants: paraphrases, near-misses (looks like it should route here but shouldn't), adversarial inputs. Stored separately (`evals/synthetic/<plugin>.json`) and regenerated on a schedule. Synthetic cases are graded by LLM-judge, never by exact match, because the answers aren't authoritative.
3. **Real-traffic replay from Matrix history.** Pull a sample of real threads from Matrix, redact PII via a deterministic transform, and replay the user-side messages against a current build. This is the strongest signal — actual user behaviour — but has the highest setup cost (PII scrubber, opt-in flag per user, redaction review). Defer to phase 3.

**Phased approach:**

- Phase 1 — golden only, per plugin, ~10 cases each. Hand-authored when a plugin lands.
- Phase 2 — synthetic added on top, ~50 cases per plugin, regenerated weekly.
- Phase 3 — real-traffic replay for the top 3 plugins by usage.

A concrete shape for a golden case (drop-in for a hypothetical `climate` plugin):

```json
{
  "id": "climate-emissions-001",
  "description": "Direct emissions query — should call get_emissions with parsed args",
  "messages": [
    { "role": "user", "content": "What were plant-42 emissions in Q1 2026?" }
  ],
  "expectedToolCalls": [
    {
      "name": "get_emissions",
      "args": { "facilityId": "plant-42", "period": "Q1-2026" }
    }
  ],
  "expectedResponseShape": "narrative-with-number",
  "tags": ["routing", "argument-parsing"]
}
```

## 5. Plugin-runtime fit

This is the section that matters most for the runtime architecture decision.

**The trade-off.** Per-plugin evals live next to the code, the plugin author owns them, scope is obvious — but cross-plugin routing scenarios (does the user query "summarise this PDF and email it to ops" correctly involve `firecrawl` + `slack`?) have no home. A central suite catches those — but ownership is fuzzy and new plugins don't automatically contribute their own cases.

**Recommendation: hybrid.**

- **Per-plugin evals** for that plugin's own tools and sub-agents. Lives in the plugin package, runs whenever that plugin is touched. The plugin author owns them.
- **Central evals** for routing (`find_capability` / `load_capability` accuracy across the full bundled set), multi-plugin scenarios, safety middleware, and core agent behaviour. Lives in `packages/oracle-runtime/evals/`. Owned by whoever owns the runtime package.

**Where files live:**

```
packages/
  oracle-runtime/
    evals/
      routing/          # find_capability / load_capability scenarios
      multi-plugin/     # "summarise + email + log to memory"
      safety/           # red-team prompts vs guardrail
      core/             # base agent behaviour without plugins
  plugin-memory/
    src/
    evals/
      golden/
        recall-001.json
        recall-002.json
      synthetic/
  plugin-slack/
    src/
    evals/
      golden/
      ...
```

**Plugin-side wiring.** The plugin manifest gains an optional `evals` accessor pointing at the directory. This is a runtime convention, not a public type field — the eval runner discovers `evals/` by directory contract, not by reading the plugin object. That keeps the plugin API (the seven fields in §4 of the master spec) untouched.

**Central suite responsibilities.**

- Pull every loaded plugin's golden cases and run them under one harness so we get a single pass/fail per PR.
- Add routing cases that exercise `find_capability` against the full plugin set (only meaningful when many plugins are loaded).
- Add multi-plugin scenarios where the expected outcome involves a sequence of tool calls across plugins.

**Why this split works.** Plugin authors can verify their plugin in isolation in their own PR. The runtime maintainer doesn't have to chase plugin authors to write cross-plugin tests. New plugins land their per-plugin suite as part of the same PR that adds the plugin. The central suite grows when routing or multi-plugin behaviour changes.

## 6. CI integration

### When to run

| Trigger | What runs | Cost target | Time budget |
|---|---|---|---|
| Per-PR | Deterministic vitest evals for plugins touched in the diff + the central routing/safety suite | $0 (fakeModel) + ~$0.20 (one real-model smoke on changed plugin) | < 3 min |
| Nightly | Full deterministic suite + LLM-judged response quality on all plugins | ~$5–15 (judge calls) | < 20 min |
| Pre-release | Full suite + synthetic dataset regeneration + real-traffic replay (phase 3) | ~$20–60 | < 60 min |

"Touched in the diff" means changed files under `packages/plugin-<name>/` or `packages/oracle-runtime/src/{graph,plugin-api,manifest}/`. The PR-time signal is what catches regressions before merge — the rest is monitoring.

### Failure thresholds

Deterministic assertions (tool-call name, args validity, manifest cross-check) — exact match, hard fail.

Non-deterministic judged scores — LLM-judge outputs aren't stable to four decimals. The pattern that works:

1. Score is normalised to [0, 1].
2. The eval suite stores a rolling baseline (median of the last 5 runs) per case, committed to a `evals/baseline.json` artifact.
3. CI fails if the **per-case score drops below `baseline - 0.10`** OR if the **suite-aggregate score drops below `baseline - 0.05`**. Tunable per plugin via a `tolerances.json`.
4. Re-run a failing judged case twice automatically. If two of three agree, it's a real failure. If they disagree, it's noise — log a warning, don't fail the build.

This is the same pattern that flakey-test detectors use; it's not novel, just needs to be in the runner from day one or noise eats the signal.

### Cost budget per run

Rough sketch with current numbers (GPT-4.1-mini class judge, mid-range main model):

| Run type | Cases | Cost per case (judge + agent) | Total |
|---|---|---|---|
| PR (touched plugin) | ~20 | $0.01 | $0.20 |
| Nightly | ~400 | $0.02–0.04 | $8–16 |
| Pre-release | ~1200 | $0.03–0.05 | $36–60 |

Numbers move with model choice. Worth instrumenting `ctx.llm.get()` to tag every call with `{ run: 'eval', case: 'climate-001' }` so the cost shows up in Langfuse and we can see the real number.

### Where results live

- Deterministic vitest results: standard vitest reporter, plus a JSON summary under `.evals/<run-id>/` uploaded as a GitHub Actions artifact.
- LLM-judged results: pushed to Langfuse via the existing tracing plugin, scored as a Langfuse "experiment run". Diff views live in the Langfuse UI on our self-hosted instance.
- PR comment bot: a small CI step that reads the JSON summary and posts a comment with a delta table (`tool-call accuracy: 94% → 92% (-2%)`, etc.).

## 7. Phased rollout

Three phases. Each has an explicit definition of done.

### Phase 1 — Foundation (deterministic per-plugin evals)

**What.** Extend `createTestRuntime` with an eval-suite runner. Each plugin gets an `evals/golden/*.json` directory of cases. The runner loads the cases, invokes the agent (via real `createAgent` + `fakeModel` scripted to emit the expected tool calls) and asserts on tool-call name + args validity. No LLM-judge yet — assertions are deterministic.

**When.** Wait for TASK-11 (`createOracleApp`) and the first three plugin conversions (suggest: memory, slack, tasks — they have the simplest tool surfaces) to land. Earlier and we're testing scaffolding that's still moving.

**Definition of done.**

- `pnpm test --filter @ixo/plugin-<name>` runs that plugin's eval suite.
- `pnpm test --filter @ixo/oracle-runtime` runs the central routing + safety suite.
- A `evals/` directory in three plugins with at least 10 golden cases each.
- CI fails when a plugin's tool-call accuracy drops on the golden set.
- Output is a JSON summary at a known path, plus standard vitest console output.

**What it does NOT do.** No LLM-judge, no synthetic data, no hosted dashboard, no cost tracking. Just deterministic regressions.

### Phase 2 — LLM-judged response quality

**What.** Add a `judge.ts` utility under `packages/oracle-runtime/src/testing/eval/`. Each case can include `judgeCriteria` (free-form rubric). The runner calls the judge model with `{ rubric, userMessage, agentResponse }` and parses a `{ score: 0..1, reasoning: string }` response. Results stream to Langfuse via the tracing plugin so they show up in the experiment-run view. Per-PR runs only judge cases for *changed plugins*. Nightly judges everything.

**When.** After Phase 1 is in CI for two weeks and we're confident the deterministic layer is stable.

**Definition of done.**

- A `judge` helper in the testing harness; pick a default judge model behind a config flag.
- 5+ plugins have judged criteria on at least 20% of their cases.
- Langfuse experiment-run view shows score deltas between consecutive runs.
- Tolerances are configurable per plugin (`evals/tolerances.json`).
- Re-run-on-disagree is implemented (2 of 3 agreement, otherwise warn).

### Phase 3 — Full suite

**What.**

- **Routing evals.** Curated cases that force the agent to route through `find_capability` / `load_capability`. Score = did it find the right plugin in the top-3 results, and did it actually load it.
- **Multi-turn evals.** Scripted 3–5 turn dialogues with assertions per turn and an end-of-conversation judged-coherence score.
- **Regression diff dashboard.** A web view (or just a static HTML report uploaded as a CI artifact) showing score deltas across the last 30 runs.
- **Cost tracking.** Langfuse already does this for traces; wire the eval-run tagging so cost-per-eval-run is a first-class metric.
- **Real-traffic replay.** PII-scrubbed sample of Matrix threads, opt-in via a per-user flag (default: out). Replays as a nightly job.

**When.** After Phase 2 is in CI for ~4 weeks, and ideally after the plugin set has stabilised post-ORA-219.

**Definition of done.**

- Routing accuracy is tracked as a top-line metric, separate from per-plugin tool-call accuracy.
- A nightly job replays >100 real (scrubbed) threads.
- Cost-per-PR-eval-run is plotted in Langfuse.
- The score-delta report is linkable from PRs.

## 8. Open questions

These need a call before this moves out of "exploratory":

1. **Framework choice.** Confirm Langfuse-self-host + vitest is the path, or pick LangSmith for the hosted convenience (and accept the recurring cost). The technical-fit argument leans Langfuse; the bandwidth-to-operate argument leans LangSmith. Which do we have less of?
2. **Cost budget.** What's the monthly LLM spend ceiling on evals before someone gets nervous? The $8–16/night nightly estimate compounds to ~$300/mo; the pre-release runs add maybe $100/mo on top. Is that fine, or do we need to cap?
3. **Who owns the central suite.** Per-plugin ownership is clear (the plugin author). Central routing + multi-plugin + safety — runtime maintainer? Dedicated eval engineer? Distributed across plugin authors?
4. **Hosted vs self-hosted Langfuse.** Self-host means we run another Docker stack and back it up. Langfuse Cloud means a vendor invoice (small, but still). Where do eval results need to be visible — internal only, or also to fork operators?
5. **Real-traffic replay opt-in mechanism.** Phase 3 needs a UX for users to consent to having their (PII-scrubbed) threads replayed. Where does that live — Portal setting? Default-on for paid tiers? Default-off everywhere?
6. **Judge model choice.** Cheaper judge (GPT-4.1-mini, Claude Haiku 4.7) is faster and cheaper but less reliable; stronger judge (Claude Opus 4.7, GPT-5-class) is the reverse. We probably want different judges for different metric types — safety/red-team needs the strong one, format/structure can use the cheap one. Worth deciding before Phase 2 writes the helper.

---

## Appendix — minimal sketch of the Phase 1 runner

This is not a final design — just shows the shape so the proposal is concrete. Lives in `packages/oracle-runtime/src/testing/eval/`.

```ts
// run-eval-suite.ts (sketch)
import { createTestRuntime } from '../create-test-runtime.js';
import { readGoldenCases } from './golden.js';

export interface EvalCaseResult {
  caseId: string;
  pass: boolean;
  reason?: string;
  observedToolCalls: Array<{ name: string; args: unknown }>;
}

export async function runEvalSuite(opts: {
  plugins: OraclePlugin[];
  goldenDir: string;
  /** When the agent is expected to emit tool calls, script them on fakeModel. */
  toolCallStrategy?: 'scripted' | 'real-model';
}): Promise<EvalCaseResult[]> {
  const rt = await createTestRuntime({ plugins: opts.plugins });
  const cases = await readGoldenCases(opts.goldenDir);
  const results: EvalCaseResult[] = [];

  for (const c of cases) {
    // For 'scripted', wire fakeModel.respondWithTools(c.expectedToolCalls)
    // For 'real-model', use a real model from ctx.llm and observe.
    const observed = await invokeAgentAndCapture(rt, c);
    const pass = matchesExpected(observed, c.expectedToolCalls);
    results.push({
      caseId: c.id,
      pass,
      reason: pass ? undefined : describeDelta(observed, c.expectedToolCalls),
      observedToolCalls: observed,
    });
  }
  return results;
}
```

A vitest test file in a plugin package consumes it like this:

```ts
// packages/plugin-climate/src/evals.test.ts (sketch)
import { runEvalSuite } from '@ixo/oracle-runtime/testing/eval';
import { ClimatePlugin } from './index.js';

describe('climate eval suite', () => {
  it('passes all golden cases', async () => {
    const results = await runEvalSuite({
      plugins: [new ClimatePlugin()],
      goldenDir: `${__dirname}/../evals/golden`,
      toolCallStrategy: 'scripted',
    });
    const failed = results.filter((r) => !r.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });
});
```

That's the whole foundation. Everything in Phase 2 and 3 layers on top — the judged version adds a `judge()` step after `invokeAgentAndCapture`, the regression-diff layer reads `results` and compares against a baseline file, the routing suite swaps the per-plugin invocation for a multi-plugin one.

---

## Sources

- [LangSmith Evaluations product page](https://www.langchain.com/langsmith/evaluation)
- [LangSmith pricing](https://www.langchain.com/pricing)
- [LangSmith Vitest/Jest how-to](https://docs.langchain.com/langsmith/vitest-jest)
- [promptfoo on GitHub](https://github.com/promptfoo/promptfoo)
- [promptfoo — evaluate LangGraph](https://www.promptfoo.dev/docs/guides/evaluate-langgraph/)
- [promptfoo — Javascript provider](https://www.promptfoo.dev/docs/providers/custom-api/)
- [Braintrust JS SDK](https://github.com/braintrustdata/braintrust-sdk)
- [Braintrust pricing](https://www.braintrust.dev/pricing)
- [DeepEval](https://github.com/confident-ai/deepeval)
- [`deepeval-ts` on npm](https://www.npmjs.com/package/deepeval-ts)
- [Langfuse evaluation overview](https://langfuse.com/docs/evaluation/overview)
- [Langfuse LLM-as-a-judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge)
- [Langfuse observation-level evals (Feb 2026)](https://langfuse.com/changelog/2026-02-13-observation-level-evals)
- [Langfuse self-hosting](https://langfuse.com/self-hosting)
- [Langfuse on GitHub (MIT)](https://github.com/langfuse/langfuse)
