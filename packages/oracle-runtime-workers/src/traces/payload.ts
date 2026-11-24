/**
 * One turn's run tree → the IXO Traces wire body (gzip JSON), within the
 * contract's limits. Runs after the reply, inside `waitUntil`.
 *
 * What a run carries is what the LangSmith tracer uploads today: the same
 * collapsed graph state (`collapseTracedState`), the same signed-link
 * redaction (over everything sent: inputs, outputs, errors, metadata and the
 * turn's texts), no runtime block and no `process.env` values. Left out:
 * streamed-token events (never collected) and `serialized` (the class
 * description of each runnable).
 *
 * Every value goes through `traceJson` (json.ts): nothing LangChain hands
 * over can make the build throw or the service refuse the turn.
 *
 * Size, guaranteed: the turn sent is at most `maxInflatedBytes` of UTF-8
 * JSON (what the service measures after gunzip) and `maxCompressedBytes` of
 * gzip, both below the service's caps. Each payload (a run's inputs,
 * outputs, extra, metadata, events) is first measured, never serialized past
 * `maxPayloadChars`. When the turn does not fit, payloads are replaced by
 * `{"_truncated":{"chars":N}}` (events by `[]`; a run's metadata keeps its
 * model names and fallback flag) in `DROP_ORDER`, largest first within a
 * class; when every payload is dropped and it still does not fit, the last
 * runs (pre-order, so a parent is always kept before its children) are left
 * out. The root run and the turn's own fields always stay, and they alone
 * always fit. The turn's metadata says `truncated: "true"` with the counts.
 * Only what is kept is ever serialized, so the build holds about one turn's
 * worth of JSON, whatever the run tree holds.
 *
 * Usage: the turn's `usage` is every model call of the turn once: the model
 * runs of its tree (sub-agents included) and the calls made outside the
 * graph (`outsideCalls`: the capability router's Decision, attachment
 * extraction, and model calls made inside middleware hooks, which LangChain
 * gives no callbacks), which are also sent as `llm` runs under the root so
 * the runs add up to the usage.
 */
import type { Run } from '@langchain/core/tracers/base';
import { convertToDottedOrderFormat } from 'langsmith/run_trees';
import { collapseTracedState, redactSignedLinkText } from '../core/llm';
import {
  MODEL_CALL_PURPOSE_METADATA_KEY,
  purposeOfRun,
} from '../core/model-call-reporter';
import type { ModelCallRecord, ModelCallReport } from '../llm/model-call';
import {
  CONTRACT_VERSION,
  METADATA_KEY_PATTERN,
  RUN_METADATA_KEYS,
  RUN_TYPES,
  TURN_LIMITS,
  TURN_METADATA_KEYS,
  type RunType,
  type TurnStatus,
  type TurnUsage,
} from './contract';
import { traceJson } from './json';

/** What the tracer knows of the turn beyond its runs. */
export interface TurnContext {
  /** The chat / session id (LangGraph's `thread_id`). */
  threadId: string;
  /** The person's DID. */
  userId: string;
  /** The person's message as they sent it. */
  userText?: string;
  /**
   * Turn metadata the runtime adds (`oracle_did`, `network`, `channel`,
   * `runtime_version`, `request_id`). Undefined values are left out.
   */
  metadata: Record<string, string | undefined>;
}

export interface CollectedTurn {
  root: Run;
  status: TurnStatus;
  error: string | null;
  /** Epoch ms. */
  endTime: number;
  /** Call records of the model runs, by run id. */
  records: ReadonlyMap<string, ModelCallRecord>;
  /** First streamed token of a model run, epoch ms, by run id. */
  firstTokens: ReadonlyMap<string, number>;
  context: TurnContext;
  /**
   * Model calls of the turn that are not model runs of this tree (each
   * once: the tracer leaves out every call it saw as a run).
   */
  outsideCalls?: readonly ModelCallReport[];
}

export interface EncodeLimits {
  /** Gzip bytes the turn may take. */
  maxCompressedBytes: number;
  /** UTF-8 bytes of JSON the turn may take once inflated. */
  maxInflatedBytes: number;
  /** Characters of JSON one payload may hold. */
  maxPayloadChars: number;
  maxRuns: number;
}

/**
 * Below the contract's 8 MiB compressed / 16 MiB inflated limits with a
 * margin (512 KiB and 1 MiB), so a turn the tracer builds is always
 * accepted; a real turn is about 1 MiB of JSON (the prompts of its model
 * calls).
 */
