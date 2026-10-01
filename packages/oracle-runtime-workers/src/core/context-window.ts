/**
 * The context window of the model a turn runs on — resolved per model, not
 * configured once for the deployment.
 *
 * Every context budget (when to summarize, how large a tool result may be
 * before it is capped, when a request no longer fits) is a fraction of this
 * number, so a 1M-context model is treated differently from a 32k one.
 *
 * Resolution order, first hit wins:
 *
 *   1. an operator override for the exact model id (`MODEL_CONTEXT_OVERRIDES`);
 *   2. the OpenRouter `/models` listing (the same cached fetch that serves
 *      the price catalog) — for OpenRouter ids directly, and for BYO
 *      provider-native ids through the vendor prefix (`gpt-…` → `openai/gpt-…`);
 *   3. the deployment default (`MODEL_CONTEXT_TOKENS`, 100k unless set).
 *
 * On top of that, a window is **learned downwards**: when a provider rejects
 * a request as too long and names its limit, that smaller number is kept for
 * the model (persistently, when the host supplies a store) and wins over the
 * catalog from then on. A provider's error is the one source that is never
 * wrong about its own limit; nothing is ever learned upwards.
 *
 * Modelled on Hermes Agent's `get_model_context_length` chain, trimmed to the
 * sources this runtime has.
 */
import type { Logger } from '../plugin-api/types';
import { NOOP_LOGGER } from './utils';

export const DEFAULT_CONTEXT_TOKENS = 100_000;
export const MIN_CONTEXT_TOKENS = 16_000;
/** Above this a "window" is not a window (a parse slip); ignored. */
export const MAX_CONTEXT_TOKENS = 20_000_000;

export type ContextWindowOrigin =
  | 'override'
  | 'learned'
  | 'catalog'
  | 'default';

export interface ContextWindowResolution {
  /** The id the lookup was made for (as given). */
  model: string;
  tokens: number;
  origin: ContextWindowOrigin;
  /** The catalog id that answered, when the catalog did. */
  catalogId?: string;
}

export interface ContextWindowConfig {
  defaultTokens: number;
  overrides: ReadonlyMap<string, number>;
}

/** Persisted learned limits (the host backs this with Durable Object storage). */
export interface LearnedWindowStore {
  get(model: string): Promise<number | undefined>;
  set(model: string, tokens: number): Promise<void>;
}

export interface ContextWindowResolverOptions {
  config: ContextWindowConfig;
  /** OpenRouter model id → context window (tokens). */
  catalog: () => Promise<ReadonlyMap<string, number>>;
  learned?: LearnedWindowStore;
  logger?: Logger;
}

/**
 * `MODEL_CONTEXT_OVERRIDES="openai/gpt-5.6-luna=400000, gpt-5.6-terra=1000000"`
 * — comma-separated `<model id>=<tokens>`; malformed entries are skipped
 * with a warning. `MODEL_CONTEXT_TOKENS` is the default for models nothing
 * else knows (min 16k).
 */
export function contextWindowConfig(
  env: Record<string, unknown>,
  logger: Logger = NOOP_LOGGER,
): ContextWindowConfig {
  const rawDefault = env.MODEL_CONTEXT_TOKENS;
  const parsedDefault =
    typeof rawDefault === 'string' && rawDefault.trim() !== ''
      ? Number(rawDefault)
      : Number.NaN;
  const defaultTokens = isWindow(parsedDefault)
    ? Math.floor(parsedDefault)
    : DEFAULT_CONTEXT_TOKENS;
  if (
    typeof rawDefault === 'string' &&
    rawDefault.trim() !== '' &&
    !isWindow(parsedDefault)
  )
    logger.warn(
      `[context] MODEL_CONTEXT_TOKENS=${rawDefault} is not a usable window; using ${DEFAULT_CONTEXT_TOKENS}`,
    );
  const overrides = new Map<string, number>();
  const rawOverrides = env.MODEL_CONTEXT_OVERRIDES;
  if (typeof rawOverrides === 'string' && rawOverrides.trim() !== '') {
    for (const entry of rawOverrides.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const eq = trimmed.lastIndexOf('=');
      const model = eq > 0 ? trimmed.slice(0, eq).trim() : '';
      const tokens = eq > 0 ? Number(trimmed.slice(eq + 1).trim()) : Number.NaN;
      if (!model || !isWindow(tokens)) {
        logger.warn(
          `[context] MODEL_CONTEXT_OVERRIDES entry ignored: "${trimmed}"`,
        );
        continue;
      }
      overrides.set(model, Math.floor(tokens));
    }
  }
  return { defaultTokens, overrides };
}

function isWindow(n: number): boolean {
  return (
    Number.isFinite(n) && n >= MIN_CONTEXT_TOKENS && n <= MAX_CONTEXT_TOKENS
  );
}

/**
 * OpenRouter routing variants (`:nitro`, `:floor`, `:online`, `:free`, …) are
 * request-time modifiers, not catalog entries: look the base id up.
 */
export function stripRoutingVariant(model: string): string {
  const slash = model.indexOf('/');
  const colon = model.lastIndexOf(':');
  return colon > slash ? model.slice(0, colon) : model;
}

/**
 * Candidate catalog ids for a model id, in order. A provider-native BYO id
 * (`gpt-5.6-luna`, `claude-sonnet-5`, `gemini-3.6-flash`, `deepseek-v4-pro`)
 * is looked up under the vendor prefix OpenRouter lists it with.
 */
