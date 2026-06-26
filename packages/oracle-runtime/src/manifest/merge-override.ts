import type { PluginManifest } from '../plugin-api/types.js';

/**
 * Fork-supplied overrides for a plugin's manifest. Merged shallowly over the
 * plugin's own `manifest` at boot — keys present in the override win, absent
 * keys keep the plugin default. Lets a fork retune a bundled plugin's
 * discovery without forking its source (e.g. flip a noisy `always` plugin to
 * `on-demand`, hide one with `silent`, or relabel its `summary`/`tags`).
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
