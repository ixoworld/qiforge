import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { resolvePlugins } from '../../bootstrap/plugin-loader.js';
import { validateManifest } from '../../manifest/validator.js';
import { makeBuildCtx } from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { CreditsPlugin } from '../credits/index.js';
import { TokenLimiter } from '../credits/token-limiter.js';
import { ClaimProcessingPlugin } from './claim-processing.plugin.js';
import { ClaimProcessingService } from './claim-processing.service.js';

const NOOP_LOGGER = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Build an ioredis stub. Only the few commands `TokenLimiter` issues during
 * the parts of `processHeldAmount` exercised here are mocked; anything else
 * returns benign defaults. The cast pins the partial object to the full
 * ioredis `Redis` shape for the constructor.
 */
function makeRedisStub(opts: {
  /** Tuples `[userDid, heldAmount]` returned by `listUsersWithHeldAmount`. */
  heldUsers?: Array<[string, number]>;
  /** Subscription JSON to return for `getSubscriptionPayload(userDid)`. */
  subscriptionByUser?: Record<string, unknown>;
}): Redis {
  const heldUsers = opts.heldUsers ?? [];
  const subscriptions = opts.subscriptionByUser ?? {};
  const stub = {
    zrangebyscore: vi.fn(async () =>
      heldUsers.flatMap(([did, amt]) => [did, amt.toString()]),
    ),
    zrem: vi.fn(async () => 1),
    zincrby: vi.fn(async () => '0'),
    zscore: vi.fn(async () => null),
    get: vi.fn(async (key: string) => {
      for (const [did, payload] of Object.entries(subscriptions)) {
        if (key.endsWith(`${did}:subscription_payload`)) {
          return JSON.stringify(payload);
        }
      }
      return null;
    }),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    eval: vi.fn(async () => [1, 0, 'SUCCESS']),
  };
  return stub as unknown as Redis;
}

/**
 * Build a minimal `ConfigService`-like stub. Mirrors `get`/`getOrThrow`
 * against an in-memory map — the same pattern other runtime tests use
 * (e.g. `auth-header.middleware.test.ts`).
 */
function makeConfigStub(
  values: Record<string, unknown>,
): ConfigService<Record<string, unknown>> {
  const stub = {
    get: (key: string): unknown => values[key],
    getOrThrow: (key: string): unknown => {
      const v = values[key];
      if (v === undefined || v === null) {
        throw new Error(`Missing required config: ${key}`);
      }
      return v;
    },
  };
  return stub as unknown as ConfigService<Record<string, unknown>>;
}

/** Base config values the service needs for construction. */
const BASE_CONFIG_VALUES: Record<string, unknown> = {
  ORACLE_DID: 'did:ixo:oracle',
  ORACLE_ENTITY_DID: 'did:ixo:entity:oracle',
  ORACLE_NAME: 'TestOracle',
  NETWORK: 'devnet',
  SQLITE_DATABASE_PATH: '/tmp/qiforge-claim-processing-tests',
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'matrix-admin-token',
  MATRIX_ACCOUNT_ROOM_ID: '!oracle-room:ixo.world',
  MATRIX_VALUE_PIN: 'pin',
  SECP_MNEMONIC: 'test mnemonic',
};

describe('ClaimProcessingPlugin', () => {
  it('has the expected identity, manifest, and hard dependency on credits', () => {
    const plugin = new ClaimProcessingPlugin();

    expect(plugin.name).toBe('claim-processing');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Claim Processing');
    expect(plugin.manifest.visibility).toBe('silent');
    expect(plugin.manifest.category).toBe('core');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.dependsOn).toEqual(['credits']);
    expect(validateManifest(plugin.manifest, plugin.name).valid).toBe(true);

    // Contributes nothing the agent can see.
    expect(plugin.getTools?.(makeBuildCtx())).toBeUndefined();
    expect(plugin.getSubAgents?.(makeBuildCtx())).toBeUndefined();
    expect(plugin.getMiddlewares?.(makeBuildCtx())).toBeUndefined();
  });

  it('cascades off when credits is excluded', () => {
    const resolved = resolvePlugins({
      bundled: [new CreditsPlugin(), new ClaimProcessingPlugin()],
      features: { credits: false },
      env: {},
      logger: NOOP_LOGGER,
    });

    expect(resolved.loaded.map((p) => p.name)).not.toContain(
      'claim-processing',
    );
    expect(
      resolved.excluded.find((e) => e.plugin === 'claim-processing'),
    ).toMatchObject({ cause: 'cascaded' });
  });

  it('is silent through createTestRuntime — no listing, no tools', async () => {
    const credits = new CreditsPlugin({ redis: makeRedisStub({}) });
    const claim = new ClaimProcessingPlugin();

    const rt = await createTestRuntime({
      plugins: [credits, claim],
      config: { NETWORK: 'devnet', DISABLE_CREDITS: false },
    });

    rt.assertManifestValid();
    rt.assertNoCollisions();

    expect(
      rt.listCapabilities().find((c) => c.name === 'claim-processing'),
    ).toBeUndefined();
    expect(rt.listTools('claim-processing')).toEqual([]);

    await rt.close();
  });
});

describe('ClaimProcessingService', () => {
  it('refuses to construct without a TokenLimiter', () => {
    expect(
      () =>
        new ClaimProcessingService(
          makeConfigStub({ ...BASE_CONFIG_VALUES }),
        ),
    ).toThrow(/TokenLimiter/);
  });

  it('skips processing when DISABLE_CREDITS is true', async () => {
    const redis = makeRedisStub({});
    const tokenLimiter = new TokenLimiter({
      redis,
      network: 'devnet',
      disableCredits: true,
    });
    const listSpy = vi.spyOn(tokenLimiter, 'listUsersWithHeldAmount');

    const service = new ClaimProcessingService(
      makeConfigStub({ ...BASE_CONFIG_VALUES, DISABLE_CREDITS: true }),
      tokenLimiter,
    );

    await service.processHeldAmount();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('walks held-amount users and short-circuits when collection ID is missing', async () => {
    const userDid = 'did:ixo:user-claims';
    const redis = makeRedisStub({
      heldUsers: [[userDid, 6000]],
      subscriptionByUser: {
        // Force the "no oracle claims collection ID" branch so the test
        // never reaches the real chain client / subscription API.
        [userDid]: {
          adminAddress: 'ixo1admin',
          claimCollections: { oracleClaimsCollectionId: '' },
          totalCredits: 10000,
        },
      },
    });
    const tokenLimiter = new TokenLimiter({
      redis,
      network: 'devnet',
      disableCredits: false,
    });

    const service = new ClaimProcessingService(
      makeConfigStub({ ...BASE_CONFIG_VALUES, DISABLE_CREDITS: false }),
      tokenLimiter,
    );

    const listSpy = vi.spyOn(tokenLimiter, 'listUsersWithHeldAmount');
    const getSubSpy = vi.spyOn(tokenLimiter, 'getSubscriptionPayload');
    const createPendingSpy = vi.spyOn(
      tokenLimiter,
      'getOrCreatePendingClaim',
    );

    await service.processHeldAmount();

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(getSubSpy).toHaveBeenCalledWith(userDid);
    // Missing collection ID is detected before any pending-claim work.
    expect(createPendingSpy).not.toHaveBeenCalled();
  });
});
