/**
 * `TurnTracer`: collects every run of a turn through LangChain's tracer hook
 * (`BaseTracer` from `@langchain/core/tracers/base`, the base of
 * `LangChainTracer`: it keeps the run tree and calls `persistRun` with the
 * whole tree once the root run ends) and sends the finished turn to IXO
 * Traces once, plus a "turn started" marker when the root run starts.
 *
 * It never affects the turn:
 * - every callback does constant work (a map entry, a counter, keeping the
 *   references LangChain hands over; nothing is copied or serialized), and
 *   nothing it does throws into LangChain;
 * - streamed tokens are not collected (only the first token's time);
 * - a run past `TURN_LIMITS.maxRuns` keeps no inputs or outputs;
 * - the turn is built, gzipped and sent after `finish()` (the runtime calls
 *   it when the turn's reply is out), inside `waitUntil`, never awaited by the
 *   turn.
 *
 * A root run still open at `finish()` (an abort ends a stream without
 * LangChain ending its runs; handlers may also run in LangChain's background
 * queue a moment after the stream ended) gets `finishGraceMs` to end, and is
 * then sent as `interrupted` with its unfinished runs `pending`. If the
 * Durable Object dies mid-turn nothing of it survives in memory: the service
 * then holds only the start marker, which it reads as interrupted.
 */
import { BaseTracer, type Run } from '@langchain/core/tracers/base';
import type { NewTokenIndices } from '@langchain/core/callbacks/base';
import { inheritedByNestedRuns } from '../core/nested-run-callbacks';
import {
  awaitCallEnd,
  modelCallOf,
  type ModelCallRecord,
  type ModelCallReport,
} from '../llm/model-call';
import type { Logger } from '../plugin-api/types';
import type { TracesConfig } from './config';
import {
  CONTRACT_VERSION,
  TURN_LIMITS,
  TURN_METADATA_KEYS,
  type TurnStatus,
} from './contract';
import {
  contractId,
  encodeTurn,
  type EncodeLimits,
  type TurnContext,
} from './payload';
import { RUNTIME_VERSION } from './runtime-version';
import {
  shortId,
  traceSendStats,
  TracesTransport,
  type SendOutcome,
  type TransportDeps,
} from './transport';

export interface TurnTracerOptions {
  config: TracesConfig;
  /** Keeps the send alive after the turn (a Durable Object's `ctx.waitUntil`). */
  waitUntil: (work: Promise<unknown>) => void;
  logger: Logger;
  /** The Durable Object the tracer belongs to: its requests use its own lane. */
  owner?: object;
  /** The chat / session id. */
  threadId: string;
  /** The person's DID. */
  userId: string;
  /** The person's message as they sent it. */
  userText?: string;
  oracleDid?: string;
  network?: string;
  /** The channel provider (`whatsapp`, `web`, …) or the client (`portal`, `matrix`). */
  channel?: string;
  requestId?: string;
  /** The turn's abort signal: a root that ends while it is aborted is `interrupted`. */
  signal?: AbortSignal;
  /** How long `finish()` waits for a root run that has not ended yet. */
  finishGraceMs?: number;
  /** Send the start marker (default true). */
  startMarker?: boolean;
  /**
   * Every model call the turn reported so far (the attempt's
   * `TurnModelCalls`). Read once, at `finish()`: the calls that are not model
   * runs of the trace (the router's Decision, attachment extraction, calls
   * inside middleware hooks) go into the turn's usage and as `llm` runs under
   * the first root, each once. A call made after the reply (the session
   * title, purpose `title`) is not part of the trace.
   */
  modelCalls?: () => readonly ModelCallReport[];
  /** Tests: transport and size limits. */
  transport?: TransportDeps;
  limits?: EncodeLimits;
}

