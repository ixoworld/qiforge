/**
 * Public surface for `@ixo/oracle-runtime/testing/integration`.
 *
 * Five exports total — anything else would be over-abstraction (see spec §6).
 * Tests skip via `test.skipIf(!process.env.X)`, sequence steps via plain
 * `await`s, and lean on the matchers `expect.extend(langchainMatchers)` adds
 * inside `setup.ts`. No DSLs.
 */
export {
  createIntegrationOracle,
  createIntegrationRuntime,
  type CreateIntegrationOracleOptions,
  type CreateIntegrationRuntimeOptions,
  type IntegrationOracle,
  type IntegrationRuntime,
  type IntegrationCapability,
} from './harness.js';

export {
  ChatClient,
  type ChatClientOptions,
  type SendOptions,
  type SendResult,
  type StreamOptions,
  type StreamFinal,
} from './chat-client.js';

export {
  mintUserDelegation,
  memoryCap,
  sandboxCap,
  skillsCap,
  subscriptionsReadCap,
  allCaps,
  type MintUserDelegationOptions,
} from './ucan.js';

export { waitForMatrixLoaded } from './wait-for-matrix-loaded.js';

// Typed SSE events — mirror of `packages/oracles-client-sdk/src/utils/sse-parser.ts`.
// Tests use these to type-narrow when asserting on streamed events:
//   for await (const evt of client.stream(sessionId, msg)) {
//     if (evt.event === 'tool_call') { evt.data.toolName }  // typed
//   }
export {
  parseSSEStream,
  type SSEEvent,
  type SSEMessageEventData,
  type SSEToolCallEventData,
  type SSEActionCallEventData,
  type SSEErrorEventData,
  type SSEDoneEventData,
  type SSERouterUpdateEventData,
  type SSERenderComponentEventData,
  type SSEBrowserToolCallEventData,
  type SSEMessageCacheInvalidationEventData,
  type SSEReasoningEventData,
} from './sse-parser.js';
