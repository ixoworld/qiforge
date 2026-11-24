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
 * Size: each payload (a run's inputs, outputs, extra, events) is serialized
 * once. One larger than `maxPayloadChars` is never serialized (its size is
 * walked with a bound first). When the turn is over the raw budget or its
 * gzip is over the compressed limit, payloads are replaced by
 * `{"_truncated":{"chars":N}}` (events by `[]`) in `DROP_ORDER`, largest
 * first within a class, until it fits; the turn's metadata then says
 * `truncated: "true"`. A run's `extra.metadata` (model names, served model,
 * fallback) and the run itself are never dropped.
 */
import type { Run } from '@langchain/core/tracers/base';
import { convertToDottedOrderFormat } from 'langsmith/run_trees';
import { collapseTracedState, redactSignedLinkText } from '../core/llm';
import { purposeOfRun } from '../core/model-call-reporter';
import type { ModelCallRecord } from '../llm/model-call';
import { stringify } from '../sqlite/serialization';
import {
  METADATA_KEY_PATTERN,
  RUN_METADATA_KEYS,
  RUN_TYPES,
  TURN_LIMITS,
  TURN_METADATA_KEYS,
  type RunType,
  type TurnStatus,
  type TurnUsage,
} from './contract';

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
}

export interface EncodeLimits {
  maxCompressedBytes: number;
  /** Characters of JSON a turn may hold before payloads are dropped. */
  rawBudgetChars: number;
  /** Characters of JSON one payload may hold. */
  maxPayloadChars: number;
  maxRuns: number;
}

/**
 * Below the contract's 8 MiB compressed / 64 MiB decompressed limits, with a
 * margin, and small enough that the build never holds more than a few times
 * `rawBudgetChars` next to a 128 MB isolate's turn: a real turn is about
 * 1 MiB of JSON (the prompts of its model calls).
 */
export const DEFAULT_ENCODE_LIMITS: EncodeLimits = {
  maxCompressedBytes: TURN_LIMITS.maxCompressedBytes - 512 * 1024,
  rawBudgetChars: 12 * 1024 * 1024,
  maxPayloadChars: 4 * 1024 * 1024,
  maxRuns: TURN_LIMITS.maxRuns,
};

/** A run's metadata is kept whole up to this size, else replaced by a marker. */
const MAX_METADATA_CHARS = 64 * 1024;

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

type SlotField = 'inputs' | 'outputs' | 'extra' | 'events';

/**
 * Which payloads go first when a turn is too large (lower first, largest
 * first within one): the model calls' invocation params (tool schemas) and
 * prompts, the graph's intermediate state, the lifecycle events, then model
 * replies and tool results, and the root's own inputs and outputs last.
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
  root: 9,
} as const;

interface Slot {
  field: SlotField;
  rank: number;
  json: string;
  dropped: boolean;
}

interface FlatRun {
  run: Run;
  parentId: string | null;
  dottedOrder: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Replacer for values plain `JSON.stringify` refuses or loses. */
function jsonReplacer(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof Error)
    return { name: value.name, message: value.message };
  return value;
}

/**
 * A bounded estimate of `value`'s JSON length: walks strings and keys
 * (through `toJSON`), and stops once past `limit`. Never serializes.
 */
