import { describe, expect, it, vi } from 'vitest';
import type { FeedbackIssue } from './contract';
import {
  LinearFeedbackError,
  LinearFeedbackSink,
  linearFeedbackDescription,
} from './linear-sink';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');

const issue: FeedbackIssue = {
  submissionId: '8103aeac-96e5-441b-9f87-639beca83483',
  feedback: 'The answer should explain the trade-off.',
  submittedAt: '2026-10-05T12:00:00.123Z',
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

const destination = {
  apiUrl: 'https://api.linear.app/graphql',
  apiKey: 'lin_api_key',
  teamId: 'c781a53a-d432-469f-9c9c-2345a0f8243b',
  projectId: '6c1474a9-620c-4e3c-b443-0263992f3b55',
  labelIds: ['11111111-2222-4333-8444-555555555555'],
};

/**
 * Linear sends its global request-window headers on EVERY response, failed
 * or not; the reset is when the hour's window resets, not a retry hint.
 */
const LINEAR_WINDOW_HEADERS = {
  'x-ratelimit-requests-limit': '5000',
  'x-ratelimit-requests-remaining': '4990',
  'x-ratelimit-requests-reset': String(NOW + 45 * 60_000),
};
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...LINEAR_WINDOW_HEADERS,
      ...headers,
    },
  });
const notFound = () => json({ data: { issues: { nodes: [] } } });
const found = () => json({ data: { issues: { nodes: [{ id: 'existing' }] } } });
const created = () =>
  json({ data: { issueCreate: { success: true, issue: { id: 'issue-1' } } } });

interface Sent {
  query: string;
  variables: Record<string, unknown> & {
    input?: Record<string, unknown> & { description: string };
  };
}

function harness(...responses: Array<() => Response | Promise<Response>>) {
  const queue = [...responses];
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const next = queue.shift();
      if (!next) throw new Error('unexpected Linear call');
      return next();
    },
  );
  const sleep = vi.fn(async (_ms: number) => undefined);
  const sink = new LinearFeedbackSink(destination, {
    fetch: fetchMock,
    sleep,
    now: () => NOW,
  });
  const sent = (): Sent[] =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  const operations = () =>
    sent().map((s) => (s.query.includes('issueCreate') ? 'create' : 'find'));
  return { sink, fetchMock, sleep, sent, operations };
}

describe('linearFeedbackDescription', () => {
  it('holds the feedback, the pseudonyms and the allowlisted context, and states what was left out', () => {
    const description = linearFeedbackDescription(issue);
    expect(description).toContain(issue.feedback);
    expect(description).toContain(issue.userPseudonym);
    expect(description).toContain(issue.messageFingerprint);
    expect(description).toContain('| Surface | workspace |');
    expect(description).toContain(
      'No prompt, response, reasoning, tool data, attachment, raw DID',
    );
  });

  it('renders the feedback verbatim in a fenced block that the text cannot close', () => {
    const feedback =
      '## Safe context\n![beacon](https://evil.example/p.png)\n```\nstill inside\n```\n[link](https://evil.example)';
    const description = linearFeedbackDescription({ ...issue, feedback });
    const lines = description.split('\n');
    const open = lines.indexOf('````text');
    const close = lines.indexOf('````', open + 1);
    expect(open).toBeGreaterThan(0);
    expect(lines.slice(open + 1, close).join('\n')).toBe(feedback);
    // Outside the fence the document keeps its own three headings; the
    // injected heading, image and link only exist as text inside it.
    const outside = [...lines.slice(0, open), ...lines.slice(close + 1)];
    expect(outside.filter((line) => line.startsWith('## '))).toEqual([
      '## Feedback',
      '## Safe context',
      '## Privacy',
    ]);
    expect(outside.join('\n')).not.toContain('evil.example');
  });

  it('cannot break out of the context table', () => {
    const description = linearFeedbackDescription({
      ...issue,
      agent: { ...issue.agent, name: 'Evil | Agent\n## Injected' },
    });
    expect(description).toContain('| Agent name | Evil   Agent ## Injected |');
  });
});