interface RootState {
  run: Run;
  /** Set when the root ended (persistRun) or was given up on. */
  ended: boolean;
  /** The error LangChain ended the root with, as thrown. */
  thrown?: unknown;
  sent: boolean;
  /** Wakes a grace wait (`finish`) when the root ends. */
  onEnd?: () => void;
}

const DEFAULT_FINISH_GRACE_MS = 5_000;

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Aborted')
  );
}

export class TurnTracer extends BaseTracer {
  name = 'ixo_traces_turn_tracer';

  private readonly roots = new Map<string, RootState>();
  private readonly records = new Map<string, ModelCallRecord>();
  private readonly firstTokens = new Map<string, number>();
  private readonly capped = new Set<string>();
  /** Every model run this tracer saw, of every root. */
  private readonly llmRunIds = new Set<string>();
  /** Roots already handed to the transport: a root id is sent once, ever. */
  private readonly sentIds = new Set<string>();
  /** The turn's calls outside its trees, and the root that carries them. */
  private outside: { rootId: string; calls: ModelCallReport[] } | undefined;
  private readonly transport: TracesTransport;
  private readonly sends = new Set<Promise<SendOutcome | undefined>>();
  private runCount = 0;
  private finished = false;

  constructor(private readonly options: TurnTracerOptions) {
    super();
    // A sub-agent or helper model invoked inside one of the turn's runs
    // nests its runs under that run here (`nestedRunCallbacks`).
    inheritedByNestedRuns(this);
    this.transport = new TracesTransport(
      options.config,
      options.logger,
      options.owner,
      options.transport,
    );
  }

  /** The sends started so far (tests and callers that want to wait). */
  settled(): Promise<unknown> {
    return Promise.allSettled([...this.sends]);
  }

  /**
   * The turn is over (its reply is out): send every root that ended, and
   * give the ones still open `finishGraceMs` before they go as interrupted.
   * Never throws; returns at once.
   */
  finish(): void {
    try {
      if (this.finished) return;
      this.finished = true;
      this.collectOutsideCalls();
      for (const [id, state] of this.roots) {
        if (state.ended) this.ship(id, state);
        else this.giveUpLater(id, state);
      }
    } catch (error) {
      this.internalError('finish', error);
    }
  }

  // ── LangChain hooks ──────────────────────────────────────────────────────

  protected persistRun(run: Run): Promise<void> {
    try {
      const state = this.roots.get(run.id);
      if (state && !state.ended) {
        state.ended = true;
        if (this.finished) this.ship(run.id, state);
        state.onEnd?.();
      }
    } catch (error) {
      this.internalError('persistRun', error);
    }
    return Promise.resolve();
  }

  onRunCreate(run: Run): void {
    try {
      this.runCount += 1;
      if (this.runCount > TURN_LIMITS.maxRuns) {
        // Past the cap the run is not sent: keep nothing of its payload.
        this.capped.add(run.id);
        run.inputs = {};
      }
      if (run.run_type === 'llm') this.llmRunIds.add(run.id);
      if (
        run.parent_run_id === undefined &&
        !this.roots.has(run.id) &&
        !this.sentIds.has(run.id)
      ) {
        this.roots.set(run.id, { run, ended: false, sent: false });
        // A root whose id is not a UUID can never be stored (encodeTurn
        // sends nothing for it): no marker either.
        if (this.options.startMarker !== false && UUID.test(run.id))
          this.sendStart(run);
      }
    } catch (error) {
      this.internalError('onRunCreate', error);
    }
  }

  onLLMStart(run: Run): void {
    try {
      // An abort can end a streamed call with no end from LangChain; the
      // model then hands its call record to whoever waits for it.
      awaitCallEnd(run.id, (record) => this.records.set(run.id, record));
    } catch (error) {
      this.internalError('onLLMStart', error);
    }
  }

  onLLMEnd(run: Run): void {
    try {
      const record = modelCallOf(replyMessage(run.outputs));
      if (record) this.records.set(run.id, record);
      this.dropCappedOutputs(run);
    } catch (error) {
      this.internalError('onLLMEnd', error);
    }
  }

