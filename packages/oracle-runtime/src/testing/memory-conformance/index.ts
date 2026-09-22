/**
 * Public surface for `@ixo/oracle-runtime/testing/memory-conformance`.
 *
 * Verifies an implementation of the Memory Engine Contract v1
 * (`specs/memory-engine-contract-v1.md`). Point it at a live engine with
 * `HttpMemoryEngineProbe`, or at your own implementation by satisfying
 * `MemoryEngineProbe`.
 *
 *   const probe = new HttpMemoryEngineProbe({ mcpUrl, restUrl });
 *   const report = await runConformance(probe, ctx);
 *   console.log(formatReport(report));
 *   if (!report.coreConformant) process.exit(1);
 */
export {
  ALL_CHECKS,
  formatReport,
  runConformance,
  // Individual checks, for implementers iterating on one rule at a time.
  checkBatchArity,
  checkBatchPartialFailure,
  checkConfirmationInterlock,
  checkCrossUserIsolation,
  checkExpiredRejected,
  checkIngest,
  checkKnowledgeLevelScoping,
  checkOntologyAccepted,
  checkRequiredTools,
  checkRoomIdRequired,
  checkRoundTrip,
  checkStrategies,
  checkTemporalFilters,
  checkToolStability,
  checkToolsList,
  checkUnauthenticatedRejected,
  checkValidAccepted,
} from './checks.js';

export {
  HttpMemoryEngineProbe,
  type HttpMemoryEngineProbeOptions,
} from './http-probe.js';

export {
  mintMemoryInvocation,
  type MintMemoryInvocationOptions,
} from './mint-invocation.js';

export {
  ReferenceMemoryEngine,
  expiredReferenceInvocation,
  referenceInvocation,
  type ReferenceEngineDefects,
} from './reference-engine.js';

export {
  ONTOLOGY_SAMPLE,
  REQUIRED_TOOLS,
  SEARCH_STRATEGIES,
  type BatchQuery,
  type BatchSlot,
  type CheckResult,
  type CheckStatus,
  type ConformanceContext,
  type ConformanceLevel,
  type ConformanceReport,
  type IngestMessage,
  type MemoryEngineProbe,
  type ProbeAuth,
  type ProbeOutcome,
  type ProbeToolDescriptor,
  type RequiredTool,
} from './types.js';
