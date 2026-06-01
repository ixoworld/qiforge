import { z } from 'zod';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { Logger } from '../plugin-api/types.js';

export interface ComposeEnvSchemaResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>;
  /**
   * Map of env field name -> the plugin that owns it. Used by
   * {@link validateEnv} to attribute Zod issues to a plugin.
   */
  pluginOwnership: Map<string, string>;
}

export interface ValidateEnvError {
  /** Plugin owning the failing field, or `'core'` if from a base schema. */
  plugin: string;
  /** Dotted field path from Zod's issue (e.g. `MEMORY_MCP_URL`). */
  field: string;
  /** Human-readable message from Zod. */
  message: string;
}

export interface ValidateEnvResult {
  valid: boolean;
  /** Parsed config object — empty when `valid` is false. */
  config: Record<string, unknown>;
  errors: ValidateEnvError[];
}

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Fold every plugin's `configSchema` into a single Zod object via
 * `.extend()`. The returned `pluginOwnership` map records which plugin
 * contributed each top-level field so {@link validateEnv} can attribute
 * Zod issues by plugin.
 *
 * Conflict policy: later wins. When two plugins declare the same field,
 * the later definition replaces the earlier one and a warning is emitted
 * via the supplied logger naming both plugins.
 */
export function composeEnvSchema(
  plugins: OraclePlugin[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseSchema?: z.ZodObject<any>,
  logger: Logger = NOOP_LOGGER,
): ComposeEnvSchemaResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let merged: z.ZodObject<any> = baseSchema ?? z.object({});
  const pluginOwnership = new Map<string, string>();

  if (baseSchema) {
    for (const key of Object.keys(baseSchema.shape)) {
      pluginOwnership.set(key, 'core');
    }
  }

  for (const plugin of plugins) {
    if (!plugin.configSchema) continue;
    const shape = plugin.configSchema.shape as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
      const previous = pluginOwnership.get(key);
      if (previous !== undefined && previous !== plugin.name) {
        logger.warn(
          `[boot] env key '${key}' is defined by both '${previous}' and '${plugin.name}'; '${plugin.name}' wins.`,
        );
      }
      pluginOwnership.set(key, plugin.name);
    }
    merged = merged.extend(shape);
  }

  return { schema: merged, pluginOwnership };
}

/**
 * Validate `env` against the merged schema and produce structured errors
 * naming the owning plugin per failing field.
 *
 * On success, `config` holds the parsed object (with any Zod
 * coercions/defaults applied). On failure, `config` is empty and every
 * Zod issue is mapped through `pluginOwnership` to find the owner.
 */
export function validateEnv(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>,
  env: NodeJS.ProcessEnv,
  pluginOwnership: Map<string, string>,
): ValidateEnvResult {
  const result = schema.safeParse(env);
  if (result.success) {
    return { valid: true, config: result.data, errors: [] };
  }

  const errors: ValidateEnvError[] = result.error.issues.map((issue) => {
    const topField = issue.path.length > 0 ? String(issue.path[0]) : '<root>';
    const fullField = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    const plugin = pluginOwnership.get(topField) ?? 'unknown';
    return { plugin, field: fullField, message: issue.message };
  });

  return { valid: false, config: {}, errors };
}
