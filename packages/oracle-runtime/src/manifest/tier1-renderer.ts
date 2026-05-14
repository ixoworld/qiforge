import { encodingForModel, type Tiktoken } from 'js-tiktoken';
import type {
  ManifestExample,
  PluginManifest,
} from '../plugin-api/types.js';

/** A plugin manifest paired with the name of the plugin that contributed it. */
export interface Tier1Entry {
  pluginName: string;
  manifest: PluginManifest;
}

export interface Tier1Input {
  manifests: Tier1Entry[];
  /** Soft budget in tokens. Default 5000. Exceeding it triggers a warning. */
  tokenBudget?: number;
  /** Override the tokenizer (mostly for tests). Default: cl100k_base via js-tiktoken. */
  estimateTokens?: (text: string) => number;
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
  '\n\nFor more capabilities, call `list_capabilities()` to see what else is available,\nthen `load_capability(name)` to make its tools available.';

let cachedEncoder: Tiktoken | null = null;
function tiktokenEstimate(text: string): number {
  cachedEncoder ??= encodingForModel('gpt-4o');
  return cachedEncoder.encode(text).length;
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
  const estimate = input.estimateTokens ?? tiktokenEstimate;

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

  const block = `${HEADER}${renderedLines.join('\n\n')}${FOOTER}`;
  return { block, tokens, warnings };
}