  onChainEnd(run: Run): void {
    this.dropCappedOutputs(run);
  }

  onToolEnd(run: Run): void {
    this.dropCappedOutputs(run);
  }

  onRetrieverEnd(run: Run): void {
    this.dropCappedOutputs(run);
  }

  async handleLLMError(
    error: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    extraParams?: Record<string, unknown>,
  ): Promise<Run> {
    try {
      // The error carries the failed call's record; `run.error` keeps only text.
      const record = modelCallOf(error);
      if (record) this.records.set(runId, record);
    } catch (caught) {
      this.internalError('handleLLMError', caught);
    }
    return super.handleLLMError(error, runId, parentRunId, tags, extraParams);
  }

  async handleChainError(
    error: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, unknown> },
  ): Promise<Run> {
    const state = this.roots.get(runId);
    if (state) state.thrown = error;
    return super.handleChainError(error, runId, parentRunId, tags, kwargs);
  }

  /**
   * Streamed tokens are not kept (LangChain's base tracer pushes one event
   * per token): only the time of the first one.
   */
  async handleLLMNewToken(
    _token: string,
    _idx: NewTokenIndices,
    runId: string,
  ): Promise<Run> {
    if (!this.firstTokens.has(runId)) this.firstTokens.set(runId, Date.now());
    const run = this.getRunById(runId);
    if (!run) throw new Error('No LLM run for this token.');
    return run;
  }

  // ── sending ──────────────────────────────────────────────────────────────

  private dropCappedOutputs(run: Run): void {
    if (this.capped.has(run.id)) run.outputs = undefined;
  }

  private context(): TurnContext {
    const o = this.options;
    return {
      threadId: o.threadId,
      userId: o.userId,
      ...(o.userText !== undefined ? { userText: o.userText } : {}),
      metadata: {
        [TURN_METADATA_KEYS.oracleDid]: o.oracleDid,
        [TURN_METADATA_KEYS.network]: o.network,
        [TURN_METADATA_KEYS.channel]: o.channel,
        [TURN_METADATA_KEYS.runtimeVersion]: RUNTIME_VERSION,
        request_id: o.requestId,
      },
    };
  }

  private track(send: Promise<SendOutcome | undefined>): void {
    this.sends.add(send);
    this.options.waitUntil(send);
  }

  /** The calls of `modelCalls` that are not model runs of the trace, once. */
  private collectOutsideCalls(): void {
    const reported = this.options.modelCalls?.() ?? [];
    const calls = reported.filter(
      (call) => call.purpose !== 'title' && !this.llmRunIds.has(call.callId),
    );
    let first: RootState | undefined;
    for (const state of this.roots.values())
      if (!first || state.run.start_time < first.run.start_time) first = state;
    if (first && calls.length > 0)
      this.outside = { rootId: first.run.id, calls };
  }

  private sendStart(root: Run): void {
    // Same `start_time` as the finished turn (encodeTurn): it picks the
    // index shard. Made when its lane is free; not sent at all once the
    // turn itself went (the turn replaces the marker anyway).
    this.track(
      this.transport.send('start', root.id, () => {
        if (this.sentIds.has(root.id)) return Promise.resolve(undefined);
        const start = Number.isFinite(root.start_time)
          ? root.start_time
          : Date.now();
        const marker = {
          v: CONTRACT_VERSION,
          trace_id: root.id,
          thread_id: contractId(this.options.threadId),
          user_id: contractId(this.options.userId),
          start_time: new Date(start).toISOString(),
          name: (root.name || root.run_type || 'run').slice(
            0,
            TURN_LIMITS.maxNameLength,
          ),
        };
        return Promise.resolve({
          bytes: new TextEncoder().encode(JSON.stringify(marker)),
          gzip: false,
        });
      }),
    );
  }

  private giveUpLater(id: string, state: RootState): void {
    const grace = this.options.finishGraceMs ?? DEFAULT_FINISH_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = new Promise<void>((resolve) => {
      state.onEnd = resolve;
      timer = setTimeout(resolve, grace);
    }).then(() => {
      clearTimeout(timer);
      if (state.sent) return;
      // Still open: the turn ended without LangChain ending this root.
      state.ended = true;
      this.ship(id, state, 'interrupted');
    });
    this.options.waitUntil(later.catch(() => undefined));
  }

  private statusOf(state: RootState): {
    status: TurnStatus;
    error: string | null;
  } {
    const errorText =
      typeof state.run.error === 'string' ? state.run.error : null;
    if (state.run.end_time === undefined)
      return { status: 'interrupted', error: null };
    if (errorText === null) return { status: 'success', error: null };
    const signal = this.options.signal;
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      // A turn limit aborts the signal with its own error: that is a failure.
      if (reason instanceof Error && !isAbortLike(reason))
        return { status: 'error', error: errorText };
      return { status: 'interrupted', error: errorText };
    }
    if (isAbortLike(state.thrown))
      return { status: 'interrupted', error: errorText };
    return { status: 'error', error: errorText };
  }

  private ship(id: string, state: RootState, forced?: 'interrupted'): void {
    if (state.sent || this.sentIds.has(id)) return;
    state.sent = true;
    this.sentIds.add(id);
    const outsideCalls =
      this.outside?.rootId === id ? this.outside.calls : undefined;
    const { status, error } = forced
      ? { status: forced, error: null }
      : this.statusOf(state);
    const endTime = state.run.end_time ?? Date.now();
    const context = this.context();
    const records = this.records;
    const firstTokens = this.firstTokens;
    const limits = this.options.limits;
    const logger = this.options.logger;
    this.track(
      this.transport.send('turn', id, async () => {
        // After the reply: let the turn's own work run first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = Date.now();
        const encoded = await encodeTurn(
          {
            root: state.run,
            status,
            error,
            endTime,
            records,
            firstTokens,
            context,
            ...(outsideCalls ? { outsideCalls } : {}),
          },
          limits,
        );
        this.roots.delete(id);
        if (!encoded) {
          traceSendStats.unbuildable += 1;
          logger.warn(
            `[traces] turn ${shortId(id)} not sent: it does not fit the ingest limits (not sent ${traceSendStats.unbuildable} so far)`,
          );
          return undefined;
        }
        if (encoded.droppedPayloads > 0 || encoded.omittedRuns > 0) {
          traceSendStats.truncated += 1;
          logger.warn(
            `[traces] turn ${shortId(id)} truncated: ${encoded.droppedPayloads} payloads dropped, ${encoded.omittedRuns} runs left out`,
          );
        }
        logger.log(
          `[traces] turn ${shortId(id)}: ${encoded.runCount} runs, ${encoded.rawBytes} → ${encoded.bytes.byteLength} bytes, built in ${Date.now() - started} ms`,
        );
        return { bytes: encoded.bytes, gzip: true };
      }),
    );
  }

  private internalError(where: string, error: unknown): void {
    try {
      this.options.logger.warn(
        `[traces] tracer ${where} failed: ${error instanceof Error ? error.name : 'error'}`,
      );
    } catch {
      // Nothing escapes the tracer.
    }
  }
}

/** The reply message of an LLM run's outputs (`LLMResult`). */
function replyMessage(outputs: unknown): unknown {
  if (typeof outputs !== 'object' || outputs === null) return undefined;
  const generations: unknown = Reflect.get(outputs, 'generations');
  if (!Array.isArray(generations)) return undefined;
  const first: unknown = Array.isArray(generations[0])
    ? generations[0][0]
    : undefined;
  return typeof first === 'object' && first !== null
    ? Reflect.get(first, 'message')
    : undefined;
}