export const DEFAULT_ENCODE_LIMITS: EncodeLimits = {
  maxCompressedBytes: TURN_LIMITS.maxCompressedBytes - 512 * 1024,
  maxInflatedBytes: TURN_LIMITS.maxDecompressedBytes - 1024 * 1024,
  maxPayloadChars: 4 * 1024 * 1024,
  maxRuns: TURN_LIMITS.maxRuns,
};

/** A run's metadata is kept whole up to this size, else replaced by a marker. */
const MAX_METADATA_CHARS = 64 * 1024;

/**
 * Nesting a payload may have: it sits at level 4 of the turn (turn, runs,
 * run, payload; a run's metadata at 5), and the service refuses a body
 * deeper than `maxJsonDepth`.
 */
const PAYLOAD_MAX_DEPTH = TURN_LIMITS.maxJsonDepth - 9;

/** JSON a run adds around its skeleton and payloads (`,"inputs":` …). */
const RUN_FRAME_CHARS = 48;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface EncodedTurn {
  bytes: Uint8Array;
  /** Uncompressed bytes. */
  rawBytes: number;
  runCount: number;
  /** Runs left out over `maxRuns`. */
  omittedRuns: number;
  /** Payloads replaced by a marker to fit. */
  droppedPayloads: number;
}

type SlotField = 'metadata' | 'extra' | 'inputs' | 'outputs' | 'events';

/**
 * Which payloads go first when a turn is too large (lower first, largest
 * first within one): the model calls' invocation params (tool schemas) and
 * prompts, the graph's intermediate state, the lifecycle events, then model
 * replies and tool results, then runs' metadata (its model names and
 * fallback flag stay), and the root's own payloads last.
 */
const DROP_ORDER = {
  llmExtra: 0,
  llmInputs: 1,
  chainInputs: 2,
  chainOutputs: 3,
  events: 4,
  llmOutputs: 5,
  toolOutputs: 6,
  toolInputs: 7,
  other: 8,
  metadata: 9,
  root: 10,
} as const;

interface Slot {
  field: SlotField;
  rank: number;
  /** What is serialized (already through the trace policy). */
  value: unknown;
  /** Exact JSON length of `value` (measured), or how far the walk got. */
  chars: number;
  /** Set once the payload is kept and serialized, or dropped (its marker). */
  json?: string;
  dropped: boolean;
  /** What replaces it when dropped. */
  marker: string;
}

interface FlatRun {
  run: Run;
  parentId: string | null;
  dottedOrder: string;
}

/** One run as it is sent: its skeleton (everything but payloads) and payloads. */
interface BuiltRun {
  /** `{…,"extra":{"metadata":` up to (excluding) the metadata JSON. */
  head: string;
  slots: {
    metadata: Slot;
    extra: Slot;
    inputs: Slot;
    outputs: Slot;
    events: Slot;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Epoch ms the service reads as a time (2001 to 2100: the service takes no
 * epoch-seconds-looking value and no year past four digits), else `fallback`.
 */
function validMs(ms: unknown, fallback: number): number {
  return typeof ms === 'number' &&
    Number.isFinite(ms) &&
    ms >= MIN_TIME_MS &&
    ms <= MAX_TIME_MS
    ? ms
    : fallback;
}

const MIN_TIME_MS = 1e12;
const MAX_TIME_MS = Date.UTC(2100, 0, 1);

function iso(ms: number): string {
  return new Date(validMs(ms, Date.now())).toISOString();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** A token count as the contract takes it: a whole number in [0, maxTokens]. */
export function tokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return 0;
  return Math.min(Math.round(value), TURN_LIMITS.maxTokens);
}

/** A cost as the contract takes it: USD in [0, maxCostUsd]. */
export function costUsd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return 0;
  return Math.min(value, TURN_LIMITS.maxCostUsd);
}

/** A thread or user id as the contract takes it: printable, 1–256 characters. */
export function contractId(value: string): string {
  const printable = clip(
    // eslint-disable-next-line no-control-regex
    value.replace(/[\u0000-\u001f\u007f]/g, ''),
    TURN_LIMITS.maxIdLength,
  );
  return printable.length > 0 ? printable : 'unknown';
}

function truncatedMarker(chars: number): string {
  return `{"_truncated":{"chars":${Math.max(0, Math.round(chars))}}}`;
}

/** `value` as a JSON object payload: a non-object is wrapped as `{ value }`. */
function objectPayload(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (
    isRecord(value) &&
    !(value instanceof Map) &&
    !(value instanceof Set) &&
    !(value instanceof Error) &&
    !(value instanceof Date) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer) &&
    typeof Reflect.get(value, 'toJSON') !== 'function'
  )
    return value;
  return { value };
}