export function approxJsonChars(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let total = 0;
  try {
    while (pending.length > 0) {
      if (total > limit) return total;
      const next = pending.pop();
      if (typeof next === 'string') {
        total += next.length + 2;
        continue;
      }
      if (next === null || typeof next !== 'object') {
        total += 6;
        continue;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      const toJSON: unknown = Reflect.get(next, 'toJSON');
      if (typeof toJSON === 'function') {
        pending.push(toJSON.call(next, ''));
        continue;
      }
      if (Array.isArray(next)) {
        total += 2 + next.length;
        for (const item of next) pending.push(item);
        continue;
      }
      for (const key of Object.keys(next)) {
        total += key.length + 4;
        pending.push(Reflect.get(next, key));
      }
    }
  } catch {
    return limit + 1;
  }
  return total;
}

/** `value` as JSON (an object, or `null`), redacted; a marker when too large. */
function payloadJson(
  value: unknown,
  maxChars: number,
): { json: string; tooLarge: boolean } {
  if (value === undefined || value === null)
    return { json: 'null', tooLarge: false };
  const estimate = approxJsonChars(value, maxChars);
  if (estimate > maxChars)
    return { json: truncatedMarker(estimate), tooLarge: true };
  const json = stringify(value, jsonReplacer);
  // `stringify` answers with a bare string when it cannot serialize.
  if (!json.startsWith('{') && !json.startsWith('['))
    return { json: '{}', tooLarge: false };
  return { json: redactSignedLinkText(json), tooLarge: false };
}

function truncatedMarker(chars: number): string {
  return `{"_truncated":{"chars":${Math.round(chars)}}}`;
}

/** Runs in pre-order (a parent before its children), at most `maxRuns`. */
function flattenRuns(
  root: Run,
  maxRuns: number,
): { runs: FlatRun[]; omitted: number } {
  const runs: FlatRun[] = [];
  let omitted = 0;
  const pending: Array<{ run: Run; parent: FlatRun | null }> = [
    { run: root, parent: null },
  ];
  while (pending.length > 0) {
    const { run, parent } = pending.pop()!;
    if (runs.length >= maxRuns) {
      omitted += 1;
      for (const child of run.child_runs ?? [])
        pending.push({ run: child, parent: null });
      continue;
    }
    const segment = convertToDottedOrderFormat(
      run.start_time,
      run.id,
      run.execution_order,
    ).dottedOrder;
    const own =
      parent === null
        ? (run.dotted_order ?? segment)
        : run.dotted_order?.startsWith(`${parent.dottedOrder}.`)
          ? run.dotted_order
          : `${parent.dottedOrder}.${segment}`;
    const flat: FlatRun = {
      run,
      parentId: parent?.run.id ?? null,
      dottedOrder: own,
    };
    runs.push(flat);
    // Reverse, so the earliest child is visited first.
    const children = [...(run.child_runs ?? [])].sort(
      (a, b) =>
        b.start_time - a.start_time || b.execution_order - a.execution_order,
    );
    for (const child of children) pending.push({ run: child, parent: flat });
  }
  return { runs, omitted };
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
    usage.input_tokens += record.promptTokens ?? 0;
    usage.cached_tokens += record.cachedTokens ?? 0;
    usage.output_tokens += record.outputTokens ?? 0;
    usage.cost_usd += record.costUsd ?? 0;
  }
  return usage;
}

