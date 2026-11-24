/**
 * The wire contract of IXO Traces ingest, copied from the service
 * (`ixoworld/ixo-langsmith-traces`, `src/contracts/turn.ts`). The service
 * validates every request against its own schema; this copy holds the types
 * and limits the sender needs, so a turn the tracer builds is accepted.
 * Keep the two in step: a contract change there is a change here.
 *
 *   POST /v1/ingest/turns        gzip JSON (`Content-Encoding: gzip`), one finished turn
 *   POST /v1/ingest/turns/start  plain JSON, the optional "turn started" marker
 *
 * Both carry the write key in `x-api-key`. The project comes from the key,
 * never from the body (a `project` field is rejected).
 */

export const TURN_LIMITS = {
  maxCompressedBytes: 8 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxRuns: 5_000,
  maxIdLength: 256,
  maxNameLength: 256,
  maxErrorLength: 16 * 1024,
  maxDottedOrderLength: 8 * 1024,
  maxMetadataKeys: 64,
  maxMetadataKeyLength: 64,
  maxMetadataValueLength: 1024,
  maxTags: 32,
  maxTagLength: 128,
  maxEventsPerRun: 2_000,
  maxPreviewTextLength: 8_000,
} as const;

export const RUN_TYPES = [
  'llm',
  'chain',
  'tool',
  'retriever',
  'embedding',
  'prompt',
  'parser',
] as const;
export type RunType = (typeof RUN_TYPES)[number];

export type TurnStatus = 'success' | 'error' | 'interrupted';

/** Turn-level metadata keys the service reads (values are strings). */
export const TURN_METADATA_KEYS = {
  oracleDid: 'oracle_did',
  network: 'network',
  channel: 'channel',
  runtimeVersion: 'runtime_version',
  servedModel: 'served_model',
  fallback: 'fallback',
} as const;

/** Keys inside an LLM run's `extra.metadata` the service reads (JSON values). */
export const RUN_METADATA_KEYS = {
  servedModel: 'served_model',
  fallback: 'fallback',
  requestedModel: 'ls_model_name',
} as const;

/** Turn metadata keys are `[A-Za-z0-9_.:-]`, at most 64 characters. */
export const METADATA_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** One run, LangSmith's v1 Run field names. */
export interface IngestRun {
  id: string;
  trace_id: string;
  parent_run_id: string | null;
  dotted_order: string;
  name: string;
  run_type: RunType;
  start_time: string;
  end_time: string | null;
  status: 'success' | 'error' | 'pending';
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
  error?: string | null;
  extra?: Record<string, unknown> | null;
  tags?: string[];
  events?: Record<string, unknown>[];
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
  first_token_time?: string | null;
}

export interface TurnUsage {
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/** The finished turn. */
export interface IngestTurn {
  v: 1;
  trace_id: string;
  thread_id: string;
  user_id: string;
  start_time: string;
  end_time: string;
  status: TurnStatus;
  error: string | null;
  name: string;
  metadata: Record<string, string>;
  tags: string[];
  usage: TurnUsage;
  user_text: string | null;
  reply_text: string | null;
  runs: IngestRun[];
}

/** The "turn started" marker: `start_time` equals the finished turn's. */
export interface IngestTurnStart {
  v: 1;
  trace_id: string;
  thread_id: string;
  user_id: string;
  start_time: string;
  name: string;
}
