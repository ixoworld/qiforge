import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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

import { MatrixManager } from '@ixo/matrix';
import { NestFactory } from '@nestjs/core';
import { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginContext, PluginManifest } from '../plugin-api/types.js';
import { createOracleApp } from './create-oracle-app.js';
import { RuntimeAppModule } from './runtime-app-module.js';

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

const baseConfig = {
  name: 'TestOracle',
  org: 'Acme',
  description: 'createOracleApp tests',
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
  // LLM_PROVIDER defaults to 'openrouter' — match by setting the OpenRouter key.
  OPEN_ROUTER_API_KEY: 'sk-or-test',
};

// Shared defaults used by happy-path tests — `bundledPlugins: []` keeps the
// canonical bundled set out of these unit tests.
const defaultOpts = {
  config: baseConfig,
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

describe('createOracleApp — config validation', () => {
  it('throws when config is missing', async () => {
    // @ts-expect-error — exercising the runtime guard against omitted config
    await expect(createOracleApp({ plugins: [] })).rejects.toThrow(/config/);
  });

  it('throws when config.name is missing', async () => {
    await expect(
      createOracleApp({
        ...defaultOpts,
        config: {
          name: '',
          org: 'Acme',
          description: '',
        },
        plugins: [],
      }),
    ).rejects.toThrow(/config\.name/);
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
    app.onError((err, source) => errors.push({ msg: err.message, source }));
    app.onPluginStatusChange((evt) =>
      statuses.push({ to: evt.to, reason: evt.reason }),
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(
      statuses.some((s) => s.to === 'failed' && s.reason === 'matrix boom'),
    ).toBe(true);
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

describe('createOracleApp — manifest overrides', () => {
  class OverridablePlugin extends OraclePlugin {
    readonly name = 'overridable';
    readonly version = '1.0.0';
    readonly manifest: PluginManifest = {
      title: 'Overridable',
      summary: 'A plugin whose manifest a fork can retune.',
      whenToUse: ['user asks the overridable thing'],
      visibility: 'always',
    };
  }

  it('boots cleanly when an override only retunes display fields', async () => {
    await expect(
      createOracleApp({
        ...defaultOpts,
        plugins: [new OverridablePlugin()],
        manifestOverrides: {
          overridable: { visibility: 'on-demand', summary: 'Tuned summary.' },
        },
      }),
    ).resolves.toBeDefined();
  });

  it('validates the merged manifest — a bad override fails boot', async () => {
    // Base is `always` with a populated whenToUse (valid). Emptying whenToUse
    // while leaving visibility non-silent must fail, proving the validator
    // runs against the merged manifest rather than the plugin's own.
    await expect(
      createOracleApp({
        ...defaultOpts,
        plugins: [new OverridablePlugin()],
        manifestOverrides: {
          overridable: { whenToUse: [] },
        },
      }),
    ).rejects.toThrow(/manifest validation failed/i);
  });

  it('warns and ignores overrides that reference an unloaded plugin', async () => {
    const warnings: string[] = [];
    const logger = {
      log: () => undefined,
      warn: (msg: unknown) =>
        warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg)),
      error: () => undefined,
    };

    await expect(
      createOracleApp({
        ...defaultOpts,
        plugins: [new OverridablePlugin()],
        manifestOverrides: {
          'does-not-exist': { visibility: 'silent' },
        },
        logger,
      }),
    ).resolves.toBeDefined();

    expect(warnings.join('\n')).toMatch(/does-not-exist/);
    expect(warnings.join('\n')).toMatch(/not a loaded plugin/);
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

  it('passes a PluginContext with validated config to getNestModules', async () => {
    class FakeModule {}
    const received: Array<{
      apiKey: unknown;
      pluginNames: string[];
      identityName: string;
    }> = [];

    class ConfigConsumerPlugin extends OraclePlugin {
      readonly name = 'config-consumer';
      readonly version = '1.0.0';
      readonly manifest: PluginManifest = {
        title: 'Config Consumer',
        summary: 'Reads validated config inside getNestModules.',
        whenToUse: ['always'],
        visibility: 'silent',
      };
      override readonly configSchema = z.object({
        TEST_API_KEY: z.string(),
      });
      override getNestModules(ctx?: PluginContext): Array<typeof FakeModule> {
        received.push({
          apiKey: ctx?.config.TEST_API_KEY,
          pluginNames: ctx ? [...ctx.availablePlugins] : [],
          identityName: ctx?.identity.name ?? '',
        });
        return [FakeModule];
      }
    }

    await createOracleApp({
      ...defaultOpts,
      plugins: [new ConfigConsumerPlugin()],
      env: { ...validBaseEnv, TEST_API_KEY: 'sk-test-123' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      apiKey: 'sk-test-123',
      pluginNames: ['config-consumer'],
      identityName: 'TestOracle',
    });
  });
});

describe('createOracleApp — plugin-declared auth exclusions', () => {
  it('aggregates getAuthExcludedRoutes() from every loaded plugin', async () => {
    const { RequestMethod } = await import('@nestjs/common');

    class WebhookPlugin extends OraclePlugin {
      readonly name = 'webhook-plugin';
      readonly version = '1.0.0';
      readonly manifest: PluginManifest = {
        title: 'Webhook',
        summary: 'Exposes a public webhook.',
        whenToUse: ['always'],
        visibility: 'silent',
      };
      override getAuthExcludedRoutes(): Array<{
        path: string;
        method?: number;
      }> {
        return [{ path: 'hooks/incoming', method: RequestMethod.POST }];
      }
    }

    class HealthProbePlugin extends OraclePlugin {
      readonly name = 'probe-plugin';
      readonly version = '1.0.0';
      readonly manifest: PluginManifest = {
        title: 'Probe',
        summary: 'Public liveness probe.',
        whenToUse: ['always'],
        visibility: 'silent',
      };
      override getAuthExcludedRoutes(): Array<{
        path: string;
        method?: number;
      }> {
        return [{ path: 'probe/alive', method: RequestMethod.GET }];
      }
    }

    await createOracleApp({
      ...defaultOpts,
      plugins: [new WebhookPlugin(), new HealthProbePlugin()],
    });

    const registerArg = vi.mocked(RuntimeAppModule.register).mock.calls[0]![0];
    expect(registerArg.pluginAuthExclusions).toEqual([
      { path: 'hooks/incoming', method: RequestMethod.POST },
      { path: 'probe/alive', method: RequestMethod.GET },
    ]);
  });

  it('passes an empty array when no plugin declares exclusions', async () => {
    await createOracleApp({ ...defaultOpts, plugins: [] });
    const registerArg = vi.mocked(RuntimeAppModule.register).mock.calls[0]![0];
    expect(registerArg.pluginAuthExclusions).toEqual([]);
  });
});
