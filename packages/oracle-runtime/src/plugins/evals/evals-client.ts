/**
 * Thin HTTP client for the IXO Evals Engine (`oracle-api`). The engine has no
 * published SDK — its consumable surface is the hosted REST API documented at
 * `GET /openapi.json`. Auth is a static bearer token; evaluation is an async
 * job queue (submit → 202 → poll the job) with no webhook, so this client
 * owns the bounded polling loop.
 */

/** Claim outcome codes mirror the ixo-blockchain `x/claims` EvaluationStatus enum. */
const OUTCOME_LABELS: Record<number, string> = {
  0: 'pending',
  1: 'approved',
  2: 'rejected',
  3: 'disputed',
  4: 'invalidated',
  5: 'flagged',
};

export function labelOutcome(outcome: number | undefined): string | undefined {
  if (outcome === undefined) return undefined;
  return OUTCOME_LABELS[outcome] ?? `unknown(${outcome})`;
}

/**
 * Expected domain responses (validation errors, conflicts, not-yet-issued)
 * come back to the agent as `{ error, ... }` objects it can react to.
 * Operator-level failures (bad token, 5xx, network) throw instead.
 */
export interface EvalsApiError {
  error: string;
  [key: string]: unknown;
}

export type EvalsApiResult<T> = T | EvalsApiError;

export function isEvalsApiError(value: unknown): value is EvalsApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).error === 'string'
  );
}

export interface EvaluationAccepted {
  jobId: string;
  claimId: string;
  status: 'pending' | 'completed' | 'failed';
  error?: string;
}

export interface EvaluationJob {
  id: string;
  claimId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error: string | null;
  attempts: number;
  lastError: string | null;
  resultSummary: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimStatus {
  claimId: string;
  job: Omit<EvaluationJob, 'claimId'>;
  manualReviewQueue: boolean;
}

export interface UdidReceipt {
  claimId: string;
  compactJws: string;
  payload: unknown;
}

export interface EvalsClientOptions {
  baseUrl: string;
  authToken?: string;
  /** Delay between job polls in `waitForJob`. Overridable for tests. */
  pollIntervalMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Evals Engine polling aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Evals Engine polling aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class EvalsEngineClient {
  /** Configured engine base URL (public so tools can name the default issuer). */
  readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly pollIntervalMs: number;

  constructor(options: EvalsClientOptions) {
    this.baseUrl = options.baseUrl;
    this.authToken = options.authToken;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /**
   * Submit a claim evaluation (`POST /v1/claims/evaluate`). Returns the 202
   * acceptance (job id + claim id) or an `{ error }` object for 400/409
   * responses (invalid shape, replayed jti, identity conflicts).
   */
  async evaluateClaim(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<EvaluationAccepted>> {
    return this.request<EvaluationAccepted>('POST', '/v1/claims/evaluate', {
      body,
      signal,
    });
  }

  /** `GET /v1/jobs/{jobId}` — `{ error: 'job_not_found' }` when unknown. */
  async getJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<EvaluationJob>> {
    return this.request<EvaluationJob>(
      'GET',
      `/v1/jobs/${encodeURIComponent(jobId)}`,
      { signal },
    );
  }

  /** `GET /v1/claims/{claimId}/status` — job state + manual-review flag. */
  async getClaimStatus(
    claimId: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<ClaimStatus>> {
    return this.request<ClaimStatus>(
      'GET',
      `/v1/claims/${encodeURIComponent(claimId)}/status`,
      { signal },
    );
  }

  /** `GET /v1/claims/{claimId}/udid` — `{ error: 'udid_not_issued' }` until issued. */
  async getUdid(
    claimId: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<UdidReceipt>> {
    return this.request<UdidReceipt>(
      'GET',
      `/v1/claims/${encodeURIComponent(claimId)}/udid`,
      { signal },
    );
  }

  /** `GET /v1/claims/{claimId}/audit` — tamper-evident audit bundle. */
  async getAudit(
    claimId: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/v1/claims/${encodeURIComponent(claimId)}/audit`,
      { signal },
    );
  }

  /**
   * `GET /v1/governance/maturity` (full ladder) or
   * `GET /v1/governance/maturity/{claimType}` (one claim type's rung).
   */
  async getMaturity(
    claimType?: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<Record<string, unknown>>> {
    const path = claimType
      ? `/v1/governance/maturity/${encodeURIComponent(claimType)}`
      : '/v1/governance/maturity';
    return this.request<Record<string, unknown>>('GET', path, { signal });
  }

  /** `GET /v1/manual-review` — pending human-review cases. */
  async listManualReview(
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>('GET', '/v1/manual-review', {
      signal,
    });
  }

  /**
   * `GET /v1/rubrics[?claimType=...]` — rubric discovery listing: stored
   * rubric versions plus every governed collection binding the engine's
   * resolver can enumerate.
   */
  async listRubrics(
    claimType?: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<Record<string, unknown>>> {
    const query =
      claimType === undefined
        ? ''
        : `?claimType=${encodeURIComponent(claimType)}`;
    return this.request<Record<string, unknown>>('GET', `/v1/rubrics${query}`, {
      signal,
    });
  }

  /** `GET /v1/rubrics/{id}` — one rubric's full stored config. */
  async getRubric(
    rubricVersionId: string,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/v1/rubrics/${encodeURIComponent(rubricVersionId)}`,
      { signal },
    );
  }

  /**
   * Poll `GET /v1/jobs/{jobId}` until it leaves `pending`/`processing` or the
   * wait budget runs out. Returns the last observed job state either way —
   * callers inspect `status` to see whether the evaluation finished.
   */
  async waitForJob(
    jobId: string,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<EvalsApiResult<EvaluationJob>> {
    const deadline = Date.now() + waitSeconds * 1000;
    let job = await this.getJob(jobId, signal);
    while (
      !isEvalsApiError(job) &&
      (job.status === 'pending' || job.status === 'processing') &&
      Date.now() < deadline
    ) {
      await sleep(this.pollIntervalMs, signal);
      job = await this.getJob(jobId, signal);
    }
    return job;
  }

  /**
   * Join an API path onto the configured base URL. `new URL('/v1/x', base)`
   * would discard any path prefix on the base, breaking deployments mounted
   * behind a reverse-proxy subpath (`https://host/oracle-api`) — so resolve
   * the path relative to the base with a trailing slash instead.
   */
  private resolveUrl(path: string): URL {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    return new URL(path.replace(/^\//, ''), base);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; signal?: AbortSignal },
  ): Promise<EvalsApiResult<T>> {
    const url = this.resolveUrl(path);
    const headers: Record<string, string> = {};
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    if (response.status === 401) {
      throw new Error(
        'Evals Engine rejected the request as unauthorized. Check EVALS_ENGINE_AUTH_TOKEN.',
      );
    }

    // 4xx bodies are structured `{ error: <code>, ... }` payloads the agent
    // can act on (fix arguments, use a fresh jti, wait for issuance).
    if (response.status >= 400 && response.status < 500) {
      const body: unknown = await response.json().catch(() => null);
      if (isEvalsApiError(body)) return body;
      throw new Error(
        `Evals Engine request failed: ${response.status} ${response.statusText}`,
      );
    }

    throw new Error(
      `Evals Engine request failed: ${response.status} ${response.statusText}`,
    );
  }
}
