import { describe, expect, it } from 'vitest';
import {
  catalogCandidates,
  contextWindowConfig,
  ContextWindowResolver,
  DEFAULT_CONTEXT_TOKENS,
  isContextOverflowError,
  parseContextLimit,
  stripRoutingVariant,
  type LearnedWindowStore,
} from './context-window';

const silent = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function memoryLearned(): LearnedWindowStore & { map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    get: async (m) => map.get(m),
    set: async (m, t) => {
      map.set(m, t);
    },
  };
}

const CATALOG = new Map<string, number>([
  ['openai/gpt-5.6-luna', 400_000],
  ['openai/gpt-5.6-terra', 1_000_000],
  ['anthropic/claude-sonnet-5', 200_000],
  ['google/gemini-3.6-flash', 1_048_576],
  ['deepseek/deepseek-v4-flash', 131_072],
  ['mistralai/mistral-small', 32_768],
]);

const resolver = (
  over: Partial<ConstructorParameters<typeof ContextWindowResolver>[0]> = {},
) =>
  new ContextWindowResolver({
    config: contextWindowConfig({}),
    catalog: async () => CATALOG,
    logger: silent,
    ...over,
  });

describe('contextWindowConfig', () => {
  it('reads the default and per-model overrides, skipping garbage', () => {
    const warned: string[] = [];
    const cfg = contextWindowConfig(
      {
        MODEL_CONTEXT_TOKENS: '128000',
        MODEL_CONTEXT_OVERRIDES:
          'openai/gpt-5.6-luna=400000, gpt-5.6-terra=1000000,, bad, tiny=100, x=notanumber',
      },
      { ...silent, warn: (m: unknown) => warned.push(String(m)) },
    );
    expect(cfg.defaultTokens).toBe(128_000);
    expect([...cfg.overrides]).toEqual([
      ['openai/gpt-5.6-luna', 400_000],
      ['gpt-5.6-terra', 1_000_000],
    ]);
    expect(warned).toHaveLength(3);
  });

  it('falls back to 100k when the default is unusable', () => {
    expect(
      contextWindowConfig({ MODEL_CONTEXT_TOKENS: '12' }, silent).defaultTokens,
    ).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(contextWindowConfig({}).defaultTokens).toBe(DEFAULT_CONTEXT_TOKENS);
  });
});

describe('catalog id candidates', () => {
  it('strips OpenRouter routing variants but keeps model-name colons before the slash', () => {
    expect(stripRoutingVariant('openai/gpt-5.6-luna:nitro')).toBe(
      'openai/gpt-5.6-luna',
    );
    expect(stripRoutingVariant('openai/gpt-5.6-luna')).toBe(
      'openai/gpt-5.6-luna',
    );
    expect(stripRoutingVariant('meta-llama/llama-3.1-8b-instruct:free')).toBe(
      'meta-llama/llama-3.1-8b-instruct',
    );
  });

  it('maps provider-native BYO ids to the vendor prefix, by provider first, then by name', () => {
    expect(catalogCandidates('gpt-5.6-luna', 'chatgpt')).toEqual([
      'openai/gpt-5.6-luna',
    ]);
    expect(catalogCandidates('claude-sonnet-5', 'anthropic')).toEqual([
      'anthropic/claude-sonnet-5',
    ]);
    expect(catalogCandidates('gemini-3.6-flash', 'gemini')).toEqual([
      'google/gemini-3.6-flash',
    ]);
    expect(catalogCandidates('deepseek-v4-pro')).toEqual([
      'deepseek/deepseek-v4-pro',
    ]);
    expect(catalogCandidates('byo:gpt-5.6-terra')).toEqual([
      'openai/gpt-5.6-terra',
    ]);
    expect(catalogCandidates('o4-mini')).toEqual(['openai/o4-mini']);
    expect(catalogCandidates('unknown-model')).toEqual([]);
    expect(catalogCandidates('openai/gpt-5.6-luna:floor')).toEqual([
      'openai/gpt-5.6-luna',
    ]);
  });
});

