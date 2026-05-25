import { AIMessageChunk } from '@langchain/core/messages';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { makeBuildCtx } from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { CreditsPlugin } from './credits.plugin.js';

/**
 * Build a fake Redis client whose `eval` (Lua atomic limit) decrements an
 * in-memory balance and signals overdraft when it would go negative — the
 * same contract the production Lua script honours. Only stubs the commands
 * `TokenLimiter` actually issues; the cast pins it to the full ioredis
 * `Redis` shape for the plugin constructor.
 */
function makeRedisStub(initialBalance: number): Redis & {
  balance: number;
  evalCalls: number;
} {
  const state = { balance: initialBalance, evalCalls: 0 };
  const stub = {
    get: vi.fn(async (key: string) => {
      if (key.endsWith(':balance')) return state.balance.toString();
      return null;
    }),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    zscore: vi.fn(async () => null),
    zincrby: vi.fn(async () => '0'),
    zrem: vi.fn(async () => 1),
    zrangebyscore: vi.fn(async () => []),
    eval: vi.fn(async (_script, _keys, ..._args) => {
      state.evalCalls++;
      const credits = parseFloat(_args[3] as string);
      const next = state.balance - credits;
      if (next < 0) {
        return [0, state.balance, 'INSUFFICIENT_BALANCE'];
      }
      state.balance = next;
      return [1, state.balance, 'SUCCESS'];
    }),
  } as unknown as Redis;
  return Object.assign(stub, state) as Redis & {
    balance: number;
    evalCalls: number;
  };
}

const DEFAULT_RUNTIME_CONTEXT = {
  user: { did: 'did:ixo:user-1' },
};

