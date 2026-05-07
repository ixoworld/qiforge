import type { PluginManifest } from '../plugin-api/types.js';
import { pluginManifestSchema } from './schema.js';

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
 */
export function validateExamplesAgainstTools(
  manifest: PluginManifest,
  registeredToolNames: string[],
  pluginName: string,
): { errors: string[] } {
  const errors: string[] = [];
  if (!manifest.examples) return { errors };

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