/** A run's events as the contract takes them: at most the cap, each an object. */
function eventsPayload(events: unknown): unknown[] {
  if (!Array.isArray(events)) return [];
  return events
    .slice(0, TURN_LIMITS.maxEventsPerRun)
    .map((event: unknown) => (isRecord(event) ? event : { value: event }));
}

/**
 * Runs in pre-order (a parent before its children), at most `maxRuns`. A run
 * is left out, with its subtree, when it cannot be sent: an id that is not a
 * UUID, an id already taken, or a `dotted_order` past the contract's length
 * (a nesting too deep). `omitted` counts every run of the tree not listed.
 */
function flattenRuns(
  root: Run,
  maxRuns: number,
): { runs: FlatRun[]; omitted: number } {
  const runs: FlatRun[] = [];
  const ids = new Set<string>();
  let total = 0;
  const pending: Array<{ run: Run; parent: FlatRun | null; top: boolean }> = [
    { run: root, parent: null, top: true },
  ];
  while (pending.length > 0) {
    const { run, parent, top } = pending.pop()!;
    total += 1;
    const children = [...(run.child_runs ?? [])];
    let flat: FlatRun | null = null;
    if (
      runs.length < maxRuns &&
      typeof run.id === 'string' &&
      UUID_PATTERN.test(run.id) &&
      !ids.has(run.id.toLowerCase()) &&
      (parent !== null || top)
    ) {
      const segment = convertToDottedOrderFormat(
        validMs(run.start_time, Date.now()),
        run.id,
        typeof run.execution_order === 'number' ? run.execution_order : 1,
      ).dottedOrder;
      const own =
        parent === null
          ? typeof run.dotted_order === 'string' && run.dotted_order.length > 0
            ? run.dotted_order
            : segment
          : typeof run.dotted_order === 'string' &&
              run.dotted_order.startsWith(`${parent.dottedOrder}.`)
            ? run.dotted_order
            : `${parent.dottedOrder}.${segment}`;
      if (own.length <= TURN_LIMITS.maxDottedOrderLength) {
        flat = { run, parentId: parent?.run.id ?? null, dottedOrder: own };
        ids.add(run.id.toLowerCase());
        runs.push(flat);
      }
    }
    // Reverse, so the earliest child is visited first. The subtree of a run
    // left out is walked only to be counted (`parent` stays null for it).
    children.sort(
      (a, b) =>
        validMs(b.start_time, 0) - validMs(a.start_time, 0) ||
        (b.execution_order ?? 0) - (a.execution_order ?? 0),
    );
    for (const child of children)
      pending.push({ run: child, parent: flat, top: false });
  }
  return { runs, omitted: total - runs.length };
}

/** The trace policy LangChain keeps on a run's `extra` (`Runnable.withConfig`). */
const TRACE_POLICY_KEY = Symbol.for('langchain.trace_policy');

function applyPolicy(
  run: Run,
  which: 'processInputs' | 'processOutputs',
  value: Record<string, unknown> | undefined,
): unknown {
  if (value === undefined) return undefined;
  const policy: unknown = isRecord(run.extra)
    ? Reflect.get(run.extra, TRACE_POLICY_KEY)
    : undefined;
  const processor: unknown = isRecord(policy) ? policy[which] : undefined;
  let processed: unknown = value;
  if (typeof processor === 'function') {
    try {
      processed = processor(value);
    } catch {
      return {};
    }
  }
  return isRecord(processed) ? collapseTracedState(processed) : processed;
}

function rankOf(run: Run, field: SlotField, isRoot: boolean): number {
  if (isRoot) return DROP_ORDER.root;
  if (field === 'events') return DROP_ORDER.events;
  if (field === 'metadata') return DROP_ORDER.metadata;
  switch (run.run_type) {
    case 'llm':
      return field === 'extra'
        ? DROP_ORDER.llmExtra
        : field === 'inputs'
          ? DROP_ORDER.llmInputs
          : DROP_ORDER.llmOutputs;
    case 'chain':
      return field === 'inputs'
        ? DROP_ORDER.chainInputs
        : field === 'outputs'
          ? DROP_ORDER.chainOutputs
          : DROP_ORDER.other;
    case 'tool':
      return field === 'inputs'
        ? DROP_ORDER.toolInputs
        : field === 'outputs'
          ? DROP_ORDER.toolOutputs
          : DROP_ORDER.other;
    default:
      return DROP_ORDER.other;
  }
}

function runTypeOf(value: string): RunType {
  return RUN_TYPES.find((type) => type === value) ?? 'chain';
}

