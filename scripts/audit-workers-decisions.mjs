#!/usr/bin/env node
// Rerunnable release evidence. Never deploys, changes secrets, or executes payments.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv
  .find((value) => value.startsWith('--live='))
  ?.split('=')[1];
const release = process.argv.includes('--release');
const results = [];
function run(label, command, args) {
  console.log(`\n[audit] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  results.push({ check: label, passed: result.status === 0 });
  if (result.status !== 0) {
    console.log(JSON.stringify({ ready: false, results }, null, 2));
    process.exit(result.status || 1);
  }
}

if (live) {
  if (!['cloudflare-jev', 'openrouter-jev'].includes(live))
    throw new Error('Use --live=cloudflare-jev or --live=openrouter-jev.');
  const { createDecisionAdapterFromConfig } =
    await import('../packages/decisions/dist/config.js');
  const { DecisionRuntime, defineDecision } =
    await import('../packages/decisions/dist/index.js');
  const { z } = await import('../packages/decisions/node_modules/zod/index.js');
  // Fictional, fixed content. No customer evidence, private history, policy or payment.
  const decision = defineDecision({
    name: 'readiness.provider-contract',
    version: '1',
    description: 'Validate the provider transport and finite answer contract.',
    inputSchema: z.string(),
    project: (text) => ({
      state: { message: text },
      questions: {
        help: {
          kind: 'boolean',
          instructions: 'Is the customer asking for help?',
          criteria: {
            true: 'A request for assistance.',
            false: 'No request for assistance.',
          },
        },
        team: {
          kind: 'choice',
          instructions: 'Which team fits?',
          options: {
            billing: 'Invoice or charge questions',
            support: 'Other product help',
            neither: 'No relevant question',
          },
        },
        urgency: {
          kind: 'ordinal',
          instructions: 'How urgent is the request?',
          levels: [
            'Routine: no urgency stated',
            'Urgent: explicitly time critical',
          ],
        },
      },
    }),
  });
  try {
    const adapter = createDecisionAdapterFromConfig({
      ...process.env,
      DECISION_PROVIDER: live,
    });
    const result = await new DecisionRuntime(undefined, adapter).evaluate(
      decision,
      'Could you help explain the two line items on my invoice?',
      { timeoutMs: 15_000 },
    );
    console.log(
      JSON.stringify(
        {
          provider: live,
          passed: true,
          model: result.model,
          modelVersion: result.modelVersion,
          requestHash: result.requestHash,
          latencyMs: result.latencyMs,
          usage: result.usage,
          evaluatedAt: result.evaluatedAt,
          scope:
            'transport and schema only; no calibration, authority, or settlement claim',
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      JSON.stringify({
        provider: live,
        passed: false,
        reason:
          'Provider configuration or live contract probe failed. Verify credentials, access and endpoint availability.',
      }),
    );
    process.exitCode = 1;
  }
} else {
  run('workspace build and package exports', 'pnpm', ['build']);
  run('provider and failure-boundary regressions', 'pnpm', [
    '--filter',
    '@ixo/decisions',
    'test',
  ]);
  run('provider-neutral contract regressions', 'pnpm', [
    '--filter',
    '@ixo/decisions',
    'exec',
    'vitest',
    'run',
    '--root',
    '../common',
    'src/ai/decisions/decisions.test.ts',
    '--passWithNoTests=false',
  ]);
  run('Node compatibility and shadow regressions', 'pnpm', [
    '--filter',
    '@ixo/oracle-runtime',
    'exec',
    'vitest',
    'run',
    'src/decisions',
    'src/registries/decision-registry.test.ts',
    'src/modules/messages/message-router.service.test.ts',
    'src/modules/messages/matrix-listener-bridge.test.ts',
  ]);
  run('Workers typecheck', 'pnpm', [
    '--filter',
    '@ixo/oracle-runtime-workers',
    'typecheck',
  ]);
  run('Workers core regression suite', 'pnpm', [
    '--filter',
    '@ixo/oracle-runtime-workers',
    'test:core',
  ]);
  run('workerd boot and Decisions integration', 'pnpm', [
    '--filter',
    '@ixo/oracle-runtime-workers',
    'exec',
    'vitest',
    'run',
    'src/core/decisions.test.ts',
    'src/index.test.ts',
  ]);
  run('reference Worker bundle', 'pnpm', [
    '--filter',
    'qiforge-workers-example',
    'exec',
    'wrangler',
    'deploy',
    '--dry-run',
    '--outdir',
    '/tmp/qiforge-decisions-dry-run',
  ]);
  if (release) {
    run('repository lint', 'pnpm', ['lint']);
    run('repository format', 'pnpm', ['format:check']);
  }
  console.log(
    JSON.stringify(
      {
        localChecksPassed: true,
        results,
        productionReady: false,
        remaining: [
          'Run both --live provider probes with deployed-equivalent credentials.',
          'Publish the Decisions package and updated Workers runtime, then update Companion pins.',
          'Verify the deployed authenticated turn path and model calibration before any consequential use.',
          'Workers has no commerce payment router; shadow telemetry cannot authorize payment.',
        ],
      },
      null,
      2,
    ),
  );
}
