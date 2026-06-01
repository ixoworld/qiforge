/**
 * Reference template — boot smoke test for an oracle built on the QiForge
 * runtime.
 *
 * This file is the canonical test other oracle developers copy when forking
 * the runtime. To adapt it for your own oracle:
 *
 *   1. Replace the `plugins: [...]` array below with your app's plugin list
 *      (mirror what your `src/main.ts` passes to `createOracleApp`).
 *   2. Replace `VersionModule` / `HOST_AUTH_EXCLUDED_ROUTES` with your own
 *      host-supplied Nest modules and auth-excluded routes.
 *   3. Update the `loaded` expectations to include the plugins YOUR app
 *      expects to come up.
 *   4. Run `pnpm test:integration` from this package.
 *
 * What this proves:
 *   - The oracle, configured EXACTLY as `src/main.ts` configures it (same
 *     plugin instances, same nestModules, same auth-excluded routes), boots
 *     cleanly on an ephemeral port.
 *   - `/health` returns 200 (runtime health surface is wired).
 *   - `/version` (a host-supplied controller marked auth-excluded) is
 *     reachable WITHOUT a UCAN delegation header — proves the
 *     `authExcludedRoutes` slot works end-to-end.
 *   - The expected plugins show up in `app.plugins.status().loaded`.
 *
 * No mocks, no skip-flags. Missing env fails the file loudly at load time —
 * never silently passed (spec §6, §11 #10).
 */
import { test, expect, beforeAll, afterAll } from 'vitest';
import { Controller, Get, Module, RequestMethod } from '@nestjs/common';
import * as sdk from 'matrix-js-sdk';
import {
  EditorPlugin,
  type AuthExcludedRoute,
  type OracleConfig,
} from '@ixo/oracle-runtime';
import {
  createIntegrationOracle,
  type IntegrationOracle,
} from '@ixo/oracle-runtime/testing/integration';
import { WeatherPlugin } from '../../src/plugins/weather/index.js';

const REQUIRED_ENV = [
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_USER_ID',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `boot.int.test.ts requires the following env vars (see apps/qiforge-example/.env.integration): ${missing.join(', ')}`,
  );
}

// ─── Host-supplied modules (copied from src/main.ts) ─────────────────────
@Controller('version')
class VersionController {
  @Get()
  get(): { name: string; description: string } {
    return {
      name: 'QiForge Example Oracle',
      description: 'Reference QiForge oracle wired with every bundled plugin',
    };
  }
}

@Module({ controllers: [VersionController] })
class VersionModule {}

const HOST_AUTH_EXCLUDED_ROUTES: AuthExcludedRoute[] = [
  { path: 'version', method: RequestMethod.GET },
];

// ─── Identity config (copied from src/main.ts) ───────────────────────────
const config: OracleConfig = {
  name: 'QiForge Example Oracle',
  org: 'IXO',
  description: 'Reference QiForge oracle wired with every bundled plugin',
};

// ─── Plugins this app expects loaded ─────────────────────────────────────
// `editor` + `weather` are explicitly instantiated below; the bundled set
// (memory, sandbox, skills, ...) flows in automatically when their env is
// present in `.env`.
const REQUIRED_LOADED_PLUGINS = ['editor', 'weather'] as const;

let oracle: IntegrationOracle | undefined;

beforeAll(async () => {
  const matrixClient = sdk.createClient({
    baseUrl: process.env.MATRIX_BASE_URL!,
    userId: process.env.MATRIX_ORACLE_ADMIN_USER_ID!,
    accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN!,
  });

  oracle = await createIntegrationOracle({
    config,
    plugins: [new EditorPlugin({ matrixClient }), new WeatherPlugin()],
    nestModules: [VersionModule],
    authExcludedRoutes: HOST_AUTH_EXCLUDED_ROUTES,
  });
}, 120_000);

afterAll(async () => {
  if (oracle) await oracle.close();
});

test('boot: /health returns 200', async () => {
  if (!oracle) throw new Error('oracle not booted');
  const res = await fetch(`${oracle.baseUrl}/health`);
  expect(res.status).toBe(200);
});

test('boot: /version is reachable without UCAN (host auth-excluded route)', async () => {
  if (!oracle) throw new Error('oracle not booted');
  const res = await fetch(`${oracle.baseUrl}/version`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string; description: string };
  expect(body.name).toBe('QiForge Example Oracle');
  expect(body.description).toContain('Reference QiForge oracle');
});

test('boot: app.plugins.status().loaded contains every expected plugin', () => {
  if (!oracle) throw new Error('oracle not booted');
  const status = oracle.status();
  for (const name of REQUIRED_LOADED_PLUGINS) {
    expect(status.loaded).toContain(name);
  }
});
