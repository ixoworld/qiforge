import { z } from 'zod';
import type { ManifestExample, PluginManifest } from '../plugin-api/types';

// ── Schema ──────────────────────────────────────────────────────────────────

/** Few-shot example teaching the agent how to invoke the plugin. */
export const manifestExampleSchema: z.ZodType<ManifestExample> = z.object({
  user: z.string(),
  thought: z.string().optional(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

/** Allowed `category` values, kept aligned with the `PluginManifest` interface. */
export const manifestCategorySchema = z.enum([
  'data',
  'communication',
  'automation',
  'memory',
  'integration',
  'ui',
  'auth',
  'observability',
  'core',
]);

/** Allowed `visibility` values. */
export const manifestVisibilitySchema = z.enum([
  'always',
  'on-demand',
  'silent',
]);

/** Allowed `stability` values. */
export const manifestStabilitySchema = z.enum([
  'stable',
  'beta',
  'experimental',
]);

/** Zod schema mirroring the `PluginManifest` TypeScript interface. */
export const pluginManifestSchema: z.ZodType<PluginManifest> = z.object({
  title: z.string(),
  summary: z.string(),
  whenToUse: z.array(z.string()),
  whenNotToUse: z.array(z.string()).optional(),
  examples: z.array(manifestExampleSchema).optional(),
  tags: z.array(z.string()).optional(),
  category: manifestCategorySchema.optional(),
  visibility: manifestVisibilitySchema.optional(),
  stability: manifestStabilitySchema.optional(),
});

// ── Validator ───────────────────────────────────────────────────────────────

/** Result of validating a single plugin manifest. */
export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Soft-cap thresholds — violations only emit warnings. */
const SOFT_LIMITS = {
  summaryMaxChars: 120,
  whenToUseMaxItems: 8,
  whenToUseItemMaxChars: 100,
  whenNotToUseMaxItems: 4,
  whenNotToUseItemMaxChars: 80,
  examplesMaxItems: 3,
} as const;

/** Format a per-plugin, per-field message prefix. */
function tag(pluginName: string, fieldPath: string): string {
  return `[${pluginName}] ${fieldPath}:`;
}

/**
 * Validate a plugin manifest at boot time.
 *
 * Hard rules push to `errors` and set `valid: false`.
 * Soft rules push to `warnings` only — `valid` stays `true`.
 *
 * Cross-tool reference checking lives in `validateExamplesAgainstTools`
 * because the registered tool list is only known once the plugin's
 * `getTools()` has run.
 */
export function validateManifest(
  manifest: unknown,
  pluginName: string,
): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = pluginManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      errors.push(`${tag(pluginName, path)} ${issue.message}`);
    }
    return { valid: false, errors, warnings };
  }

  const m = parsed.data;

  // Hard rule: summary must be non-empty.
  if (m.summary.trim().length === 0) {
    errors.push(`${tag(pluginName, 'summary')} must be non-empty.`);
  }

  // Hard rule: whenToUse must have ≥1 entry unless plugin is silent.
  const visibility = m.visibility ?? 'on-demand';
  if (visibility !== 'silent' && m.whenToUse.length < 1) {
    errors.push(
      `${tag(pluginName, 'whenToUse')} must contain at least one entry when visibility is '${visibility}'.`,
    );
  }

  // Hard rule: tags, if present, must all be lowercase.
  if (m.tags) {
    m.tags.forEach((t, i) => {
      if (t !== t.toLowerCase()) {
        errors.push(
          `${tag(pluginName, `tags[${i}]`)} must be lowercase (got "${t}").`,
        );
      }
    });
  }

  // Soft rule: summary length cap.
  if (m.summary.length > SOFT_LIMITS.summaryMaxChars) {
    warnings.push(
      `${tag(pluginName, 'summary')} is ${m.summary.length} chars (recommended ≤ ${SOFT_LIMITS.summaryMaxChars}).`,
    );
  }

  // Soft rule: whenToUse caps.
  if (m.whenToUse.length > SOFT_LIMITS.whenToUseMaxItems) {
    warnings.push(
      `${tag(pluginName, 'whenToUse')} has ${m.whenToUse.length} items (recommended ≤ ${SOFT_LIMITS.whenToUseMaxItems}).`,
    );
  }
  m.whenToUse.forEach((line, i) => {
    if (line.length > SOFT_LIMITS.whenToUseItemMaxChars) {
      warnings.push(
        `${tag(pluginName, `whenToUse[${i}]`)} is ${line.length} chars (recommended ≤ ${SOFT_LIMITS.whenToUseItemMaxChars}).`,
      );
    }
  });

  // Soft rule: whenNotToUse caps.
  if (m.whenNotToUse) {
    if (m.whenNotToUse.length > SOFT_LIMITS.whenNotToUseMaxItems) {
      warnings.push(
        `${tag(pluginName, 'whenNotToUse')} has ${m.whenNotToUse.length} items (recommended ≤ ${SOFT_LIMITS.whenNotToUseMaxItems}).`,
      );
    }
    m.whenNotToUse.forEach((line, i) => {
      if (line.length > SOFT_LIMITS.whenNotToUseItemMaxChars) {
        warnings.push(
          `${tag(pluginName, `whenNotToUse[${i}]`)} is ${line.length} chars (recommended ≤ ${SOFT_LIMITS.whenNotToUseItemMaxChars}).`,
        );
      }
    });
  }

  // Soft rule: examples cap.
  if (m.examples && m.examples.length > SOFT_LIMITS.examplesMaxItems) {
    warnings.push(
      `${tag(pluginName, 'examples')} has ${m.examples.length} items (recommended ≤ ${SOFT_LIMITS.examplesMaxItems}).`,
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Cross-check `examples[].tool` references against the set of tool names
 * actually registered by this plugin. Run after the plugin's `getTools()`
 * has been invoked.
 *
 * **Lenient for request-time plugins**: when `registeredToolNames` is empty,
 * the plugin's tools come from `getRequestTools` — boot-time validation
 * can't see them. We skip the cross-check in that case rather than
 * false-flag every example. Plugins with boot-time tools still get the
 * full check, so stale `examples[].tool` references are caught.
 */
export function validateExamplesAgainstTools(
  manifest: PluginManifest,
  registeredToolNames: string[],
  pluginName: string,
): { errors: string[] } {
  const errors: string[] = [];
  if (!manifest.examples) return { errors };

  if (registeredToolNames.length === 0) return { errors };

  const known = new Set(registeredToolNames);
  manifest.examples.forEach((ex, i) => {
    if (!known.has(ex.tool)) {
      errors.push(
        `${tag(pluginName, `examples[${i}].tool`)} references unknown tool "${ex.tool}".`,
      );
    }
  });

  return { errors };
}

// ── Override merge ──────────────────────────────────────────────────────────

/**
 * Fork-supplied overrides for a plugin's manifest. Merged shallowly over the
 * plugin's own `manifest` at boot — keys present in the override win, absent
 * keys keep the plugin default.
 */
export type PluginManifestOverride = Partial<PluginManifest>;

/**
 * Shallow-merge a manifest override onto a base manifest. Only keys the
 * override actually sets take effect — an `undefined` value is treated as
 * "leave the base alone" so a sparse override never blanks out a field.
 *
 * Returns the base manifest unchanged (same reference) when there is no
 * override or the override is empty, so callers can cheaply skip work.
 */
export function mergeManifestOverride(
  base: PluginManifest,
  override?: PluginManifestOverride,
): PluginManifest {
  if (!override) return base;

  const defined = Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(defined).length === 0) return base;

  return { ...base, ...defined };
}

// ── Tier-1 renderer ─────────────────────────────────────────────────────────

/** A plugin manifest paired with the name of the plugin that contributed it. */
export interface Tier1Entry {
  pluginName: string;
  manifest: PluginManifest;
}

export interface Tier1Input {
  manifests: Tier1Entry[];
  /** Soft budget in tokens. Default 5000. Exceeding it triggers a warning. */
  tokenBudget?: number;
  /**
   * Override the token estimator (mostly for tests). Default: a chars/4
   * heuristic — the Workers runtime carries no tokenizer vocabulary, and the
   * budget is a soft operator hint where ±20% is immaterial.
   */
  estimateTokens?: (text: string) => number;
  /**
   * Whether the meta-tools are bound this turn. Default `true`. Pass `false`
   * when they are not, so the block does not end by telling the model to
   * call `list_capabilities` / `load_capability`.
   */
  capabilityDiscovery?: boolean;
}

export interface Tier1Output {
  /** The composed prompt block (header + lines). Empty when no entries. */
  block: string;
  /** Token count of the body lines (header excluded). */
  tokens: number;
  /** Warnings to surface to the runtime logger. */
  warnings: string[];
}

const DEFAULT_BUDGET = 5000;

const HEADER = '## Available Capabilities\n\n';
const FOOTER =
  '\n\nFor more capabilities, call `list_capabilities()` to see what else is available,\nthen `load_capability({ names: ["cap1", "cap2"] })` to make their tools available in one call — pass all the capabilities you need at once rather than calling it multiple times.';

/**
 * Chars/4 token estimate. Replaces the Node runtime's `js-tiktoken`
 * (cl100k_base) so the Worker bundle does not carry a tokenizer vocabulary.
 * Rounds up so an empty string still costs nothing and a one-char string
 * costs one token.
 */
export function estimateTokensApprox(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatExample(ex: ManifestExample): string {
  const argSummary =
    ex.args && Object.keys(ex.args).length > 0
      ? `${ex.tool}(${JSON.stringify(ex.args)})`
      : `${ex.tool}()`;
  return `"${ex.user}" → ${argSummary}`;
}

function formatEntry(entry: Tier1Entry): string {
  const { pluginName, manifest } = entry;
  const lines: string[] = [`- **${pluginName}** — ${manifest.summary}`];

  const whenToUse = manifest.whenToUse.slice(0, 2);
  if (whenToUse.length > 0) {
    lines.push(`  - When to use: ${whenToUse.join('; ')}`);
  }

  if (manifest.whenNotToUse && manifest.whenNotToUse.length > 0) {
    lines.push(`  - Avoid for: ${manifest.whenNotToUse[0]}`);
  }

  const firstExample = manifest.examples?.[0];
  if (firstExample) {
    lines.push(`  - Example: ${formatExample(firstExample)}`);
  }

  return lines.join('\n');
}

/**
 * Compose the Tier-1 capability block from a list of plugin manifests.
 *
 * Only `visibility: 'always'` manifests are included, sorted alphabetically
 * for prompt-caching determinism. Over-budget calls produce a warning naming
 * the largest manifests so operators can mark them `'on-demand'` — degrading
 * verbosity is an operator decision, not a runtime guess.
 */
export function renderTier1(input: Tier1Input): Tier1Output {
  const budget = input.tokenBudget ?? DEFAULT_BUDGET;
  const estimate = input.estimateTokens ?? estimateTokensApprox;

  const entries = input.manifests
    .filter(({ manifest }) => manifest.visibility === 'always')
    .slice()
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName));

  if (entries.length === 0) {
    return { block: '', tokens: 0, warnings: [] };
  }

  const renderedLines = entries.map(formatEntry);
  const tokens = renderedLines.reduce((sum, line) => sum + estimate(line), 0);
  const warnings: string[] = [];

  if (tokens > budget) {
    const largest = entries
      .map((entry) => ({
        name: entry.pluginName,
        t: estimate(formatEntry(entry)),
      }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 3)
      .map((e) => `${e.name} (~${e.t} tok)`)
      .join(', ');
    warnings.push(
      `Tier-1 prompt is ${tokens} tokens (budget ${budget}). ` +
        `Consider marking these on-demand: ${largest}.`,
    );
  }

  const footer = input.capabilityDiscovery === false ? '' : FOOTER;
  const block = `${HEADER}${renderedLines.join('\n\n')}${footer}`;
  return { block, tokens, warnings };
}
