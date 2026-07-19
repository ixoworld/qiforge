import { z } from 'zod';
import { pluginPermissionsSchema } from '../kernel/permissions.js';
import type { ManifestExample, PluginManifest } from '../plugin-api/types.js';

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
  permissions: pluginPermissionsSchema.optional(),
  providesRequestGate: z.boolean().optional(),
});
