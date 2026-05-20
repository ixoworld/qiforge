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

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '../..');

dotenvConfig({ path: resolve(appRoot, '.env') });
dotenvConfig({ path: resolve(appRoot, '.env.integration'), override: true });

expect.extend(langchainMatchers);