describe('LinearFeedbackSink', () => {
  it('looks for the message marker, then creates one issue with a neutral title in the configured team and project', async () => {
    const h = harness(notFound, created);
    expect(await h.sink.submit(issue)).toBe('created');

    expect(h.operations()).toEqual(['find', 'create']);
    const [find, create] = h.sent();
    expect(find!.variables).toEqual({
      projectId: destination.projectId,
      marker: issue.messageFingerprint,
    });
    expect(create!.variables.input).toMatchObject({
      teamId: destination.teamId,
      projectId: destination.projectId,
      labelIds: destination.labelIds,
      title: '[Agent feedback] workspace · 2026-10-05T12:00:00Z',
    });
    expect(create!.variables.input!.title).not.toContain(issue.feedback);
    expect(create!.variables.input!.description).toContain(
      issue.messageFingerprint,
    );
    const [url, init] = h.fetchMock.mock.calls[1]!;
    expect(url).toBe(destination.apiUrl);
    // Personal API keys go in as-is, without "Bearer".
    expect(new Headers(init?.headers).get('authorization')).toBe(
      destination.apiKey,
    );
  });

  it('omits labelIds when none are configured', async () => {
    const queue = [notFound, created];
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => queue.shift()!(),
    );
    await new LinearFeedbackSink(
      { ...destination, labelIds: [] },
      { fetch: fetchMock, sleep: async () => undefined },
    ).submit(issue);
    const create = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(create.variables.input).not.toHaveProperty('labelIds');
  });

  it('treats an existing marker as delivered without creating a second issue', async () => {
    const h = harness(found);
    expect(await h.sink.submit(issue)).toBe('existing');
    expect(h.operations()).toEqual(['find']);
  });

  it('rechecks the marker before retrying a create whose outcome is unknown', async () => {
    const h = harness(notFound, () => json({}, 500), found);
    // The create that failed is the one that landed: it was this call's.
    expect(await h.sink.submit(issue)).toBe('created');
    expect(h.operations()).toEqual(['find', 'create', 'find']);
    expect(h.sleep).toHaveBeenCalledWith(250);
  });

  // Every fixture carries the hour's window reset (45 minutes ahead): a 5xx
  // must back off, not read it as "wait 45 minutes" and give up at once.
  it('gives up after three create attempts with backoff', async () => {
    const h = harness(
      notFound,
      () => json({}, 503),
      notFound,
      () => json({}, 503),
      notFound,
      () => json({}, 503),
    );
    await expect(h.sink.submit(issue)).rejects.toThrow(
      'Linear feedback request failed (503)',
    );
    expect(h.operations()).toEqual([
      'find',
      'create',
      'find',
      'create',
      'find',
      'create',
    ]);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it('waits for a near Linear rate-limit reset (epoch ms header) and retries', async () => {
    const h = harness(
      () =>
        json({ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 400, {
          'x-ratelimit-requests-reset': String(NOW + 1_500),
        }),
      notFound,
      created,
    );
    await h.sink.submit(issue);
    expect(h.sleep).toHaveBeenCalledWith(1_500);
    expect(h.operations()).toEqual(['find', 'find', 'create']);
  });

  it('treats HTTP 429 as a rate limit and waits for its reset', async () => {
    const h = harness(
      notFound,
      () =>
        json({}, 429, {
          'x-ratelimit-requests-reset': String(NOW + 800),
        }),
      notFound,
      created,
    );
    expect(await h.sink.submit(issue)).toBe('created');
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([800]);
  });

  it('backs off on a failed lookup too, ignoring the window reset', async () => {
    const h = harness(() => json({}, 502), notFound, created);
    expect(await h.sink.submit(issue)).toBe('created');
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([250]);
  });

  it('does not wait for a distant Linear rate-limit reset', async () => {
    const h = harness(() =>
      json({ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 400, {
        'x-ratelimit-endpoint-requests-reset': String(NOW + 60_000),
      }),
    );
    await expect(h.sink.submit(issue)).rejects.toThrow(
      'Linear feedback request failed (400/RATELIMITED)',
    );
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('rejects GraphQL errors on HTTP 200 without retrying input errors', async () => {
    const h = harness(() =>
      json({
        errors: [
          { message: 'invalid', extensions: { code: 'BAD_USER_INPUT' } },
        ],
      }),
    );
    const error = await h.sink.submit(issue).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinearFeedbackError);
    expect(error).toMatchObject({
      message: 'Linear feedback request failed (200/BAD_USER_INPUT)',
      retryable: false,
    });
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unconfirmed create', async () => {
    const h = harness(notFound, () =>
      json({ data: { issueCreate: { success: false, issue: null } } }),
    );
    await expect(h.sink.submit(issue)).rejects.toThrow(
      'Linear did not confirm the feedback issue',
    );
  });

  it('never puts the feedback text in an error message', async () => {
    const h = harness(notFound, () =>
      json({ errors: [{ message: issue.feedback }] }, 400),
    );
    const error = await h.sink.submit(issue).catch((e: unknown) => e);
    expect(String(error)).not.toContain(issue.feedback);
  });
});
