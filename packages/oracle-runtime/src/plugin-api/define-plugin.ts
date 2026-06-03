import type { OraclePlugin } from './oracle-plugin.js';

/**
 * Input shape accepted by `defineOraclePlugin`. The three identity fields
 * (`name`, `version`, `manifest`) are required; every other plugin method
 * is optional.
 */
export type DefineOraclePluginInput = Partial<OraclePlugin> &
  Pick<OraclePlugin, 'name' | 'version' | 'manifest'>;

/**
 * Identity-style helper for authoring a plugin as a plain object.
 *
 * Returns the same object the caller passed in, narrowed to `OraclePlugin`
 * so type errors surface at the authoring site. The runtime treats the
 * resulting POJO interchangeably with a class instance extending
 * `OraclePlugin`.
 *
 * @throws TypeError when `name`, `version`, or `manifest` is missing.
 */
export function defineOraclePlugin(
  spec: DefineOraclePluginInput,
): OraclePlugin {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError(
      'defineOraclePlugin(spec): `spec` must be a plugin definition object.',
    );
  }
  if (!spec.name || typeof spec.name !== 'string') {
    throw new TypeError(
      'defineOraclePlugin(spec): `name` is required and must be a non-empty string.',
    );
  }
  if (!spec.version || typeof spec.version !== 'string') {
    throw new TypeError(
      'defineOraclePlugin(spec): `version` is required and must be a non-empty string.',
    );
  }
  if (!spec.manifest || typeof spec.manifest !== 'object') {
    throw new TypeError(
      'defineOraclePlugin(spec): `manifest` is required and must be an object.',
    );
  }
  return spec;
}