describe('ContextWindowResolver', () => {
  it('resolves override → catalog → default, in that order', async () => {
    const r = resolver({
      config: contextWindowConfig({
        MODEL_CONTEXT_TOKENS: '64000',
        MODEL_CONTEXT_OVERRIDES: 'anthropic/claude-sonnet-5=150000',
      }),
    });
    expect(await r.resolve('anthropic/claude-sonnet-5')).toMatchObject({
      tokens: 150_000,
      origin: 'override',
    });
    expect(await r.resolve('openai/gpt-5.6-luna:nitro')).toMatchObject({
      tokens: 400_000,
      origin: 'catalog',
      catalogId: 'openai/gpt-5.6-luna',
    });
    expect(
      await r.resolve('gemini-3.6-flash', { byoProvider: 'gemini' }),
    ).toMatchObject({
      tokens: 1_048_576,
      origin: 'catalog',
    });
    expect(await r.resolve('some/unknown-model')).toMatchObject({
      tokens: 64_000,
      origin: 'default',
    });
  });

  it('serves the default when the catalog is unavailable, without throwing', async () => {
    const r = resolver({
      catalog: async () => {
        throw new Error('network');
      },
    });
    expect(await r.resolve('openai/gpt-5.6-luna')).toMatchObject({
      tokens: DEFAULT_CONTEXT_TOKENS,
      origin: 'default',
    });
  });

  it('learns a smaller window from a provider error, persists it, and never learns upwards', async () => {
    const learned = memoryLearned();
    const r = resolver({ learned });
    const lowered = await r.learnFromError(
      'openai/gpt-5.6-luna',
      new Error(
        "This model's maximum context length is 128000 tokens. However, you requested 131000 tokens.",
      ),
    );
    expect(lowered).toBe(128_000);
    expect(learned.map.get('openai/gpt-5.6-luna')).toBe(128_000);
    expect(await r.resolve('openai/gpt-5.6-luna')).toMatchObject({
      tokens: 128_000,
      origin: 'learned',
    });
    // A larger number than we already have is not a lesson.
    expect(
      await r.learnFromError(
        'openai/gpt-5.6-luna',
        new Error('maximum context length is 200000 tokens'),
      ),
    ).toBeUndefined();
    expect(learned.map.get('openai/gpt-5.6-luna')).toBe(128_000);
    // An error that names no limit teaches nothing.
    expect(
      await r.learnFromError(
        'openai/gpt-5.6-luna',
        new Error('prompt is too long'),
      ),
    ).toBeUndefined();
    // A fresh resolver reads the persisted value.
    expect(
      await resolver({ learned }).resolve('openai/gpt-5.6-luna'),
    ).toMatchObject({
      tokens: 128_000,
      origin: 'learned',
    });
  });

  it('a learned value never overrides an explicit operator override', async () => {
    const learned = memoryLearned();
    learned.map.set('openai/gpt-5.6-luna', 50_000);
    const r = resolver({
      learned,
      config: contextWindowConfig({
        MODEL_CONTEXT_OVERRIDES: 'openai/gpt-5.6-luna=300000',
      }),
    });
    // The override is the baseline; a learned limit below it still applies
    // (the provider knows better than the operator about its own rejection).
    expect(await r.resolve('openai/gpt-5.6-luna')).toMatchObject({
      tokens: 50_000,
      origin: 'learned',
    });
  });
});

describe('parseContextLimit', () => {
  it('reads the limit out of the common provider error shapes', () => {
    expect(
      parseContextLimit(
        "This model's maximum context length is 128000 tokens.",
      ),
    ).toBe(128_000);
    expect(
      parseContextLimit('prompt is too long: 213000 tokens > 200000 maximum'),
    ).toBe(200_000);
    expect(
      parseContextLimit(
        'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      ),
    ).toBe(1_048_576);
    expect(
      parseContextLimit(
        "This endpoint's maximum context length is 131,072 tokens",
      ),
    ).toBe(131_072);
    expect(parseContextLimit('context length of only 32768 tokens')).toBe(
      32_768,
    );
    expect(parseContextLimit('something else entirely')).toBeUndefined();
    expect(
      parseContextLimit('maximum context length is 12 tokens'),
    ).toBeUndefined();
  });

  it('recognises overflow errors across providers', () => {
    expect(
      isContextOverflowError(new Error('400 context_length_exceeded')),
    ).toBe(true);
    expect(isContextOverflowError(new Error('prompt is too long: 1 > 0'))).toBe(
      true,
    );
    expect(
      isContextOverflowError(
        new Error('input tokens exceed the configured limit'),
      ),
    ).toBe(true);
    expect(isContextOverflowError(new Error('rate limit exceeded'))).toBe(
      false,
    );
  });
});