describe('CreditsPlugin', () => {
  it('has the expected identity, manifest, configSchema, and autoDetect', () => {
    const plugin = new CreditsPlugin();
    expect(plugin.name).toBe('credits');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Credits');
    expect(plugin.manifest.visibility).toBe('silent');
    expect(plugin.manifest.category).toBe('core');
    expect(plugin.manifest.stability).toBe('stable');

    expect(validateManifest(plugin.manifest, plugin.name).valid).toBe(true);

    // autoDetect is ON unless DISABLE_CREDITS === 'true'.
    expect(plugin.autoDetect?.({})).toBe(true);
    expect(plugin.autoDetect?.({ DISABLE_CREDITS: 'false' })).toBe(true);
    expect(plugin.autoDetect?.({ DISABLE_CREDITS: 'true' })).toBe(false);
    expect(plugin.autoDetectHint).toBe('DISABLE_CREDITS!=true');

    // SUBSCRIPTION_URL/SUBSCRIPTION_ORACLE_MCP_URL are optional but URL-validated.
    expect(plugin.configSchema.safeParse({}).success).toBe(true);
    expect(
      plugin.configSchema.safeParse({ SUBSCRIPTION_URL: 'not-a-url' }).success,
    ).toBe(false);
    expect(
      plugin.configSchema.safeParse({ SUBSCRIPTION_URL: 'https://x.test' })
        .success,
    ).toBe(true);
  });

  it('contributes exactly one middleware named TokenLimiterMiddleware', () => {
    const plugin = new CreditsPlugin({ redis: makeRedisStub(100) });
    const mws = plugin.getMiddlewares(makeBuildCtx());
    expect(mws).toHaveLength(1);
    expect(mws[0]?.name).toBe('TokenLimiterMiddleware');
  });

  it('middleware blocks the call with a user-visible message when balance is zero', async () => {
    const redis = makeRedisStub(0);
    const plugin = new CreditsPlugin({ redis });
    const rt = await createTestRuntime({
      plugins: [plugin],
      config: { NETWORK: 'devnet', DISABLE_CREDITS: false },
    });

    const result = await rt.invokeMiddleware(
      'TokenLimiterMiddleware',
      { messages: [] },
      { context: DEFAULT_RUNTIME_CONTEXT },
    );

    expect(result.before).toBeDefined();
    const before = result.before as { messages: AIMessageChunk[] };
    expect(before.messages).toHaveLength(1);
    expect(String(before.messages[0]!.content)).toMatch(/run out of tokens/i);
    // No deduction call when we short-circuit on empty balance.
    expect(redis.eval).not.toHaveBeenCalled();
    await rt.close();
  });

  it('middleware deducts credits via TokenLimiter.limit on afterModel using flat-rate fallback', async () => {
    const redis = makeRedisStub(10_000);
    const plugin = new CreditsPlugin({ redis });
    const rt = await createTestRuntime({
      plugins: [plugin],
      config: { NETWORK: 'devnet', DISABLE_CREDITS: false },
    });

    const aiMessage = new AIMessageChunk({
      content: 'hello',
    });
    // The chunk constructor doesn't populate usage_metadata; assign directly
    // so the middleware's afterModel hook can read it.
    Object.assign(aiMessage, {
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
      },
      response_metadata: {},
    });

    await rt.invokeMiddleware(
      'TokenLimiterMiddleware',
      { messages: [aiMessage] },
      { context: DEFAULT_RUNTIME_CONTEXT },
    );

    // Flat-rate devnet: tokensPerMillion=1000, markup=5 → cost = (300/1000) * (0.75*5) = 1.125 → round = 1
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const lastEvalArgs = redis.eval.mock.calls.at(-1)!;
    // numKeys=2, then balanceKey, heldKey, userDid, credits
    expect(lastEvalArgs[1]).toBe(2);
    expect(lastEvalArgs[4]).toBe('did:ixo:user-1');
    expect(lastEvalArgs[5]).toBe('1');
    await rt.close();
  });

  it('middleware skips silently when no Redis client is provided (Redis disabled)', async () => {
    const plugin = new CreditsPlugin(); // no redis → middleware is a no-op
    const rt = await createTestRuntime({
      plugins: [plugin],
      config: { NETWORK: 'devnet', DISABLE_CREDITS: false },
    });

    const aiMessage = new AIMessageChunk({ content: 'hi' });
    Object.assign(aiMessage, {
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      response_metadata: {},
    });

    const result = await rt.invokeMiddleware(
      'TokenLimiterMiddleware',
      { messages: [aiMessage] },
      { context: DEFAULT_RUNTIME_CONTEXT },
    );

    // Neither hook produces an update when the limiter is disabled.
    expect(result.before).toBeUndefined();
    expect(result.after).toBeUndefined();
    await rt.close();
  });

  it('boots through createTestRuntime with visibility=silent and is not listed as a capability', async () => {
    const plugin = new CreditsPlugin({ redis: makeRedisStub(100) });
    const rt = await createTestRuntime({
      plugins: [plugin],
      config: { NETWORK: 'devnet', DISABLE_CREDITS: false },
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();

    // Silent plugins are filtered out of listCapabilities.
    const listing = rt.listCapabilities().find((c) => c.name === 'credits');
    expect(listing).toBeUndefined();
    // And they expose no agent-visible tools.
    expect(rt.listTools('credits')).toEqual([]);
    await rt.close();
  });

  describe('getNestModules — Nest wiring', () => {
    it('returns claim-processing + file-processing sink + subscription sink modules when redis + network are set', () => {
      const plugin = new CreditsPlugin({
        redis: makeRedisStub(100),
        network: 'devnet',
      });
      const modules = plugin.getNestModules();
      // Three modules: claim-processing cron + FILE_PROCESSING_CREDIT_SINK
      // + SUBSCRIPTION_CREDIT_SINK.
      expect(modules).toHaveLength(3);
      for (const mod of modules) {
        const dynamicModule = mod as { module: unknown };
        expect(dynamicModule.module).toBeDefined();
      }
    });

    it('returns [] when redis is null', () => {
      const plugin = new CreditsPlugin({ network: 'devnet' });
      expect(plugin.getNestModules()).toEqual([]);
    });

    it('returns [] when network is omitted (cron cannot start)', () => {
      const plugin = new CreditsPlugin({ redis: makeRedisStub(100) });
      expect(plugin.getNestModules()).toEqual([]);
    });
  });
});
