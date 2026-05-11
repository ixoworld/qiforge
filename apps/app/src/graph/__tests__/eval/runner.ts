import type {
  EvalRunConfig,
  EvalResult,
  EvalSummary,
  EvalScore,
  EvalExample,
  Evaluator,
} from './types';

// ── Core runner ──────────────────────────────────────────────────────────────

/**
 * Run an evaluation experiment.
 *
 * For each example in the dataset the runner:
 *   1. Calls `target` with the example's inputs (unique sessionId per call)
 *   2. Runs all `evaluators` on the output
 *   3. Collects scores and timing
 *
 * After all examples are processed it prints a summary to stdout and, when
 * LANGSMITH_API_KEY is set, ships the results to LangSmith so you can track
 * regressions across commits in the cloud UI.
 *
 * The returned EvalSummary is what your Vitest tests assert against:
 *
 *   const summary = await runEval({ ... });
 *   expect(summary.averageScores['notEmpty']).toBeGreaterThanOrEqual(0.9);
 *   expect(summary.passRate).toBeGreaterThanOrEqual(0.8);
 */
export async function runEval(config: EvalRunConfig): Promise<EvalSummary> {
  const {
    experimentName,
    target,
    dataset,
    evaluators,
    maxConcurrency = 1,
  } = config;

  const timestamp = new Date().toISOString();
  const results: EvalResult[] = [];

  // Process examples in concurrent batches
  for (let i = 0; i < dataset.length; i += maxConcurrency) {
    const batch = dataset.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map((example) => runOne(example, target, evaluators)),
    );
    results.push(...batchResults);
  }

  const summary = buildSummary(experimentName, timestamp, results);

  printSummary(summary);

  if (process.env.LANGSMITH_API_KEY) {
    await shipToLangSmith(summary, config).catch((err: unknown) => {
      console.warn(
        `[LangSmith] Failed to ship results: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  return summary;
}

// ── Private helpers ──────────────────────────────────────────────────────────

async function runOne(
  example: EvalExample,
  target: EvalRunConfig['target'],
  evaluators: Evaluator[],
): Promise<EvalResult> {
  // Each example gets a unique sessionId so they don't share conversation state
  const sessionId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();

  let output = '';
  let error: string | undefined;

  try {
    output = await target({ message: example.inputs.message, sessionId });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const latencyMs = Date.now() - start;

  const scores: EvalScore[] = await Promise.all(
    evaluators.map((ev) => {
      if (error) {
        return Promise.resolve<EvalScore>({
          key: ev.key,
          score: 0,
          comment: `Target threw: ${error}`,
        });
      }
      return Promise.resolve(ev.evaluate(output, example));
    }),
  );

  return {
    exampleId: example.id,
    input: example.inputs.message,
    output,
    scores,
    latencyMs,
    error,
  };
}

function buildSummary(
  experimentName: string,
  timestamp: string,
  results: EvalResult[],
): EvalSummary {
  const allKeys = [
    ...new Set(results.flatMap((r) => r.scores.map((s) => s.key))),
  ];

  const averageScores: Record<string, number> = {};
  for (const key of allKeys) {
    const vals = results.map(
      (r) => r.scores.find((s) => s.key === key)?.score ?? 0,
    );
    averageScores[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const averageLatencyMs =
    results.reduce((a, b) => a + b.latencyMs, 0) / results.length;

  const passRate =
    results.filter((r) => r.scores.every((s) => s.score >= 0.5)).length /
    results.length;

  return {
    experimentName,
    timestamp,
    totalExamples: results.length,
    results,
    averageScores,
    averageLatencyMs,
    passRate,
  };
}

// ── Console reporter ─────────────────────────────────────────────────────────

function printSummary(summary: EvalSummary): void {
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  console.log(`  Eval: ${summary.experimentName}`);
  console.log(`  Time: ${summary.timestamp}`);
  console.log(`  Examples: ${summary.totalExamples}`);
  console.log(`  Pass rate: ${(summary.passRate * 100).toFixed(1)}%`);
  console.log(`  Avg latency: ${Math.round(summary.averageLatencyMs)}ms`);
  console.log(`\n  Scores:`);

  for (const [key, score] of Object.entries(summary.averageScores)) {
    const filled = Math.round(score * 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const pct = `${(score * 100).toFixed(0)}%`.padStart(4);
    console.log(`    ${key.padEnd(44)} ${bar} ${pct}`);
  }

  const failures = summary.results.filter((r) =>
    r.scores.some((s) => s.score < 0.5),
  );

  if (failures.length > 0) {
    console.log(`\n  Failures (${failures.length}):`);
    for (const f of failures) {
      const failed = f.scores
        .filter((s) => s.score < 0.5)
        .map((s) => `${s.key}=${s.score.toFixed(2)}`)
        .join(', ');
      console.log(`    [${f.exampleId}]  ${failed}`);
      console.log(`      in:  ${f.input.slice(0, 80)}`);
      console.log(`      out: ${f.output.slice(0, 80) || f.error}`);
    }
  }

  console.log(`${line}\n`);
}

// ── LangSmith integration ────────────────────────────────────────────────────
//
// When LANGSMITH_API_KEY is set this function syncs the experiment results to
// LangSmith so you can compare runs over time in the cloud UI.
//
// How it works:
//   1. Creates a dataset (once) with the example inputs/outputs
//   2. Logs each example run as a LangSmith "run" in the project
//   3. Attaches evaluator scores as "feedback" on each run
//
// Set LANGSMITH_PROJECT to override the project name (default = experimentName).

async function shipToLangSmith(
  summary: EvalSummary,
  config: EvalRunConfig,
): Promise<void> {
  // Dynamic import keeps `langsmith` optional — it's a dev dependency and
  // missing it at runtime should never crash the eval runner.
  const { Client } = await import('langsmith');
  const client = new Client();

  const projectName =
    process.env.LANGSMITH_PROJECT ?? config.experimentName;
  const datasetName = `${config.experimentName}-dataset`;

  // Ensure the dataset exists in LangSmith (idempotent)
  let datasetId: string;
  try {
    const existing = await client.readDataset({ datasetName });
    datasetId = existing.id;
  } catch {
    const created = await client.createDataset(datasetName, {
      description: `Auto-created by agent eval runner for ${config.experimentName}`,
    });
    datasetId = created.id;

    await client.createExamples({
      inputs: config.dataset.map((ex) => ex.inputs),
      outputs: config.dataset.map((ex) => ({
        referenceOutput: ex.referenceOutput ?? '',
      })),
      datasetId,
      exampleIds: config.dataset.map((ex) => ex.id),
    });
  }

  // Log each result as a run + feedback
  for (const result of summary.results) {
    const runId = crypto.randomUUID();
    const endTime = Date.now();
    const startTime = endTime - result.latencyMs;

    await client.createRun({
      id: runId,
      name: config.experimentName,
      run_type: 'chain',
      inputs: { message: result.input },
      outputs: { output: result.output },
      start_time: startTime,
      end_time: endTime,
      project_name: projectName,
      error: result.error,
    });

    for (const score of result.scores) {
      await client.createFeedback(runId, score.key, {
        score: score.score,
        comment: score.comment,
      });
    }
  }

  console.log(
    `[LangSmith] ${summary.totalExamples} results → project "${projectName}"`,
  );
}
