import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ENV } from 'src/types';
import type { AnonymousFeedbackIssue, FeedbackSink } from './feedback-sink';

const FIND_EXISTING_ISSUE = `
  query AnonymousFeedbackSubmission($projectId: String!, $marker: String!) {
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

type LinearGraphqlError = {
  message?: string;
  extensions?: { code?: string };
};

type LinearGraphqlResponse<T> = {
  data?: T;
  errors?: LinearGraphqlError[];
};

class LinearFeedbackRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function markdownTableValue(value: string): string {
  return value.replace(/[\r\n|]/g, ' ').trim() || 'unknown';
}

function rateLimitRetryDelay(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  const reset =
    response.headers.get('x-ratelimit-endpoint-requests-reset') ??
    response.headers.get('x-ratelimit-requests-reset');
  if (!reset) return undefined;
  const resetAt = Number(reset);
  return Number.isFinite(resetAt)
    ? Math.max(0, resetAt - Date.now())
    : undefined;
}

export function buildLinearFeedbackDescription(
  issue: AnonymousFeedbackIssue,
): string {
  const contextRows: Array<[string, string]> = [
    ['Submission ID', issue.submissionId],
    ['User pseudonym', issue.userPseudonym],
    ['Session fingerprint', issue.sessionFingerprint],
    ['Message fingerprint', issue.messageFingerprint],
    ['Agent DID', issue.agent.did],
    ['Agent name', issue.agent.name],
    ['Model', issue.agent.model],
    ['Provider', issue.agent.provider],
    ['Surface', issue.context.surface],
    ['Network', issue.context.network],
    ['Locale', issue.context.locale],
    ['Theme', issue.context.theme],
    ['Device class', issue.context.deviceClass],
    ['Viewport', issue.context.viewportBucket],
    ['Portal build', issue.context.portalBuildVersion ?? 'unknown'],
    ['Qiforge build', issue.agent.runtimeBuildVersion],
    ['Submitted at', issue.submittedAt],
  ];

  const table = contextRows
    .map(
      ([label, value]) => `| ${label} | ${markdownTableValue(String(value))} |`,
    )
    .join('\n');

  return [
    '## Feedback',
    '',
    issue.feedback,
    '',
    '## Safe context',
    '',
    '| Field | Value |',
    '| --- | --- |',
    table,
    '',
    '## Privacy',
    '',
    'No prompt, response, reasoning, tool data, attachment, raw DID, raw session ID, raw message ID, IP address, or full user agent was attached. User and conversation references are keyed pseudonyms.',
  ].join('\n');
}

@Injectable()
export class LinearFeedbackSink implements FeedbackSink {
  constructor(private readonly config: ConfigService<ENV>) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get('LINEAR_FEEDBACK_API_KEY') &&
      this.config.get('LINEAR_FEEDBACK_TEAM_ID') &&
      this.config.get('LINEAR_FEEDBACK_PROJECT_ID'),
    );
  }

  async submit(issue: AnonymousFeedbackIssue): Promise<void> {
    const projectId = this.config.getOrThrow('LINEAR_FEEDBACK_PROJECT_ID');
    const marker = issue.submissionId;
    if (await this.issueExists(projectId, marker)) return;

    const labelIds = (this.config.get('LINEAR_FEEDBACK_LABEL_IDS') ?? '')
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean);
    const titleTimestamp = new Date(issue.submittedAt)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const input: Record<string, unknown> = {
      teamId: this.config.getOrThrow('LINEAR_FEEDBACK_TEAM_ID'),
      projectId,
      title: `[Agent feedback] ${issue.context.surface} · ${titleTimestamp}`,
      description: buildLinearFeedbackDescription(issue),
    };
    if (labelIds.length > 0) input.labelIds = labelIds;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const created = await this.request<{
          issueCreate: { success: boolean; issue?: { id: string } };
        }>(CREATE_FEEDBACK_ISSUE, { input }, 1);

        if (!created.issueCreate.success || !created.issueCreate.issue?.id) {
          throw new Error('Linear did not confirm feedback issue creation');
        }
        return;
      } catch (error) {
        if (
          !(error instanceof LinearFeedbackRequestError) ||
          !error.retryable ||
          attempt === 2
        ) {
          throw error;
        }

        await this.waitBeforeRetry(error, attempt);
        if (await this.issueExists(projectId, marker)) return;
      }
    }
  }

  private async issueExists(
    projectId: string,
    marker: string,
  ): Promise<boolean> {
    const existing = await this.request<{
      issues: { nodes: Array<{ id: string }> };
    }>(FIND_EXISTING_ISSUE, { projectId, marker });
    return existing.issues.nodes.length > 0;
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    maxAttempts = 3,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce<T>(query, variables);
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof LinearFeedbackRequestError) ||
          !error.retryable ||
          attempt === maxAttempts - 1
        ) {
          throw error;
        }
        await this.waitBeforeRetry(error, attempt);
      }
    }

    throw lastError;
  }

  private async waitBeforeRetry(
    error: LinearFeedbackRequestError,
    attempt: number,
  ): Promise<void> {
    const delay = error.retryAfterMs ?? 250 * 2 ** attempt;
    if (delay > 2000) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private async requestOnce<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(
        this.config.get(
          'LINEAR_FEEDBACK_API_URL',
          'https://api.linear.app/graphql',
        ),
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: this.config.getOrThrow('LINEAR_FEEDBACK_API_KEY'),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        },
      );

      const payload = (await response.json().catch(() => ({}))) as
        | LinearGraphqlResponse<T>
        | undefined;
      const errorCode = payload?.errors?.[0]?.extensions?.code;
      if (!response.ok || payload?.errors?.length) {
        const retryAfterMs = rateLimitRetryDelay(response);
        throw new LinearFeedbackRequestError(
          `Linear feedback request failed (${response.status}${errorCode ? `/${errorCode}` : ''})`,
          response.status >= 500 ||
            response.status === 429 ||
            errorCode === 'RATELIMITED' ||
            errorCode === 'INTERNAL_SERVER_ERROR',
          Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
        );
      }

      if (!payload?.data) {
        throw new LinearFeedbackRequestError(
          'Linear feedback request returned no data',
          false,
        );
      }
      return payload.data;
    } catch (error) {
      if (error instanceof LinearFeedbackRequestError) throw error;
      throw new LinearFeedbackRequestError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Linear feedback request timed out'
          : 'Linear feedback request failed',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
