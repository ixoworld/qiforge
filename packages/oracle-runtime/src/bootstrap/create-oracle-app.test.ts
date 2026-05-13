import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockNestApp = {
  listen: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  get: vi.fn(),
  init: vi.fn(),
  enableShutdownHooks: vi.fn(),
};

vi.mock('@nestjs/core', () => ({
  NestFactory: {
    create: vi.fn(async () => mockNestApp),
  },
}));

vi.mock('./runtime-app-module.js', () => ({
  RuntimeAppModule: {
    register: vi.fn((opts: unknown) => ({
      module: class TestModule {},
      imports: [],
      providers: [],
      __opts: opts,
    })),
  },
}));

vi.mock('@ixo/oracles-chain-client', () => ({
  setupClaimSigningMnemonics: vi.fn().mockResolvedValue(null),
  loadEncryptionKey: vi.fn().mockResolvedValue(null),
  // Other named exports used elsewhere in the runtime; if a test imports
  // them transitively, provide harmless stubs.
  getMatrixHomeServerCroppedForDid: vi.fn().mockResolvedValue('test-server'),
}));

vi.mock('@ixo/matrix', () => {
  const initMock = vi.fn(async () => undefined);
  const shutdownMock = vi.fn(async () => undefined);
  const instance = { init: initMock, shutdown: shutdownMock };
  return {
    MatrixManager: {
      getInstance: vi.fn(() => instance),
    },
  };
});

import { NestFactory } from '@nestjs/core';
import { MatrixManager } from '@ixo/matrix';
import { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../plugin-api/types.js';
import { RuntimeAppModule } from './runtime-app-module.js';
import { createOracleApp } from './create-oracle-app.js';

class TestPlugin extends OraclePlugin {
  readonly name = 'test-plugin';
  readonly version = '1.0.0';
  readonly manifest: PluginManifest = {
    title: 'Test',
    summary: 'Test plugin for createOracleApp.',
    whenToUse: ['always for testing'],
    visibility: 'always',
  };
  override readonly configSchema = z.object({
    TEST_API_KEY: z.string(),
  });
}

const baseIdentity = {
  name: 'TestOracle',
  org: 'Acme',
  description: 'createOracleApp tests',
  entityDid: 'did:ixo:test',
};

// Minimum env values that satisfy `baseEnvSchema`. Tests spread this so they
// only have to declare the plugin-specific keys they care about.
const validBaseEnv: NodeJS.ProcessEnv = {
  ORACLE_NAME: 'TestOracle',
  NETWORK: 'devnet',
  MATRIX_BASE_URL: 'http://localhost:8008',
  MATRIX_RECOVERY_PHRASE: 'phrase',
  MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:localhost',
  MATRIX_ORACLE_ADMIN_PASSWORD: 'pass',
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'token',
  MATRIX_ACCOUNT_ROOM_ID: '!room:localhost',
  MATRIX_VALUE_PIN: '1234',
  SQLITE_DATABASE_PATH: ':memory:',
  BLOCKSYNC_GRAPHQL_URL: 'http://localhost/graphql',
  ORACLE_DID: 'did:ixo:oracle',
  ORACLE_ENTITY_DID: 'did:ixo:oracle:test',
  SECP_MNEMONIC: 'word '.repeat(12).trim(),
  RPC_URL: 'http://localhost:26657',
};

// Shared defaults used by happy-path tests — `bundledPlugins: []` keeps the
// canonical bundled set out of these unit tests.
const defaultOpts = {
  identity: baseIdentity,
  bundledPlugins: [],
  env: validBaseEnv,
  skipMatrixInit: true,
  skipGracefulShutdown: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockNestApp.listen.mockResolvedValue(undefined);
  mockNestApp.close.mockResolvedValue(undefined);
});

describe('createOracleApp — identity validation', () => {
  it('throws when identity is missing', async () => {
    // @ts-expect-error — exercising the runtime guard against omitted identity
    await expect(createOracleApp({ plugins: [] })).rejects.toThrow(/identity/);
  });

  it('throws when identity is missing required fields', async () => {
    await expect(
      createOracleApp({
        ...defaultOpts,
        identity: {
          name: '',
          org: 'Acme',
          description: '',
          entityDid: '',
        },
        plugins: [],
      }),
    ).rejects.toThrow(/name, description, entityDid/);
  });
});

describe('createOracleApp — happy path', () => {
  it('builds the Nest app, registers plugins and returns the surface', async () => {
    const plugin = new TestPlugin();
    const app = await createOracleApp({
      ...defaultOpts,
      plugins: [plugin],
      env: { ...validBaseEnv, TEST_API_KEY: 'shh' },
    });

    expect(NestFactory.create).toHaveBeenCalledTimes(1);
    expect(RuntimeAppModule.register).toHaveBeenCalledTimes(1);
    const registerArg = vi.mocked(RuntimeAppModule.register).mock.calls[0]![0];
    expect(registerArg.validatedEnv).toMatchObject({ TEST_API_KEY: 'shh' });
    expect(registerArg.enableSubscriptionMiddleware).toBe(false);

    expect(app.getNestApp()).toBe(mockNestApp);
    expect(app.plugins.status()).toEqual({
      loaded: ['test-plugin'],
      excluded: [],
      softDepGaps: [],
    });
  });

  it('uses identity name in the listen log line and starts the HTTP server', async () => {
    const app = await createOracleApp({ ...defaultOpts, plugins: [] });

    await app.listen(4242);
    expect(mockNestApp.listen).toHaveBeenCalledWith(4242, '0.0.0.0');
  });

  it('throws when listen is called twice', async () => {
    const app = await createOracleApp({ ...defaultOpts, plugins: [] });

    await app.listen(3000);
    await expect(app.listen(3000)).rejects.toThrow(/twice/);
  });

  it('runs beforeListen hooks in order before listen', async () => {
    const app = await createOracleApp({ ...defaultOpts, plugins: [] });

    const order: string[] = [];
    app.beforeListen(() => {
      order.push('hook-1');
    });
    app.beforeListen(async () => {
      order.push('hook-2');
    });
    mockNestApp.listen.mockImplementationOnce(async () => {
      order.push('listen');
    });

    await app.listen(3000);
    expect(order).toEqual(['hook-1', 'hook-2', 'listen']);
  });

  it('falls back to env.PORT when no port is supplied', async () => {
    const app = await createOracleApp({
      ...defaultOpts,
      plugins: [],
      env: { ...validBaseEnv, PORT: '8081' },
    });

    await app.listen();
    expect(mockNestApp.listen).toHaveBeenCalledWith(8081, '0.0.0.0');
  });
});