export function catalogCandidates(
  model: string,
  byoProvider?: string,
): string[] {
  const base = stripRoutingVariant(model.replace(/^byo:/, ''));
  if (base.includes('/')) return [base];
  const vendors: Record<string, string> = {
    chatgpt: 'openai',
    openai: 'openai',
    anthropic: 'anthropic',
    gemini: 'google',
    deepseek: 'deepseek',
  };
  const byName =
    base.startsWith('gpt-') || /^o\d/.test(base)
      ? 'openai'
      : base.startsWith('claude-')
        ? 'anthropic'
        : base.startsWith('gemini-')
          ? 'google'
          : base.startsWith('deepseek-')
            ? 'deepseek'
            : undefined;
  const prefixes = new Set<string>();
  const byProvider = byoProvider ? vendors[byoProvider] : undefined;
  if (byProvider) prefixes.add(byProvider);
  if (byName) prefixes.add(byName);
  return [...prefixes].map((p) => `${p}/${base}`);
}

const LIMIT_PATTERNS: RegExp[] = [
  // OpenAI / OpenRouter / most OpenAI-compatible gateways
  /maximum context length is (\d[\d,]*) tokens/i,
  /context length of only (\d[\d,]*) tokens/i,
  /context window of (\d[\d,]*) tokens/i,
  // Anthropic: "prompt is too long: 213000 tokens > 200000 maximum"
  /tokens\s*>\s*(\d[\d,]*)\s*maximum/i,
  // Gemini: "input token count (1200000) exceeds the maximum number of tokens allowed (1048576)"
  /maximum number of tokens allowed \((\d[\d,]*)\)/i,
  // Generic "limit: 128000 tokens" / "max_tokens: 128000"
  /(?:token limit|limit)(?: of| is|:)?\s*(\d[\d,]*)\s*tokens/i,
];

/** The limit a provider's "too long" error names, in tokens, or `undefined`. */
export function parseContextLimit(message: string): number | undefined {
  for (const pattern of LIMIT_PATTERNS) {
    const match = pattern.exec(message);
    if (!match?.[1]) continue;
    const n = Number(match[1].replace(/,/g, ''));
    if (isWindow(n)) return n;
  }
  return undefined;
}

/** A provider rejected the request because the prompt no longer fits. */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /context_length_exceeded|maximum context length|context window|prompt is too long|input tokens exceed|too many tokens|exceeds the maximum number of tokens|request too large for|reduce the length of the messages/i.test(
    message,
  );
}

export class ContextWindowResolver {
  private readonly logger: Logger;

  /** Learned limits seen this boot (so a persisted read happens once per model). */
  private readonly learnedCache = new Map<string, number | undefined>();

  constructor(private readonly options: ContextWindowResolverOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async resolve(
    model: string,
    opts: { byoProvider?: string } = {},
  ): Promise<ContextWindowResolution> {
    const base = await this.baseline(model, opts.byoProvider);
    const learned = await this.learned(model);
    if (learned !== undefined && learned < base.tokens) {
      return { ...base, tokens: learned, origin: 'learned' };
    }
    return base;
  }

  private async baseline(
    model: string,
    byoProvider?: string,
  ): Promise<ContextWindowResolution> {
    const { config } = this.options;
    const stripped = stripRoutingVariant(model.replace(/^byo:/, ''));
    const override =
      config.overrides.get(model) ?? config.overrides.get(stripped);
    if (override !== undefined)
      return { model, tokens: override, origin: 'override' };
    let catalog: ReadonlyMap<string, number> | undefined;
    try {
      catalog = await this.options.catalog();
    } catch (error) {
      this.logger.warn(
        `[context] model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (catalog) {
      for (const candidate of catalogCandidates(model, byoProvider)) {
        const tokens = catalog.get(candidate);
        if (tokens !== undefined && isWindow(tokens))
          return { model, tokens, origin: 'catalog', catalogId: candidate };
      }
    }
    return { model, tokens: config.defaultTokens, origin: 'default' };
  }

  private async learned(model: string): Promise<number | undefined> {
    if (this.learnedCache.has(model)) return this.learnedCache.get(model);
    let value: number | undefined;
    try {
      value = await this.options.learned?.get(model);
    } catch {
      value = undefined;
    }
    this.learnedCache.set(model, value);
    return value;
  }

  /**
   * A provider said the prompt does not fit: keep the limit it named when it
   * is smaller than what we believed. Returns the new window, or `undefined`
   * when the message names nothing usable (the caller then shrinks blind).
   */
  async learnFromError(
    model: string,
    error: unknown,
    opts: { byoProvider?: string } = {},
  ): Promise<number | undefined> {
    const message =
      error instanceof Error ? error.message : String(error ?? '');
    const limit = parseContextLimit(message);
    if (limit === undefined) return undefined;
    const current = await this.resolve(model, opts);
    if (limit >= current.tokens) return undefined;
    this.learnedCache.set(model, limit);
    try {
      await this.options.learned?.set(model, limit);
    } catch (storeError) {
      this.logger.warn(
        `[context] could not persist the learned window for ${model}: ${storeError instanceof Error ? storeError.message : String(storeError)}`,
      );
    }
    this.logger.warn(
      `[context] ${model}: window lowered ${current.tokens} → ${limit} (from the provider's error)`,
    );
    return limit;
  }
}
