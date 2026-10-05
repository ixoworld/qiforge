/**
 * The Linear feedback sink: one issue per (user, message) in the configured
 * team and project, over Linear's GraphQL API with `fetch`.
 *
 * Idempotent across retries and Worker restarts: the issue description
 * carries the message fingerprint, and the sink looks for it before every
 * create and again before retrying a create whose outcome is unknown.
 * Bounded: at most three attempts per call, waits honour Linear's
 * `X-RateLimit-*-Reset` headers (UTC epoch milliseconds) and give up rather
 * than wait longer than {@link MAX_RETRY_WAIT_MS}.
 */
import type { LinearDestination } from './config';
import type { FeedbackDelivery, FeedbackIssue, FeedbackSink } from './contract';

const FIND_EXISTING_ISSUE = `
  query AnonymousFeedbackIssue($projectId: ID!, $marker: String!) {
    issues(
      first: 1
      filter: {
        project: { id: { eq: $projectId } }
        description: { contains: $marker }
      }
    ) {
      nodes { id }
    }
  }
`;

const CREATE_FEEDBACK_ISSUE = `
  mutation CreateAnonymousFeedbackIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id }
    }
  }
`;

const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;

/** A failed Linear call. The message holds the status and error code only. */
export class LinearFeedbackError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LinearFeedbackError';
  }
}

interface LinearGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ extensions?: { code?: string } }>;
}

export interface LinearSinkOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function tableValue(value: string): string {
  return value.replace(/[\r\n|]/g, ' ').trim() || 'unknown';
}

/**
 * The user's text as a fenced block, so Linear renders it verbatim: no
 * headings, links or images (an image would fetch from a URL the author
 * chose when a reviewer opens the issue), no fake context table. The fence
 * is one backtick longer than any run in the text, so the text cannot close
 * it.
 */
function fencedText(text: string): string {
  const longestRun = Math.max(
    2,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * How long a RATE-LIMITED response asks us to wait. Linear sends the
 * `X-RateLimit-*-Reset` headers on every response, so they say when the
 * window resets, not when to retry a failure: they are only read for a
 * rate limit (HTTP 429 or GraphQL `RATELIMITED`). Other failures back off.
 */
function rateLimitDelayMs(response: Response, now: number): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset =
    response.headers.get('x-ratelimit-endpoint-requests-reset') ??
    response.headers.get('x-ratelimit-requests-reset') ??
    response.headers.get('x-ratelimit-complexity-reset');
  const resetAt = reset ? Number(reset) : Number.NaN;
  return Number.isFinite(resetAt) ? Math.max(0, resetAt - now) : undefined;
}

export function linearFeedbackTitle(issue: FeedbackIssue): string {
  const at = new Date(issue.submittedAt)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  return `[Agent feedback] ${issue.context.surface} · ${at}`;
}

/**
 * The issue body: the screened feedback, then a table of allowlisted coarse
 * context and keyed pseudonyms. Nothing else about the user or the
 * conversation is available to this function.
 */
export function linearFeedbackDescription(issue: FeedbackIssue): string {
  const rows: Array<[string, string]> = [
    ['Submission ID', issue.submissionId],
    ['User pseudonym', issue.userPseudonym],
    ['Session fingerprint', issue.sessionFingerprint],
    ['Message fingerprint', issue.messageFingerprint],
    ['Agent DID', issue.agent.did],
    ['Agent name', issue.agent.name],
    ['Default model', issue.agent.model],
    ['Provider', issue.agent.provider],
    ['Surface', issue.context.surface],
    ['Network', issue.context.network],
    ['Locale', issue.context.locale],
    ['Theme', issue.context.theme],
    ['Device class', issue.context.deviceClass],
    ['Viewport', issue.context.viewportBucket],
    ['Portal build', issue.context.portalBuildVersion ?? 'unknown'],
    ['QiForge build', issue.agent.runtimeBuildVersion],
    ['Submitted at', issue.submittedAt],
  ];
  return [
    '## Feedback',
    '',
    fencedText(issue.feedback),
    '',
    '## Safe context',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${label} | ${tableValue(value)} |`),
    '',
    '## Privacy',
    '',
    'No prompt, response, reasoning, tool data, attachment, raw DID, raw session ID, raw message ID, IP address, URL, payment data, location or full user agent was attached. User and conversation references are keyed pseudonyms.',
  ].join('\n');
}

export class LinearFeedbackSink implements FeedbackSink {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly destination: LinearDestination,
    opts: LinearSinkOptions = {},
  ) {
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  async submit(issue: FeedbackIssue): Promise<FeedbackDelivery> {
    const marker = issue.messageFingerprint;
    if (await this.issueExists(marker)) return 'existing';
    const { teamId, projectId, labelIds } = this.destination;
    const input = {
      teamId,
      projectId,
      title: linearFeedbackTitle(issue),
      description: linearFeedbackDescription(issue),
      ...(labelIds.length > 0 && { labelIds }),
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const created = await this.requestOnce<{
          issueCreate: { success: boolean; issue?: { id: string } | null };
        }>(CREATE_FEEDBACK_ISSUE, { input });
        if (!created.issueCreate.success || !created.issueCreate.issue?.id)
          throw new LinearFeedbackError(
            'Linear did not confirm the feedback issue',
            false,
          );
        return 'created';
      } catch (error) {
        if (
          !(error instanceof LinearFeedbackError) ||
          !error.retryable ||
          attempt === MAX_ATTEMPTS - 1
        )
          throw error;
        await this.waitBeforeRetry(error, attempt);
        // The failed create may have landed: never create a second issue.
        // It was this call's create, so it counts as created.
        if (await this.issueExists(marker)) return 'created';
      }
    }
  }

  private async issueExists(marker: string): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const found = await this.requestOnce<{
          issues: { nodes: Array<{ id: string }> };
        }>(FIND_EXISTING_ISSUE, {
          projectId: this.destination.projectId,
          marker,
        });
        return found.issues.nodes.length > 0;
      } catch (error) {
        if (
          !(error instanceof LinearFeedbackError) ||
          !error.retryable ||
          attempt === MAX_ATTEMPTS - 1
        )
          throw error;
        await this.waitBeforeRetry(error, attempt);
      }
    }
  }

  private async waitBeforeRetry(
    error: LinearFeedbackError,
    attempt: number,
  ): Promise<void> {
    const delay = error.retryAfterMs ?? 250 * 2 ** attempt;
    if (delay > MAX_RETRY_WAIT_MS) throw error;
    await this.sleep(delay);
  }

  private async requestOnce<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(this.destination.apiUrl, {
        method: 'POST',
        // Linear personal API keys go in the header as-is (no Bearer prefix).
        headers: {
          authorization: this.destination.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new LinearFeedbackError(
        error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'Linear feedback request timed out'
          : 'Linear feedback request failed (network)',
        true,
      );
    }
    const payload: LinearGraphqlResponse<T> | null = await response
      .json<LinearGraphqlResponse<T>>()
      .catch(() => null);
    const code = payload?.errors?.[0]?.extensions?.code;
    if (!response.ok || payload?.errors?.length) {
      const rateLimited = response.status === 429 || code === 'RATELIMITED';
      throw new LinearFeedbackError(
        `Linear feedback request failed (${response.status}${code ? `/${code}` : ''})`,
        rateLimited ||
          response.status >= 500 ||
          code === 'INTERNAL_SERVER_ERROR',
        rateLimited ? rateLimitDelayMs(response, this.now()) : undefined,
      );
    }
    if (!payload?.data)
      throw new LinearFeedbackError(
        'Linear feedback request returned no data',
        false,
      );
    return payload.data;
  }
}