describe('createOracleApp — env validation errors', () => {
  it('reports the owning plugin when a required env var is missing', async () => {
    const plugin = new TestPlugin();
    const errors: string[] = [];
    const logger = {
      log: () => undefined,
      warn: () => undefined,
      error: (msg: unknown) =>
        errors.push(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    };

    await expect(
      createOracleApp({
        ...defaultOpts,
        plugins: [plugin],
        logger,
      }),
    ).rejects.toThrow(/Env validation failed/);

    expect(errors.join('\n')).toMatch(/Plugin 'test-plugin'/);
    expect(errors.join('\n')).toMatch(/TEST_API_KEY/);
  });
});

describe('createOracleApp — Matrix lifecycle', () => {
  it('kicks off background Matrix init and emits a status change on success', async () => {
    const statuses: Array<{ plugin: string; to: string }> = [];
    const app = await createOracleApp({
      ...defaultOpts,
      plugins: [],
      skipMatrixInit: false,
    });
    app.onPluginStatusChange((evt) =>
      statuses.push({ plugin: evt.plugin, to: evt.to }),
    );

    expect(MatrixManager.getInstance).toHaveBeenCalled();
    // setImmediate inside the factory defers init kick-off — flush a few
    // times so both the macrotask + the inner key-setup microtask drain
    // (post-init we await `wireSigningAndEncryptionKeys` before dispatch).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(statuses.map((s) => `${s.plugin}:${s.to}`)).toEqual([
      'matrix:pending',
      'matrix:loaded',
    ]);
  });

  it('reports Matrix init failure via onError + status change', async () => {
    const initMock = vi.mocked(MatrixManager.getInstance().init);
    initMock.mockRejectedValueOnce(new Error('matrix boom'));

    const errors: Array<{ msg: string; source: string }> = [];
    const statuses: Array<{ to: string; reason?: string }> = [];

    const app = await createOracleApp({
      ...defaultOpts,
      plugins: [],
      skipMatrixInit: false,
    });
    app.onError((err, source) =>
      errors.push({ msg: err.message, source }),
    );
    app.onPluginStatusChange((evt) =>
      statuses.push({ to: evt.to, reason: evt.reason }),
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(statuses.some((s) => s.to === 'failed' && s.reason === 'matrix boom')).toBe(
      true,
    );
    expect(errors).toContainEqual({
      msg: 'matrix boom',
      source: 'matrix-init',
    });
  });
});

describe('createOracleApp — credits + subscription middleware', () => {
  it('enables subscription middleware only when the credits plugin is loaded', async () => {
    class CreditsLikePlugin extends OraclePlugin {
      readonly name = 'credits';
      readonly version = '1.0.0';
      readonly manifest: PluginManifest = {
        title: 'Credits',
        summary: 'Subscription / credits enforcement.',
        whenToUse: ['always'],
        visibility: 'silent',
      };
    }

    await createOracleApp({
      ...defaultOpts,
      plugins: [new CreditsLikePlugin()],
    });

    const registerArg = vi.mocked(RuntimeAppModule.register).mock.calls[0]![0];
    expect(registerArg.enableSubscriptionMiddleware).toBe(true);
  });
});

describe('createOracleApp — plugin-contributed NestJS modules', () => {
  it('flows getNestModules() output into RuntimeAppModule.imports', async () => {
    class FakeSlackModule {}
    class FakeTasksModule {}

    class SocketPlugin extends OraclePlugin {
      readonly name = 'socket-plugin';
      readonly version = '1.0.0';
      readonly manifest: PluginManifest = {
        title: 'Socket',
        summary: 'Plugin contributing a NestJS module.',
        whenToUse: ['always'],
        visibility: 'silent',
      };
      override getNestModules(): Array<typeof FakeSlackModule> {
        return [FakeSlackModule, FakeTasksModule];
      }
    }

    await createOracleApp({
      ...defaultOpts,
      plugins: [new SocketPlugin()],
    });

    const registerArg = vi.mocked(RuntimeAppModule.register).mock.calls[0]![0];
    expect(registerArg.pluginNestModules).toEqual([
      FakeSlackModule,
      FakeTasksModule,
    ]);
  });

  it('passes an empty array when no plugin defines getNestModules', async () => {
    await createOracleApp({ ...defaultOpts, plugins: [] });
    const registerArg = vi.mocked(RuntimeAppModule.register).mock.calls[0]![0];
    expect(registerArg.pluginNestModules).toEqual([]);
  });
});
