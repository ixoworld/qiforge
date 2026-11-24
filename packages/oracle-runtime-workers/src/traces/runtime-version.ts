/**
 * The published version of this runtime, reported as `runtime_version` on
 * every turn trace. Kept equal to package.json by the root `version` script
 * (`scripts/sync-runtime-version.mjs`, after `changeset version`);
 * `runtime-version.test.ts` fails when they differ.
 */
export const RUNTIME_VERSION = '0.60.0';
