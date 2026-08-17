import { ConfigService } from '@nestjs/config';
import type { ENV } from 'src/types';
import type { AnonymousFeedbackIssue } from './feedback-sink';
import {
  buildLinearFeedbackDescription,
  LinearFeedbackSink,
} from './linear-feedback.sink';

const issue: AnonymousFeedbackIssue = {
  submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
  feedback: 'The answer should explain the trade-off.',
  submittedAt: '2026-07-15T12:00:00.000Z',
  userPseudonym: `user_${'a'.repeat(64)}`,
  sessionFingerprint: `session_${'b'.repeat(64)}`,
  messageFingerprint: `message_${'c'.repeat(64)}`,
  agent: {
    did: 'did:ixo:agent',
    name: 'Agent',
    model: 'provider/model',
    provider: 'openrouter',
    runtimeBuildVersion: 'runtime-build',
  },
  context: {
    surface: 'workspace',
    locale: 'en',
    theme: 'dark',
    deviceClass: 'desktop',
    viewportBucket: 'wide',
    network: 'testnet',
    portalBuildVersion: 'portal-build',
  },
};

function createSink() {
  const values: Partial<Record<keyof ENV, string>> = {
    LINEAR_FEEDBACK_API_URL: 'https://api.linear.app/graphql',
    LINEAR_FEEDBACK_API_KEY: 'linear-secret',
    LINEAR_FEEDBACK_TEAM_ID: 'team-id',
    LINEAR_FEEDBACK_PROJECT_ID: 'project-id',
    LINEAR_FEEDBACK_LABEL_IDS: 'label-1,label-2',
  };
  const config = {
    get: vi.fn((key: keyof ENV, fallback?: string) => values[key] ?? fallback),
    getOrThrow: vi.fn((key: keyof ENV) => {
      const value = values[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService<ENV>;
  return new LinearFeedbackSink(config);
}

describe('LinearFeedbackSink', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a privacy-labelled issue without conversation content', () => {
    const description = buildLinearFeedbackDescription(issue);
    expect(description).toContain(issue.feedback);
    expect(description).toContain(issue.userPseudonym);
    expect(description).toContain('No prompt, response, reasoning');
    expect(description).not.toContain('raw-session-id');
    expect(description).not.toContain('raw-message-id');
  });

  it('checks the submission marker before creating one issue', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { issueCreate: { success: true, issue: { id: 'issue-id' } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await createSink().submit(issue);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(createRequest.variables.input).toMatchObject({
      teamId: 'team-id',
      projectId: 'project-id',
      labelIds: ['label-1', 'label-2'],
      title: '[Agent feedback] workspace · 2026-07-15T12:00:00Z',
    });
    expect(createRequest.variables.input.description).toContain(
      issue.submissionId,
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      'linear-secret',
    );
  });

  it('treats an existing submission marker as idempotent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { issues: { nodes: [{ id: 'existing' }] } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await createSink().submit(issue);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rechecks the marker before retrying an uncertain create', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 500,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { issues: { nodes: [{ id: 'existing' }] } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await createSink().submit(issue);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const operations = fetchMock.mock.calls.map(([_, request]) =>
      JSON.parse(request.body).query.includes('issueCreate')
        ? 'create'
        : 'find',
    );
    expect(operations).toEqual(['find', 'create', 'find']);
  });

  it('rejects GraphQL errors even when HTTP succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                message: 'invalid project',
                extensions: { code: 'BAD_USER_INPUT' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(createSink().submit(issue)).rejects.toThrow(
      'Linear feedback request failed',
    );
  });

  it('does not retry before a distant Linear rate-limit reset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [{ extensions: { code: 'RATELIMITED' } }],
        }),
        {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-requests-reset': String(Date.now() + 60_000),
          },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSink().submit(issue)).rejects.toThrow(
      'Linear feedback request failed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
