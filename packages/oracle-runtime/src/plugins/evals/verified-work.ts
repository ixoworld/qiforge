import { randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '../../plugin-api/types.js';
import { canonicalJsonString, cidV1RawSha256Utf8 } from './content-cid.js';
import {
  isEvalsApiError,
  jobVerdict,
  labelOutcome,
  EvalsEngineClient,
  type EvalsApiResult,
  type EvaluationAccepted,
  type EvaluationJob,
} from './evals-client.js';
import {
  buildEvidenceEnvelope,
  buildEvidencePacket,
  buildStructuredFact,
} from './evals-evidence.js';
import {
  matrixEventUri,
  serializeToolCallTrace,
  TRACE_EVENT_KEY,
  type TraceRef,
} from './evals-trace.js';

/**
 * The verified-work loop: the oracle as claimant, not just client.
 *
 * When a background task run completes, the oracle packages a claim about its
 * own work — evidence packet (delivery locator + content-addressed output),
 * execution trace (the run's tool-call history, posted to the task's Matrix
 * room), and the governed rubric — and submits it to the Evals Engine. The
 * credits plugin then gates on-chain settlement for that user on the verdict:
 * held amounts only settle while the owner has no unverified task claims
 * outstanding. Approved claims clear; rejected, failed, or still-pending
 * claims hold settlement until the engine (or a human adjudication) resolves
 * them. The loop fails closed — unverifiable work is unpaid work, not
 * silently paid work.
 *
 * Opt-in via `EVALS_VERIFIED_WORK=true` + `EVALS_TASK_RUBRIC_ID` (a rubric
 * stored in the engine whose `patchAllowlist` admits `status`). The rubric's
 * full governed config is fetched from the engine's discovery API and cached,
 * so the claim always carries the exact rubric the engine governs.
 */

/** Nest injection token for the tasks-side submitter (null when disabled). */
export const VERIFIED_WORK_SUBMITTER = Symbol.for(
  'ixo.oracle-runtime.verifiedWorkSubmitter',
);

/** Nest injection token for the credits-side gate (null when disabled). */
export const VERIFIED_WORK_GATE = Symbol.for(
  'ixo.oracle-runtime.verifiedWorkGate',
);

/** Minimal env accessor — adapt Nest's ConfigService with `(k) => get(k)`. */
export interface VerifiedWorkEnvSource {
  get(key: string): string | undefined;
}

export interface VerifiedWorkSettings {
  baseUrl: string;
  authToken?: string;
  rubricVersionId: string;
  claimType: string;
  capability: string;
  /** How long a submission waits for the async verdict before handing off to the gate. */
  waitSeconds: number;
}

const DEFAULT_CLAIM_TYPE = 'oracle.task_completion';
const DEFAULT_CAPABILITY = 'urn:ixo:oracle:cap:task-completion';
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 300;

/**
 * Resolve the loop's settings from env. Returns null when the loop is not
 * enabled; throws when it is enabled but incoherently configured — a
 * misconfigured payment gate must fail the boot, not silently no-op.
 */
export function resolveVerifiedWorkSettings(
  env: VerifiedWorkEnvSource,
): VerifiedWorkSettings | null {
  if (env.get('EVALS_VERIFIED_WORK') !== 'true') return null;

  const baseUrl = env.get('EVALS_ENGINE_URL');
  if (!baseUrl) {
    throw new Error(
      'EVALS_VERIFIED_WORK=true requires EVALS_ENGINE_URL (the Evals Engine oracle-api base URL).',
    );
  }
  const rubricVersionId = env.get('EVALS_TASK_RUBRIC_ID');
  if (!rubricVersionId) {
    throw new Error(
      'EVALS_VERIFIED_WORK=true requires EVALS_TASK_RUBRIC_ID (a rubric version stored in the engine whose patchAllowlist admits "status").',
    );
  }

  const rawWait = env.get('EVALS_VERIFIED_WORK_WAIT_SECONDS');
  let waitSeconds = DEFAULT_WAIT_SECONDS;
  if (rawWait !== undefined) {
    const parsed = Number(rawWait);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_WAIT_SECONDS) {
      throw new Error(
        `EVALS_VERIFIED_WORK_WAIT_SECONDS must be an integer between 0 and ${MAX_WAIT_SECONDS}.`,
      );
    }
    waitSeconds = parsed;
  }

  return {
    baseUrl,
    authToken: env.get('EVALS_ENGINE_AUTH_TOKEN'),
    rubricVersionId,
    claimType: env.get('EVALS_TASK_CLAIM_TYPE') ?? DEFAULT_CLAIM_TYPE,
    capability: env.get('EVALS_TASK_CLAIM_CAP') ?? DEFAULT_CAPABILITY,
    waitSeconds,
  };
}