/** Summed usage metadata of an LLM result's reply messages (as LangChainTracer adds it). */
function usageMetadataOf(outputs: unknown): Record<string, number> | undefined {
  if (!isRecord(outputs) || !Array.isArray(outputs.generations))
    return undefined;
  const sum: Record<string, number> = {};
  let found = false;
  for (const batch of outputs.generations) {
    if (!Array.isArray(batch)) continue;
    for (const generation of batch) {
      const message: unknown = isRecord(generation)
        ? generation.message
        : undefined;
      const usage: unknown = isRecord(message)
        ? Reflect.get(message, 'usage_metadata')
        : undefined;
      if (!isRecord(usage)) continue;
      for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
        const value = usage[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          sum[key] = (sum[key] ?? 0) + value;
          found = true;
        }
      }
    }
  }
  return found ? sum : undefined;
}

/** The extra of a run as sent: metadata (with the call record's model facts) and the rest. */
function extraParts(
  run: Run,
  record: ModelCallRecord | undefined,
): {
  metadata: Record<string, unknown> | undefined;
  rest: Record<string, unknown>;
} {
  const extra = isRecord(run.extra) ? run.extra : {};
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(extra)) {
    // The runtime block LangSmith's tracer adds is never sent.
    if (key === 'metadata' || key === 'runtime') continue;
    rest[key] = extra[key];
  }
  let metadata = isRecord(extra.metadata) ? extra.metadata : undefined;
  if (run.run_type === 'llm') {
    const usage = usageMetadataOf(run.outputs);
    metadata = {
      ...metadata,
      ...(usage ? { usage_metadata: usage } : {}),
      ...(record?.servedModel
        ? { [RUN_METADATA_KEYS.servedModel]: record.servedModel }
        : {}),
      ...(record ? { [RUN_METADATA_KEYS.fallback]: record.fallback } : {}),
    };
  }
  return { metadata, rest };
}

function messageType(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const getType: unknown = Reflect.get(message, '_getType');
  if (typeof getType === 'function') {
    try {
      const type: unknown = getType.call(message);
      if (typeof type === 'string') return type;
    } catch {
      // Fall through to the plain field.
    }
  }
  const type: unknown = Reflect.get(message, 'type');
  return typeof type === 'string' ? type : undefined;
}

/** The plain text of a message's content (strings and text parts). */
function messageText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content: unknown = Reflect.get(message, 'content');
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part: unknown) =>
      typeof part === 'string'
        ? part
        : isRecord(part) &&
            part.type === 'text' &&
            typeof part.text === 'string'
          ? part.text
          : '',
    )
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function lastMessageText(values: unknown, type: 'ai' | 'human'): string | null {
  const messages: unknown = isRecord(values) ? values.messages : undefined;
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (messageType(message) !== type) continue;
    const text = messageText(message);
    if (text !== undefined && text.trim().length > 0) return text;
  }
  return null;
}

function previewText(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text.length === 0) return null;
  return redactSignedLinkText(clip(text, TURN_LIMITS.maxPreviewTextLength));
}

/** Usage summed over the turn's model calls, from the same records `onModelCall` gets. */
export function turnUsageOf(records: Iterable<ModelCallRecord>): TurnUsage {
  const usage: TurnUsage = {
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  for (const record of records) {
    usage.input_tokens += tokenCount(record.promptTokens);
    usage.cached_tokens += tokenCount(record.cachedTokens);
    usage.output_tokens += tokenCount(record.outputTokens);
    usage.cost_usd += costUsd(record.costUsd);
  }
  return {
    input_tokens: tokenCount(usage.input_tokens),
    cached_tokens: tokenCount(usage.cached_tokens),
    output_tokens: tokenCount(usage.output_tokens),
    cost_usd: costUsd(usage.cost_usd),
  };
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** Turn metadata: the runtime's keys first, then the root run's scalar metadata. */
function turnMetadataOf(
  root: Run,
  own: Record<string, string | undefined>,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  const put = (key: string, value: string | undefined): void => {
    if (value === undefined || key in metadata) return;
    if (!METADATA_KEY_PATTERN.test(key)) return;
    if (Object.keys(metadata).length >= TURN_LIMITS.maxMetadataKeys) return;
    metadata[key] = redactSignedLinkText(
      clip(value, TURN_LIMITS.maxMetadataValueLength),
    );
  };
  for (const [key, value] of Object.entries(own)) put(key, value);
  const rootMetadata =
    isRecord(root.extra) && isRecord(root.extra.metadata)
      ? root.extra.metadata
      : {};
  for (const [key, value] of Object.entries(rootMetadata))
    put(key, scalarString(value));
  return metadata;
}

function tagsOf(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (
      typeof tag !== 'string' ||
      tag.length === 0 ||
      tag.length > TURN_LIMITS.maxTagLength
    )
      continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= TURN_LIMITS.maxTags) break;
  }
  return out;
}

