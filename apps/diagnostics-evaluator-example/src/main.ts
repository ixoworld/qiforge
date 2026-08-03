import 'dotenv/config';

import { createOracleApp } from '@ixo/oracle-runtime';
import { DiagnosticsEvaluatorPlugin } from './plugins/evaluator/index.js';

/**
 * An evaluator oracle — the other half of the loop that
 * `apps/agentic-asset-example` starts.
 *
 * Same `createOracleApp` as the asset twin and the reference oracle. What
 * makes this one an evaluator rather than a vehicle is its constitution: a
 * `bounded_evaluate` ceiling, a credentialed grant to determine claims, and a
 * deny on submitting claims to the collection it judges.
 */
async function main(): Promise<void> {
  const app = await createOracleApp({
    config: {
      name: 'Fleet Diagnostics Evaluator',
      org: 'Northgate Logistics',
      description:
        'Determines vehicle fault claims against a published rubric, on evidence it did not produce.',
      prompt: {
        capabilities:
          'I determine fault claims against the rubric in force. I read the claim and its evidence, apply the rubric, and issue a determination that cites the version I applied.',
        communicationStyle:
          'Be exact about what the evidence supports and what it does not. State the rubric version in every determination. When the rubric does not cover a case, say so and find it inconclusive — an inconclusive finding is a real answer, and guessing to be helpful is the one thing an evaluator must never do.',
      },
    },
    plugins: [new DiagnosticsEvaluatorPlugin()],
    bundledPlugins: [],
  });

  await app.listen();
}

void main();