// ---------------------------------------------------------------------------
// Ledger — the oracle-local index of outstanding claims per owner.
// ---------------------------------------------------------------------------

/** The subset of ioredis the ledger uses (kept narrow for testability). */
export interface VerifiedWorkRedis {
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface VerifiedWorkEntry {
  claimId: string;
  taskId: string;
  /**
   * `pending` — awaiting a verdict; `rejected` — verdict was not approved
   * (adjudication can still flip it); `failed` — submission or evaluation
   * failed, needs operator attention. Approved entries are deleted: the
   * ledger holds only what blocks settlement.
   */
  status: 'pending' | 'rejected' | 'failed';
  outcome?: number;
  reason?: string;
  updatedAt: string;
}

const LEDGER_KEY_PREFIX = 'evals:verified-work:v1';

/**
 * Redis-backed per-owner index of task claims that have not yet resolved to
 * an approved verdict. The engine is the source of truth for verdicts; this
 * only remembers WHICH claims to ask about — approved entries are removed.
 */
export class VerifiedWorkLedger {
  constructor(private readonly redis: VerifiedWorkRedis) {}

  private key(owner: string): string {
    return `${LEDGER_KEY_PREFIX}:${owner}`;
  }

  async record(owner: string, entry: VerifiedWorkEntry): Promise<void> {
    await this.redis.hset(
      this.key(owner),
      entry.claimId,
      JSON.stringify(entry),
    );
  }

  /** Remove a claim whose verdict resolved to approved. */
  async resolve(owner: string, claimId: string): Promise<void> {
    await this.redis.hdel(this.key(owner), claimId);
  }