function nameOf(run: Run): string {
  const name =
    typeof run.name === 'string' && run.name.length > 0
      ? run.name
      : run.run_type || 'run';
  return clip(name, TURN_LIMITS.maxNameLength);
}

function errorText(error: unknown): string | null {
  if (typeof error !== 'string' || error.length === 0) return null;
  return redactSignedLinkText(clip(error, TURN_LIMITS.maxErrorLength));
}

/** Gzip `pieces` (written in chunks, never joined whole). */
async function gzipPieces(
  pieces: readonly string[],
): Promise<{ bytes: Uint8Array; rawBytes: number }> {
  const stream = new CompressionStream('gzip');
  const result = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  let rawBytes = 0;
  let buffer = '';
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const chunk = encoder.encode(buffer);
    buffer = '';
    rawBytes += chunk.byteLength;
    await writer.write(chunk);
  };
  for (const piece of pieces) {
    buffer += piece;
    if (buffer.length >= 64 * 1024) await flush();
  }
  await flush();
  await writer.close();
  return { bytes: new Uint8Array(await result), rawBytes };
}

/** A run's numbers (LangSmith names) from its call record. */
function usageFields(
  record: ModelCallRecord | undefined,
): Record<string, number> {
  if (!record) return {};
  const fields: Record<string, number> = {};
  const prompt =
    record.promptTokens !== undefined
      ? tokenCount(record.promptTokens)
      : undefined;
  const completion =
    record.outputTokens !== undefined
      ? tokenCount(record.outputTokens)
      : undefined;
  if (prompt !== undefined) fields.prompt_tokens = prompt;
  if (completion !== undefined) fields.completion_tokens = completion;
  if (prompt !== undefined || completion !== undefined)
    fields.total_tokens = tokenCount((prompt ?? 0) + (completion ?? 0));
  if (record.costUsd !== undefined) fields.total_cost = costUsd(record.costUsd);
  return fields;
}

/** What a run's metadata keeps when it is dropped: model names, fallback, purpose. */
function essentialMetadata(metadata: unknown): Record<string, unknown> {
  if (!isRecord(metadata)) return {};
  const kept: Record<string, unknown> = {};
  for (const key of [
    RUN_METADATA_KEYS.servedModel,
    RUN_METADATA_KEYS.requestedModel,
    RUN_METADATA_KEYS.fallback,
    MODEL_CALL_PURPOSE_METADATA_KEY,
  ]) {
    let value: unknown;
    try {
      value = Reflect.get(metadata, key);
    } catch {
      continue;
    }
    if (typeof value === 'string') kept[key] = clip(value, 256);
    else if (typeof value === 'boolean') kept[key] = value;
  }
  return kept;
}

/** A payload, measured (never serialized past its cap). */
function makeSlot(
  field: SlotField,
  rank: number,
  value: unknown,
  maxChars: number,
  markerOf: (chars: number) => string,
): Slot {
  const measured = traceJson(value, {
    maxChars,
    maxDepth: PAYLOAD_MAX_DEPTH,
    measureOnly: true,
  });
  const marker = markerOf(measured.chars);
  if (measured.tooLarge)
    return {
      field,
      rank,
      value: undefined,
      chars: measured.chars,
      json: marker,
      dropped: true,
      marker,
    };
  return { field, rank, value, chars: measured.chars, dropped: false, marker };
}

/** The JSON of a kept payload, in the shape its field must have. */
function slotJson(slot: Slot, maxChars: number): string {
  if (slot.json !== undefined) return slot.json;
  const built = traceJson(slot.value, {
    maxChars,
    maxDepth: PAYLOAD_MAX_DEPTH,
  });
  let json = built.tooLarge ? slot.marker : built.json;
  if (slot.field === 'events') {
    if (!json.startsWith('[')) json = '[]';
  } else if (
    !json.startsWith('{') &&
    !(json === 'null' && slot.field !== 'extra' && slot.field !== 'metadata')
  )
    json = slot.field === 'inputs' || slot.field === 'outputs' ? 'null' : '{}';
  slot.json = json;
  slot.value = undefined;
  return json;
}

function slotChars(slot: Slot): number {
  return slot.dropped ? slot.marker.length : (slot.json?.length ?? slot.chars);
}

