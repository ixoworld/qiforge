export { EvalsPlugin } from './evals.plugin.js';
export {
  asRecord,
  EvalsEngineClient,
  isEvalsApiError,
  jobVerdict,
  labelOutcome,
} from './evals-client.js';
export type {
  EvalsApiError,
  EvalsApiResult,
  EvalsClientOptions,
  EvaluationAccepted,
  EvaluationJob,
  ClaimStatus,
  UdidReceipt,
} from './evals-client.js';
export { createEvalsTools } from './evals-tools.js';
export { createEvalsSubAgent } from './evals-agent.js';
export {
  captureTrace,
  matrixEventUri,
  serializeToolCallTrace,
  TRACE_EVENT_KEY,
} from './evals-trace.js';
export type {
  AgentTraceDocument,
  TraceCaptureResult,
  TraceRef,
  TraceToolCall,
} from './evals-trace.js';
export {
  buildEvidenceEnvelope,
  buildEvidencePacket,
  buildStructuredFact,
  FACT_PACKET_MEDIA_TYPE,
  sourceSnapshotSchema,
  structuredFactPacketSchema,
  structuredFactSchema,
} from './evals-evidence.js';
export type {
  BuildEnvelopeInput,
  BuildFactInput,
  BuildPacketInput,
  SourceSnapshot,
  StructuredFact,
  StructuredFactPacket,
} from './evals-evidence.js';
export {
  canonicalJsonString,
  cidV1RawSha256,
  cidV1RawSha256Utf8,
  sha256DigestOfCanonicalJson,
} from './content-cid.js';
export {
  createVerifiedWorkGateFromEnv,
  createVerifiedWorkSubmitterFromEnv,
  matrixVerifiedWorkPoster,
  resolveVerifiedWorkSettings,
  VERIFIED_WORK_GATE,
  VERIFIED_WORK_SUBMITTER,
  VerifiedWorkGate,
  VerifiedWorkLedger,
  VerifiedWorkSubmitter,
} from './verified-work.js';
export type {
  CompletedTaskRun,
  SettlementVerdict,
  VerifiedWorkClient,
  VerifiedWorkEntry,
  VerifiedWorkEnvSource,
  VerifiedWorkPoster,
  VerifiedWorkRedis,
  VerifiedWorkSettings,
} from './verified-work.js';
