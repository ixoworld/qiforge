/**
 * DEPRECATED — `@ixo/oracle-runtime/testing` belongs to the Node runtime,
 * which is no longer developed. The Workers runtime
 * (`@ixo/oracle-runtime-workers`) tests plugins with its own `test:core`
 * and workerd suites; see `packages/oracle-runtime-workers/docs/testing.md`.
 */
export {
  createTestRuntime,
  type CreateTestRuntimeOptions,
  type TestRuntime,
  type CapabilityListing,
} from './create-test-runtime.js';

export {
  mockResponse,
  mockMatrix,
  mockLlm,
  mockDecisionAdapter,
  mockSecrets,
  mockBlobStore,
  mockEmit,
  mockUcan,
  mockLogger,
  type MockResponseLike,
  type MockResponseInit,
  type MockMatrixOverrides,
  type MockLlmOptions,
  type MockDecisionOptions,
  type FetchHandler,
} from './mocks.js';

// Convenience re-exports — keep authors on one import path.
export {
  makePlugin,
  makeManifest,
  makeTool,
  makeSubAgent,
  makeMiddleware,
  makeBuildCtx,
  makeRuntimeContext,
  type TestPluginInit,
} from '../registries/test-fixtures.js';

export { makeConfig } from './nest-doubles.js';