interface BuildContext {
  root: Run;
  records: ReadonlyMap<string, ModelCallRecord>;
  firstTokens: ReadonlyMap<string, number>;
  limits: EncodeLimits;
}

function builtRun(
  head: Record<string, unknown>,
  parts: {
    metadata: unknown;
    rest: Record<string, unknown>;
    inputs: unknown;
    outputs: unknown;
    events: unknown[];
  },
  rankFor: (field: SlotField) => number,
  limits: EncodeLimits,
): BuiltRun {
  const json = JSON.stringify(head);
  const essentials = essentialMetadata(parts.metadata);
  const payload = (field: SlotField, value: unknown): Slot =>
    makeSlot(field, rankFor(field), value, limits.maxPayloadChars, (chars) =>
      field === 'events' ? '[]' : truncatedMarker(chars),
    );
  return {
    head: `${json.slice(0, -1)},"extra":{"metadata":`,
    slots: {
      metadata: makeSlot(
        'metadata',
        rankFor('metadata'),
        parts.metadata ?? {},
        MAX_METADATA_CHARS,
        (chars) =>
          JSON.stringify({
            _truncated: { chars: Math.round(chars) },
            ...essentials,
          }),
      ),
      extra: payload('extra', parts.rest),
      inputs: payload('inputs', parts.inputs),
      outputs: payload('outputs', parts.outputs),
      events: payload('events', parts.events),
    },
  };
}

/** One run of the tree, as sent. */
function treeRun(flat: FlatRun, ctx: BuildContext): BuiltRun {
  const { run, parentId, dottedOrder } = flat;
  const isRoot = parentId === null;
  const record = run.run_type === 'llm' ? ctx.records.get(run.id) : undefined;
  const firstToken = ctx.firstTokens.get(run.id);
  const error = errorText(run.error);
  const start = validMs(
    run.start_time,
    validMs(ctx.root.start_time, Date.now()),
  );
  const end =
    run.end_time === undefined ? undefined : validMs(run.end_time, start);
  const { metadata, rest } = extraParts(run, record);
  return builtRun(
    {
      id: run.id.toLowerCase(),
      trace_id: ctx.root.id.toLowerCase(),
      parent_run_id: parentId?.toLowerCase() ?? null,
      dotted_order: dottedOrder,
      name: nameOf(run),
      run_type: runTypeOf(run.run_type),
      start_time: iso(start),
      end_time: end !== undefined ? iso(end) : null,
      status:
        error !== null ? 'error' : end !== undefined ? 'success' : 'pending',
      error,
      tags: tagsOf(run.tags),
      ...(firstToken !== undefined
        ? { first_token_time: iso(validMs(firstToken, start)) }
        : {}),
      ...usageFields(record),
    },
    {
      metadata,
      rest,
      inputs: objectPayload(applyPolicy(run, 'processInputs', run.inputs)),
      outputs: objectPayload(applyPolicy(run, 'processOutputs', run.outputs)),
      events: eventsPayload(run.events),
    },
    (field) => rankOf(run, field, isRoot),
    ctx.limits,
  );
}

/** A model call made outside the graph, as an `llm` run under the root. */
function outsideRun(
  call: ModelCallReport,
  id: string,
  rootDottedOrder: string,
  ctx: BuildContext,
): BuiltRun {
  const start = validMs(
    call.startedAt,
    validMs(ctx.root.start_time, Date.now()),
  );
  const end = start + Math.max(0, validMs(call.durationMs, 0));
  const failed = call.ok === false;
  return builtRun(
    {
      id,
      trace_id: ctx.root.id.toLowerCase(),
      parent_run_id: ctx.root.id.toLowerCase(),
      dotted_order: `${rootDottedOrder}.${convertToDottedOrderFormat(start, id, 1).dottedOrder}`,
      name: clip(`${call.purpose} model call`, TURN_LIMITS.maxNameLength),
      run_type: 'llm',
      start_time: iso(start),
      end_time: iso(end),
      status: failed ? 'error' : 'success',
      error: failed ? clip(call.errorKind ?? 'error', 256) : null,
      tags: tagsOf([`purpose:${call.purpose}`, 'outside_graph']),
      ...usageFields(call),
    },
    {
      metadata: {
        [RUN_METADATA_KEYS.requestedModel]: call.requestedModel,
        ...(call.servedModel
          ? { [RUN_METADATA_KEYS.servedModel]: call.servedModel }
          : {}),
        [RUN_METADATA_KEYS.fallback]: call.fallback,
        [MODEL_CALL_PURPOSE_METADATA_KEY]: call.purpose,
        ...(call.provider ? { provider: call.provider } : {}),
      },
      rest: {},
      inputs: null,
      outputs: null,
      events: [],
    },
    () => DROP_ORDER.other,
    ctx.limits,
  );
}