  async list(owner: string): Promise<VerifiedWorkEntry[]> {
    const raw = await this.redis.hgetall(this.key(owner));
    const entries: VerifiedWorkEntry[] = [];
    for (const value of Object.values(raw)) {
      try {
        entries.push(JSON.parse(value) as VerifiedWorkEntry);
      } catch {
        // A corrupt row must not unblock payment or crash the cron — skip it;
        // it stays in Redis for operator inspection.
      }
    }
    return entries;
  }
}

// ---------------------------------------------------------------------------
// Submitter — turns a completed task run into an evaluated claim.
// ---------------------------------------------------------------------------

/** What the tasks worker knows about a delivered run. */
export interface CompletedTaskRun {
  taskId: string;
  /** Task owner's DID — the deed audience and the settlement identity. */
  owner: string;
  title: string;
  /** The agent output that was delivered to the room. */
  output: string;
  roomId: string;
  /** Matrix event id of the delivered output (the evidence locator). */
  deliveredEventId: string;
  sessionId: string;
  requestId?: string;
  /** The run's thread, when available — serialized into the claim trace. */
  messages?: BaseMessage[];
}

/** Matrix posting surface (injected so tests need no Matrix singleton). */
export interface VerifiedWorkPoster {
  postText(roomId: string, text: string): Promise<unknown>;
  postEvent(roomId: string, content: Record<string, unknown>): Promise<string>;
}

/** The engine surface the loop consumes (EvalsEngineClient satisfies it). */
export interface VerifiedWorkClient {
  getRubric(
    rubricVersionId: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<Record<string, unknown>>>;
  evaluateClaim(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<EvaluationAccepted>>;
  waitForJob(
    jobId: string,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<EvaluationJob>>;
  getClaimStatus(
    claimId: string,
    signal?: AbortSignal,
  ): Promise<
    EvalsApiResult<{
      claimId: string;
      job: Omit<EvaluationJob, 'claimId'>;
      manualReviewQueue: boolean;
    }>
  >;
}

/**
 * Default poster: the same MatrixManager singleton background workers use.
 * `@ixo/matrix` loads native crypto bindings at import time, so it is
 * imported lazily at first post — this module stays importable (and its
 * consumers testable) in environments without the binding.
 */
export function matrixVerifiedWorkPoster(): VerifiedWorkPoster {
  const manager = async () => (await import('@ixo/matrix')).MatrixManager;
  return {
    postText: async (roomId, text) =>
      (await manager()).getInstance().sendMessage({
        roomId,
        message: text,
        isOracleAdmin: true,
      }),
    postEvent: async (roomId, content) =>
      (await manager())
        .getInstance()
        .sendMatrixEvent(roomId, 'm.room.message', content),
  };
}

export interface VerifiedWorkSubmitterDeps {
  client: VerifiedWorkClient;
  ledger: VerifiedWorkLedger;
  settings: VerifiedWorkSettings;
  poster: VerifiedWorkPoster;
  /** The oracle's DID — the evidence envelope submitter. */
  submitterDid: string;
  logger: Logger;
}

/**
 * Submits a claim about a completed task run and records it in the ledger.
 * Non-throwing by contract: the task already completed and was delivered —
 * verification hiccups are logged and held (the ledger entry keeps settlement
 * gated), never propagated into the worker.
 */
export class VerifiedWorkSubmitter {
  private rubricCache?: Promise<object>;

  constructor(private readonly deps: VerifiedWorkSubmitterDeps) {}

  async submitCompletedTask(run: CompletedTaskRun): Promise<void> {
    const { ledger, logger } = this.deps;
    const jti = randomUUID();
    const claimId = `urn:ixo:oracle:task:${run.taskId}:${jti}`;

    // Record before submitting: if anything below fails, the entry already
    // holds settlement (fail closed) instead of letting unverified work pay.
    await ledger.record(run.owner, {
      claimId,
      taskId: run.taskId,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    });

    try {
      await this.evaluate(run, claimId, jti);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.error(
        `Verified-work submission for task ${run.taskId} (claim ${claimId}) failed: ${reason}`,
      );
      await ledger
        .record(run.owner, {
          claimId,
          taskId: run.taskId,
          status: 'failed',
          reason,
          updatedAt: new Date().toISOString(),
        })
        .catch(() => undefined); // the pending entry still holds settlement
    }
  }

  private async evaluate(
    run: CompletedTaskRun,
    claimId: string,
    jti: string,
  ): Promise<void> {
    const { client, settings, logger } = this.deps;

    const rubric = await this.governedRubric();
    const trace = await this.captureRunTrace(run, jti);

    const taskUrn = `urn:ixo:oracle:task:${run.taskId}`;
    const evidenceId = `urn:ixo:evidence:task:${run.taskId}:${jti}`;
    const packet = buildEvidencePacket({
      claimId,
      packetId: evidenceId,
      generatedAt: new Date().toISOString(),
      facts: [
        buildStructuredFact({
          factId: `${evidenceId}#completed`,
          factType: 'oracle_task.completed',
          statement: `Task "${run.title}" ran to completion and its output was delivered.`,
          subject: taskUrn,
          predicate: 'status',
          object: 'completed',
          source: { evidenceId, locator: '$.delivery' },
        }),
        buildStructuredFact({
          factId: `${evidenceId}#delivered`,
          factType: 'oracle_task.output_delivered',
          statement: `The run output was posted to the task's Matrix room.`,
          subject: taskUrn,
          predicate: 'delivery',
          object: matrixEventUri(run.roomId, run.deliveredEventId),
          source: { evidenceId, locator: '$.delivery.eventUri' },
        }),
        buildStructuredFact({
          factId: `${evidenceId}#digest`,
          factType: 'oracle_task.output_digest',
          statement:
            'CIDv1 (raw, sha2-256) over the delivered output bytes — auditors recompute it from the delivered Matrix event.',
          subject: taskUrn,
          predicate: 'digest',
          object: cidV1RawSha256Utf8(run.output),
          modality: 'computed',
          source: { evidenceId, locator: '$.delivery.outputCid' },
        }),
      ],
    });
    const envelope = buildEvidenceEnvelope({
      evidenceId,
      claimId,
      submitterDid: this.deps.submitterDid,
      packet,
    });

    const accepted = await client.evaluateClaim({
      deed: { id: taskUrn, aud: run.owner },
      claim: {
        id: claimId,
        cap: settings.capability,
        jti,
        automatedAgent: true,
        claimType: settings.claimType,
        proposedPatch: { status: 'completed' },
        ...(trace ? { trace } : {}),
      },
      rubric,
      evidence: { packet, envelope },
    });
    if (isEvalsApiError(accepted)) {
      throw new Error(`engine rejected the submission: ${accepted.error}`);
    }

    const job = await client.waitForJob(accepted.jobId, settings.waitSeconds);
    if (isEvalsApiError(job)) {
      logger.warn(
        `Verified-work claim ${claimId} submitted but its job is not readable yet (${job.error}) — the settlement gate will re-check.`,
      );
      return; // stays pending in the ledger
    }
    await this.applyVerdict(run, claimId, job);
  }

  private async applyVerdict(
    run: CompletedTaskRun,
    claimId: string,
    job: EvaluationJob,
  ): Promise<void> {
    const { ledger, poster, logger } = this.deps;
    const verdict = jobVerdict(job);

    if (job.status === 'completed' && verdict.outcome === 1) {
      await ledger.resolve(run.owner, claimId);
      await poster
        .postText(
          run.roomId,
          `✅ **Work verified** — "${run.title}" was evaluated and approved by the Evals Engine${
            verdict.udidIssued ? ' (signed UDID receipt issued)' : ''
          }.\nClaim \`${claimId}\``,
        )
        .catch((err: unknown) =>
          logger.warn(
            `Verified-work notice for ${claimId} failed to post: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }

    if (job.status === 'completed' || job.status === 'failed') {
      const rejected = job.status === 'completed';
      const reason = rejected
        ? (verdict.reason ?? 'below rubric threshold')
        : (job.lastError ?? job.error ?? 'evaluation job failed');
      await ledger.record(run.owner, {
        claimId,
        taskId: run.taskId,
        status: rejected ? 'rejected' : 'failed',
        ...(verdict.outcome === undefined ? {} : { outcome: verdict.outcome }),
        reason,
        updatedAt: new Date().toISOString(),
      });
      await poster
        .postText(
          run.roomId,
          `⚠️ **Verification ${rejected ? `verdict: ${labelOutcome(verdict.outcome) ?? 'not approved'}` : 'failed'}** — "${run.title}": ${reason}\nSettlement for this work is on hold pending review. Claim \`${claimId}\``,
        )
        .catch(() => undefined);
      return;
    }

    // Still pending/processing after the wait budget — the settlement gate
    // refreshes it on its own cron; no user-facing noise for a slow queue.
  }

  /**
   * The exact governed rubric config, fetched from the engine's discovery
   * API and cached for the process lifetime. Cache clears on failure so a
   * transient outage doesn't wedge every later submission.
   */
  private governedRubric(): Promise<object> {
    this.rubricCache ??= (async () => {
      const { client, settings } = this.deps;
      const detail = await client.getRubric(settings.rubricVersionId);
      if (isEvalsApiError(detail)) {
        throw new Error(
          `rubric ${settings.rubricVersionId} is not resolvable from the engine: ${detail.error}`,
        );
      }
      const rubric: unknown = detail.rubric;
      if (rubric === null || typeof rubric !== 'object') {
        throw new Error(
          `rubric ${settings.rubricVersionId} detail carries no rubric config`,
        );
      }
      return rubric;
    })();
    this.rubricCache.catch(() => {
      this.rubricCache = undefined;
    });
    return this.rubricCache;
  }

  /** Post the run's tool-call trace to the task room; undefined if unavailable. */
  private async captureRunTrace(
    run: CompletedTaskRun,
    jti: string,
  ): Promise<TraceRef | undefined> {
    if (!run.messages || run.messages.length === 0) return undefined;
    const document = serializeToolCallTrace(run.messages, {
      sessionId: run.sessionId,
      requestId: run.requestId ?? jti,
    });
    const cid = cidV1RawSha256Utf8(canonicalJsonString(document));
    try {
      const eventId = await this.deps.poster.postEvent(run.roomId, {
        msgtype: 'm.notice',
        body: `Agent execution trace ${cid} (${document.toolCalls.length} tool calls)`,
        [TRACE_EVENT_KEY]: { cid, document },
      });
      return { uri: matrixEventUri(run.roomId, eventId), cid };
    } catch (cause) {
      this.deps.logger.warn(
        `Trace capture for task ${run.taskId} failed to post: ${cause instanceof Error ? cause.message : String(cause)} — submitting without a trace.`,
      );
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Gate — the credits-side settlement precondition.
// ---------------------------------------------------------------------------

export type SettlementVerdict =
  | { settle: true }
  | { settle: false; reason: string };

export interface VerifiedWorkGateDeps {
  client: VerifiedWorkClient;
  ledger: VerifiedWorkLedger;
  logger: Logger;
}

/**
 * Settlement precondition for the credits cron: a user's held amount settles
 * only while their ledger holds no unresolved task claims. Every check
 * refreshes each entry against the engine — approved verdicts (including
 * adjudications that flipped an earlier rejection) clear on the spot; the
 * engine being unreachable holds settlement rather than waving it through.
 */
export class VerifiedWorkGate {
  constructor(private readonly deps: VerifiedWorkGateDeps) {}

  async check(owner: string): Promise<SettlementVerdict> {
    const { client, ledger, logger } = this.deps;
    const entries = await ledger.list(owner);
    if (entries.length === 0) return { settle: true };

    const blockers: string[] = [];
    for (const entry of entries) {
      try {
        const status = await client.getClaimStatus(entry.claimId);
        if (isEvalsApiError(status)) {
          blockers.push(`${entry.claimId} (${entry.status}: ${status.error})`);
          continue;
        }
        const job: EvaluationJob = { ...status.job, claimId: status.claimId };
        const verdict = jobVerdict(job);
        if (job.status === 'completed' && verdict.outcome === 1) {
          await ledger.resolve(owner, entry.claimId);
          continue;
        }
        const state =
          job.status === 'completed'
            ? (labelOutcome(verdict.outcome) ?? 'not approved')
            : status.manualReviewQueue
              ? 'held for human review'
              : job.status;
        await ledger.record(owner, {
          ...entry,
          status: job.status === 'failed' ? 'failed' : entry.status,
          ...(verdict.outcome === undefined
            ? {}
            : { outcome: verdict.outcome }),
          updatedAt: new Date().toISOString(),
        });
        blockers.push(`${entry.claimId} (${state})`);
      } catch (cause) {
        // Engine unreachable — fail closed and try again next cron tick.
        logger.warn(
          `Verified-work refresh for ${entry.claimId} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        blockers.push(`${entry.claimId} (engine unreachable)`);
      }
    }

    if (blockers.length === 0) return { settle: true };
    return {
      settle: false,
      reason: `${blockers.length} task claim(s) unresolved: ${blockers.join('; ')}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Env-driven factories — what the tasks and credits Nest modules wire in.
// ---------------------------------------------------------------------------

export interface VerifiedWorkFactoryOptions {
  env: VerifiedWorkEnvSource;
  redis: VerifiedWorkRedis;
  logger: Logger;
  /** Override for tests; defaults to the MatrixManager-backed poster. */
  poster?: VerifiedWorkPoster;
}

/** Null when the loop is disabled; throws on incoherent configuration. */
export function createVerifiedWorkSubmitterFromEnv(
  opts: VerifiedWorkFactoryOptions,
): VerifiedWorkSubmitter | null {
  const settings = resolveVerifiedWorkSettings(opts.env);
  if (!settings) return null;
  const submitterDid = opts.env.get('ORACLE_DID');
  if (!submitterDid) {
    throw new Error(
      'EVALS_VERIFIED_WORK=true requires ORACLE_DID (the evidence envelope submitter identity).',
    );
  }
  return new VerifiedWorkSubmitter({
    client: new EvalsEngineClient({
      baseUrl: settings.baseUrl,
      authToken: settings.authToken,
    }),
    ledger: new VerifiedWorkLedger(opts.redis),
    settings,
    poster: opts.poster ?? matrixVerifiedWorkPoster(),
    submitterDid,
    logger: opts.logger,
  });
}

/** Null when the loop is disabled; throws on incoherent configuration. */
export function createVerifiedWorkGateFromEnv(
  opts: Omit<VerifiedWorkFactoryOptions, 'poster'>,
): VerifiedWorkGate | null {
  const settings = resolveVerifiedWorkSettings(opts.env);
  if (!settings) return null;
  return new VerifiedWorkGate({
    client: new EvalsEngineClient({
      baseUrl: settings.baseUrl,
      authToken: settings.authToken,
    }),
    ledger: new VerifiedWorkLedger(opts.redis),
    logger: opts.logger,
  });
}