/** The model that answered the turn: the last reply call's, else the last call's. */
function servedModelOf(
  runs: readonly FlatRun[],
  records: ReadonlyMap<string, ModelCallRecord>,
): string | undefined {
  let reply: string | undefined;
  let any: string | undefined;
  for (const { run } of runs) {
    const served = records.get(run.id)?.servedModel;
    if (!served) continue;
    any = served;
    const metadata =
      isRecord(run.extra) && isRecord(run.extra.metadata)
        ? run.extra.metadata
        : undefined;
    if (purposeOfRun(metadata) === 'reply') reply = served;
  }
  return reply ?? any;
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

/**
 * Build and gzip the turn. Undefined when it cannot fit the contract even
 * with every payload dropped.
 */
export async function encodeTurn(
  turn: CollectedTurn,
  limits: EncodeLimits = DEFAULT_ENCODE_LIMITS,
): Promise<EncodedTurn | undefined> {
  const { root, records, firstTokens, context } = turn;
  const { runs, omitted } = flattenRuns(root, limits.maxRuns);

  // Every model call of the tree counts, also one past the run cap.
  const allRecords: ModelCallRecord[] = [];
  const pending: Run[] = [root];
  while (pending.length > 0) {
    const run = pending.pop()!;
    const record = run.run_type === 'llm' ? records.get(run.id) : undefined;
    if (record) allRecords.push(record);
    for (const child of run.child_runs ?? []) pending.push(child);
  }
  const usage = turnUsageOf(allRecords);
  const servedModel = servedModelOf(runs, records);
  const fallback = allRecords.some((record) => record.fallback);

  const skeletons: string[] = [];
  const slots: Slot[][] = [];
  let tooLargePayloads = 0;
  for (const { run, parentId, dottedOrder } of runs) {
    const isRoot = parentId === null;
    const record = run.run_type === 'llm' ? records.get(run.id) : undefined;
    const firstToken = firstTokens.get(run.id);
    const error = errorText(run.error);
    const skeleton: Record<string, unknown> = {
      id: run.id,
      trace_id: root.id,
      parent_run_id: parentId,
      dotted_order: dottedOrder,
      name: nameOf(run),
      run_type: runTypeOf(run.run_type),
      start_time: iso(run.start_time),
      end_time: run.end_time !== undefined ? iso(run.end_time) : null,
      status:
        error !== null
          ? 'error'
          : run.end_time !== undefined
            ? 'success'
            : 'pending',
      error,
      tags: tagsOf(run.tags),
      ...(firstToken !== undefined
        ? { first_token_time: iso(firstToken) }
        : {}),
      ...(record
        ? {
            ...(record.promptTokens !== undefined
              ? { prompt_tokens: record.promptTokens }
              : {}),
            ...(record.outputTokens !== undefined
              ? { completion_tokens: record.outputTokens }
              : {}),
            ...(record.promptTokens !== undefined ||
            record.outputTokens !== undefined
              ? {
                  total_tokens:
                    (record.promptTokens ?? 0) + (record.outputTokens ?? 0),
                }
              : {}),
            ...(record.costUsd !== undefined
              ? { total_cost: record.costUsd }
              : {}),
          }
        : {}),
    };
    const { metadata, rest } = extraParts(run, record);
    const metadataJson = payloadJson(metadata ?? {}, MAX_METADATA_CHARS).json;
    const head = JSON.stringify(skeleton);
    // `…,"extra":{"metadata":M,<rest>}`: the rest is the droppable part.
    skeletons.push(`${head.slice(0, -1)},"extra":{"metadata":${metadataJson}`);
    const runSlots: Slot[] = [];
    const add = (field: SlotField, value: unknown, isArray = false): void => {
      const made = payloadJson(value, limits.maxPayloadChars);
      if (made.tooLarge) tooLargePayloads += 1;
      runSlots.push({
        field,
        rank: rankOf(run, field, isRoot),
        json: isArray && made.tooLarge ? '[]' : made.json,
        dropped: made.tooLarge,
      });
    };
    add('extra', rest);
    add('inputs', applyPolicy(run, 'processInputs', run.inputs));
    add('outputs', applyPolicy(run, 'processOutputs', run.outputs));
    add(
      'events',
      (run.events ?? []).slice(0, TURN_LIMITS.maxEventsPerRun),
      true,
    );
    slots.push(runSlots);
  }

  const order = slots
    .flat()
    .sort((a, b) => a.rank - b.rank || b.json.length - a.json.length);
  let cursor = 0;
  let droppedPayloads = tooLargePayloads;
  /** Drop payloads in order until about `chars` are freed; false when none was left. */
  const dropAbout = (chars: number): boolean => {
    let freed = 0;
    let any = false;
    while (freed < chars && cursor < order.length) {
      const slot = order[cursor++]!;
      if (slot.dropped) continue;
      const marker =
        slot.field === 'events' ? '[]' : truncatedMarker(slot.json.length);
      freed += slot.json.length - marker.length;
      slot.json = marker;
      slot.dropped = true;
      droppedPayloads += 1;
      any = true;
    }
    return any;
  };

  const userText = previewText(
    context.userText ?? lastMessageText(root.inputs, 'human'),
  );
  const replyText =
    turn.status === 'success' || root.end_time !== undefined
      ? previewText(lastMessageText(root.outputs, 'ai'))
      : null;

  const piecesOf = (): string[] => {
    const truncated = droppedPayloads > 0 || omitted > 0;
    const head = JSON.stringify({
      v: 1,
      trace_id: root.id,
      thread_id: clip(context.threadId, TURN_LIMITS.maxIdLength),
      user_id: clip(context.userId, TURN_LIMITS.maxIdLength),
      start_time: iso(root.start_time),
      end_time: iso(Math.max(turn.endTime, root.start_time)),
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
    const pieces: string[] = [`${head.slice(0, -1)},"runs":[`];
    runs.forEach((_, index) => {
      const [extra, inputs, outputs, events] = slots[index]!;
      const rest = extra!.json;
      pieces.push(
        `${index > 0 ? ',' : ''}${skeletons[index]}${rest === '{}' ? '' : `,${rest.slice(1, -1)}`}}`,
        `,"inputs":${inputs!.json},"outputs":${outputs!.json},"events":${events!.json}}`,
      );
    });
    pieces.push(']}');
    return pieces;
  };

  const totalChars = (): number =>
    skeletons.reduce((sum, s) => sum + s.length, 0) +
    slots.flat().reduce((sum, slot) => sum + slot.json.length, 0);

  const overBudget = totalChars() - limits.rawBudgetChars;
  if (
    overBudget > 0 &&
    !dropAbout(overBudget) &&
    totalChars() > limits.rawBudgetChars
  )
    return undefined;

  for (let round = 0; round < 8; round += 1) {
    const { bytes, rawBytes } = await gzipPieces(piecesOf());
    if (
      bytes.byteLength <= limits.maxCompressedBytes &&
      rawBytes <= TURN_LIMITS.maxDecompressedBytes
    )
      return {
        bytes,
        rawBytes,
        runCount: runs.length,
        omittedRuns: omitted,
        droppedPayloads,
      };
    const ratio = bytes.byteLength / Math.max(rawBytes, 1);
    const excessCompressed = bytes.byteLength - limits.maxCompressedBytes * 0.9;
    const excessRaw = rawBytes - TURN_LIMITS.maxDecompressedBytes * 0.9;
    const chars = Math.max(
      excessCompressed / Math.max(ratio, 1e-6),
      excessRaw,
      1,
    );
    if (!dropAbout(chars)) return undefined;
  }
  return undefined;
}
