/**
 * Vitest setupFile for qiforge-example integration tests.
 *
 * Loads env from the app's own `.env` first (runtime config — Matrix,
 * blockchain, LLM, plugin upstream URLs), then layers `.env.integration`
 * on top with `override: true` (test-only credentials like
 * `TEST_USER_MNEMONIC` + LangSmith keys).
 *
 * Anchored on `import.meta.url` so it works from any CWD — `pnpm` invokes
 * vitest from this package's root, but turbo can invoke from the repo root.
 */
import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { expect } from 'vitest';
import { langchainMatchers } from '@langchain/core/testing';
import { Logger } from '@nestjs/common';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '../..');

dotenvConfig({ path: resolve(appRoot, '.env') });
dotenvConfig({ path: resolve(appRoot, '.env.integration'), override: true });

expect.extend(langchainMatchers);
// Silence @ixo/logger (winston) info/debug spam in integration runs. The
// logger is a singleton that reads LOG_LEVEL at construction, so this must
// land before any test module imports it. Honors a caller-provided value.
process.env.LOG_LEVEL ??= 'warn';
// Silence NestJS internal logs (route mappings, module init, etc.) — the
// harness already passes a no-op `PluginLogger` to `createOracleApp`, but
// Nest core instantiates its own `Logger` singletons that write to stdout
// independently. `error` + `warn` stay on so real failures surface.
Logger.overrideLogger(['error', 'warn']);
