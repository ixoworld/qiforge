import type { z } from 'zod';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';

/** A collected configSchema tagged with the plugin that contributed it. */
export interface RegisteredConfigSchema {
  pluginName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>;
}

/**
 * Stores plugin-owned `configSchema` objects in registration order. The
 * actual Zod merge — collision detection, plugin-ownership tracking, env
 * validation — lives in `bootstrap/schema-composer.ts` via
 * `composeEnvSchema()` so the merge logic exists in exactly one place.
 */
export class ConfigSchemaRegistry {
  private readonly entries: RegisteredConfigSchema[] = [];

  register(plugin: OraclePlugin): void {
    if (!plugin.configSchema) return;
    this.entries.push({
      pluginName: plugin.name,
      schema: plugin.configSchema,
    });
  }

  collect(): RegisteredConfigSchema[] {
    return [...this.entries];
  }

  /**
   * Config keys may collide intentionally (later wins, with warning), so
   * collision is not fatal. Provided for a uniform registry surface.
   */
  assertNoCollisions(): void {
    // intentional no-op
  }
}
