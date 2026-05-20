/**
 * Vitest setupFile for integration tests.
 *
 * Loads env from the package-local `.env.integration` only. Deliberately
 * does NOT reach into a sibling package's `.env` — that coupling would
 * break for any consumer who forks @ixo/oracle-runtime to build their
 * own oracle without an `apps/qiforge-example/` directory next door.
 *
 * Consumers writing tests against @ixo/oracle-runtime/testing/integration
 * configure their own vitest setupFile in their own package; this file
 * is the runtime package's own setup.
 *
 * Setup is intentionally minimal: dotenv + langchainMatchers. Spec §6
 * bans `env-loader`, `requires()`, `runScenario`, custom matchers
 * modules, and failure-diagnostics modules — use vitest as-is.
 */
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { expect } from 'vitest';
import { langchainMatchers } from '@langchain/core/testing';

// Resolve package root relative to this setup file. This file lives at
// `src/testing/integration/setup.ts`; package root is three directories up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '../../..');

// Single env file owned by the package. Self-contained — no cross-package
// reads. Missing file is silently tolerated (CI provides env via secrets).
dotenvConfig({ path: resolve(packageRoot, '.env.integration') });

// Silence @ixo/logger (winston) info/debug spam in integration runs. The
// logger is a singleton that reads LOG_LEVEL at construction, so this must
// land before any test module imports it. Honors a caller-provided value.
process.env.LOG_LEVEL ??= 'warn';

expect.extend(langchainMatchers);