function runPieces(built: BuiltRun, index: number, maxChars: number): string[] {
  const { metadata, extra, inputs, outputs, events } = built.slots;
  const rest = slotJson(extra, maxChars);
  return [
    `${index > 0 ? ',' : ''}${built.head}${slotJson(metadata, MAX_METADATA_CHARS)}${rest === '{}' ? '' : `,${rest.slice(1, -1)}`}}`,
    `,"inputs":${slotJson(inputs, maxChars)},"outputs":${slotJson(outputs, maxChars)},"events":${slotJson(events, maxChars)}}`,
  ];
}

function runChars(built: BuiltRun): number {
  const { metadata, extra, inputs, outputs, events } = built.slots;
  return (
    built.head.length +
    RUN_FRAME_CHARS +
    slotChars(metadata) +
    slotChars(extra) +
    slotChars(inputs) +
    slotChars(outputs) +
    slotChars(events)
  );
}

/** Rounds of gzip-and-check before the turn is cut to its root. */
const MAX_FIT_ROUNDS = 6;

/**
 * Build and gzip the turn. Undefined only when the root run cannot be sent
 * at all (its id is not a UUID) or the limits leave no room even for the
 * root alone (never with the default limits).
 */
export async function encodeTurn(
  turn: CollectedTurn,
  limits: EncodeLimits = DEFAULT_ENCODE_LIMITS,
): Promise<EncodedTurn | undefined> {
  const { root, records, firstTokens, context } = turn;
  const { runs: candidates, omitted: unsendable } = flattenRuns(
    root,
    limits.maxRuns,
  );
  if (candidates.length === 0) return undefined;
  const ctx: BuildContext = { root, records, firstTokens, limits };

  // Every model call of the tree counts once, also one of a run left out.
  const calls: Array<{ record: ModelCallRecord; purpose: string }> = [];
  const treeIds = new Set<string>();
  const pending: Run[] = [root];
  while (pending.length > 0) {
    const run = pending.pop()!;
    if (typeof run.id === 'string') treeIds.add(run.id.toLowerCase());
    const record = run.run_type === 'llm' ? records.get(run.id) : undefined;
    if (record) {
      const metadata =
        isRecord(run.extra) && isRecord(run.extra.metadata)
          ? run.extra.metadata
          : undefined;
      calls.push({ record, purpose: purposeOfRun(metadata) });
    }
    for (const child of run.child_runs ?? []) pending.push(child);
  }
  const outside: Array<{ call: ModelCallReport; id: string }> = [];
  for (const call of turn.outsideCalls ?? []) {
    const callId =
      typeof call.callId === 'string' ? call.callId.toLowerCase() : '';
    // A call that is a run of the tree is counted there.
    if (treeIds.has(callId)) continue;
    const id =
      UUID_PATTERN.test(callId) && !treeIds.has(callId)
        ? callId
        : crypto.randomUUID();
    treeIds.add(id);
    outside.push({ call, id });
    calls.push({ record: call, purpose: call.purpose });
  }
  const usage = turnUsageOf(calls.map((c) => c.record));
  let servedReply: string | undefined;
  let servedAny: string | undefined;
  for (const { record, purpose } of calls) {
    if (!record.servedModel) continue;
    servedAny = record.servedModel;
    if (purpose === 'reply') servedReply = record.servedModel;
  }
  const servedModel = servedReply ?? servedAny;
  const fallback = calls.some((c) => c.record.fallback);

  // Runs in pre-order, then the calls made outside the graph; the run
  // skeletons alone may take half the budget (the rest are left out).
  const built: BuiltRun[] = [];
  let omittedRuns = unsendable;
  let skeletonChars = 0;
  const skeletonBudget = limits.maxInflatedBytes / 2;
  const rootDotted = candidates[0]!.dottedOrder;
  const makers: Array<() => BuiltRun> = [
    ...candidates.map((flat) => () => treeRun(flat, ctx)),
    ...outside.slice(0, Math.max(0, limits.maxRuns - candidates.length)).map(
      ({ call, id }) =>
        () =>
          outsideRun(call, id, rootDotted, ctx),
    ),
  ];
  omittedRuns += Math.max(
    0,
    outside.length - (limits.maxRuns - candidates.length),
  );
  for (const [index, make] of makers.entries()) {
    const run = make();
    if (built.length > 0 && skeletonChars + run.head.length > skeletonBudget) {
      omittedRuns += makers.length - index;
      break;
    }
    skeletonChars += run.head.length;
    built.push(run);
  }

  const userText = previewText(
    context.userText ?? lastMessageText(root.inputs, 'human'),
  );
  const replyText =
    turn.status === 'success' || root.end_time !== undefined
      ? previewText(lastMessageText(root.outputs, 'ai'))
      : null;
  const turnStart = validMs(root.start_time, Date.now());

  const headOf = (droppedPayloads: number, omitted: number): string => {
    const truncated = droppedPayloads > 0 || omitted > 0;
    const head = JSON.stringify({
      v: CONTRACT_VERSION,
      trace_id: root.id.toLowerCase(),
      thread_id: contractId(context.threadId),
      user_id: contractId(context.userId),
      start_time: iso(turnStart),
      end_time: iso(Math.max(validMs(turn.endTime, turnStart), turnStart)),
      status: turn.status,
      error:
        turn.status === 'error'
          ? (errorText(turn.error) ?? 'error')
          : errorText(turn.error),
      name: nameOf(root),
      metadata: turnMetadataOf(root, {
        ...context.metadata,
        ...(servedModel
          ? { [TURN_METADATA_KEYS.servedModel]: servedModel }
          : {}),
        [TURN_METADATA_KEYS.fallback]: String(fallback),
        ...(truncated
          ? {
              truncated: 'true',
              ...(droppedPayloads > 0
                ? { truncated_payloads: String(droppedPayloads) }
                : {}),
              ...(omitted > 0 ? { omitted_runs: String(omitted) } : {}),
            }
          : {}),
      }),
      tags: tagsOf(root.tags),
      usage,
      user_text: userText,
      reply_text: replyText,
    });
    return `${head.slice(0, -1)},"runs":[`;
  };
  // The head's size with its truncation counts at their longest.
  const headChars = headOf(1e9, 1e9).length + 2;

  // Drop order over every payload of the runs kept (a slot knows its run).
  const order = built
    .flatMap((run, index) =>
      Object.values(run.slots).map((slot) => ({ slot, index })),
    )
    .sort((a, b) => a.slot.rank - b.slot.rank || b.slot.chars - a.slot.chars);
  let cursor = 0;
  let total = headChars + built.reduce((sum, run) => sum + runChars(run), 0);

  /** Drop payloads, then the last runs, until about `target` characters. */
  const shrink = (target: number): boolean => {
    let progressed = false;
    while (total > target) {
      if (cursor < order.length) {
        const { slot, index } = order[cursor++]!;
        if (index >= built.length || slot.dropped) continue;
        const before = slotChars(slot);
        if (before <= slot.marker.length) continue;
        slot.dropped = true;
        slot.json = slot.marker;
        slot.value = undefined;
        total -= before - slot.marker.length;
        progressed = true;
        continue;
      }
      if (built.length <= 1) break;
      total -= runChars(built.pop()!);
      omittedRuns += 1;
      progressed = true;
    }
    return progressed;
  };

  shrink(limits.maxInflatedBytes);
  for (let round = 0; round <= MAX_FIT_ROUNDS; round += 1) {
    if (round === MAX_FIT_ROUNDS) shrink(0);
    const droppedPayloads = built.reduce(
      (sum, run) =>
        sum + Object.values(run.slots).filter((slot) => slot.dropped).length,
      0,
    );
    const pieces = [
      headOf(droppedPayloads, omittedRuns),
      ...built.flatMap((run, index) =>
        runPieces(run, index, limits.maxPayloadChars),
      ),
      ']}',
    ];
    const chars = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const { bytes, rawBytes } = await gzipPieces(pieces);
    if (
      bytes.byteLength <= limits.maxCompressedBytes &&
      rawBytes <= limits.maxInflatedBytes
    )
      return {
        bytes,
        rawBytes,
        runCount: built.length,
        omittedRuns,
        droppedPayloads,
      };
    if (round === MAX_FIT_ROUNDS) return undefined;
    // Over a limit: cut by the excess, measured in characters of this
    // build, with a margin, and at least a tenth of what is left.
    total = chars;
    const overRaw = (rawBytes - limits.maxInflatedBytes) * (chars / rawBytes);
    const overGzip =
      (bytes.byteLength - limits.maxCompressedBytes) *
      (chars / Math.max(bytes.byteLength, 1));
    const cut = Math.max(overRaw, overGzip) * 1.1 + chars * 0.02;
    if (!shrink(Math.min(chars - cut, chars * 0.9)) && built.length <= 1)
      round = MAX_FIT_ROUNDS - 1;
  }
  return undefined;
}
