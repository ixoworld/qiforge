import { z } from '@ixo/oracle-runtime';

/**
 * Linear GraphQL helpers. No SDK — `fetch` + Zod, mirroring the Weather
 * plugin's Open-Meteo client. The agent never touches this file; the tools in
 * `linear-tools.ts` call these functions and hand back plain objects.
 *
 * Auth: Linear personal API keys go in the `Authorization` header verbatim
 * (no `Bearer` prefix). See https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/** Agent-facing priority labels → Linear's numeric priority scale. */
export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low' | 'none';

const PRIORITY_TO_LINEAR: Record<TicketPriority, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
};

const LINEAR_TO_PRIORITY: Record<number, TicketPriority> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'normal',
  4: 'low',
};

/**
 * Shape every Linear GraphQL response shares: `{ data, errors }`.
 *
 * Linear's top-level `message` is generic ("Argument Validation Error"). The
 * actionable text lives in `extensions.userPresentableMessage` (e.g. "teamId
 * must be a UUID.") — capture it so a misconfigured id surfaces legibly
 * instead of cryptically.
 */
const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z
          .object({ userPresentableMessage: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
});

/**
 * Execute one GraphQL operation and return its `data`, validated against the
 * caller-supplied schema. Throws a readable error when Linear returns a
 * transport error or a GraphQL `errors` array.
 */
async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  dataSchema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const resp = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`Linear HTTP ${resp.status} ${resp.statusText}`);
  }

  const envelope = envelopeSchema.parse(await resp.json());
  if (envelope.errors && envelope.errors.length > 0) {
    const detail = envelope.errors
      .map((e) => e.extensions?.userPresentableMessage ?? e.message)
      .join('; ');
    throw new Error(`Linear GraphQL error: ${detail}`);
  }
  return dataSchema.parse(envelope.data);
}

/** Common issue fields the tools surface back to the agent. */
export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: TicketPriority;
  status?: string;
}

const issueFields = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  priority: z.number(),
  state: z.object({ name: z.string() }).nullish(),
});

function toTicket(issue: z.infer<typeof issueFields>): LinearTicket {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    priority: LINEAR_TO_PRIORITY[issue.priority] ?? 'none',
    status: issue.state?.name,
  };
}

/** Create a new issue in the configured team. */
export async function createIssue(
  params: {
    apiKey: string;
    teamId: string;
    projectId: string;
    title: string;
    description: string;
    priority: TicketPriority;
  },
  signal?: AbortSignal,
): Promise<LinearTicket> {
  const data = await linearGraphql(
    params.apiKey,
    `mutation CreateIssue($input: IssueCreateInput!) {
       issueCreate(input: $input) {
         success
         issue { id identifier title url priority state { name } }
       }
     }`,
    {
      input: {
        teamId: params.teamId,
        projectId: params.projectId,
        title: params.title,
        description: params.description,
        priority: PRIORITY_TO_LINEAR[params.priority],
      },
    },
    z.object({
      issueCreate: z.object({
        success: z.boolean(),
        issue: issueFields.nullable(),
      }),
    }),
    signal,
  );

  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear rejected the issue creation.');
  }
  return toTicket(data.issueCreate.issue);
}

/** Append a comment to an existing issue (used to log triage progress). */
export async function addComment(
  params: { apiKey: string; issueId: string; body: string },
  signal?: AbortSignal,
): Promise<boolean> {
  const data = await linearGraphql(
    params.apiKey,
    `mutation AddComment($input: CommentCreateInput!) {
       commentCreate(input: $input) { success }
     }`,
    { input: { issueId: params.issueId, body: params.body } },
    z.object({ commentCreate: z.object({ success: z.boolean() }) }),
    signal,
  );
  return data.commentCreate.success;
}

/** Look an issue up by its identifier (e.g. `SUP-42`) or UUID. */
export async function getIssue(
  params: { apiKey: string; id: string },
  signal?: AbortSignal,
): Promise<LinearTicket | null> {
  const data = await linearGraphql(
    params.apiKey,
    `query GetIssue($id: String!) {
       issue(id: $id) { id identifier title url priority state { name } }
     }`,
    { id: params.id },
    z.object({ issue: issueFields.nullable() }),
    signal,
  );
  return data.issue ? toTicket(data.issue) : null;
}

/**
 * Search the configured project's issues by text. Matches the query against
 * issue title OR description (case-insensitive). Used to spot duplicates
 * before filing a new ticket.
 */
export async function searchIssues(
  params: { apiKey: string; projectId: string; query: string; limit?: number },
  signal?: AbortSignal,
): Promise<LinearTicket[]> {
  const first = Math.max(1, Math.min(25, params.limit ?? 10));
  const data = await linearGraphql(
    params.apiKey,
    `query SearchIssues($filter: IssueFilter, $first: Int) {
       issues(filter: $filter, first: $first) {
         nodes { id identifier title url priority state { name } }
       }
     }`,
    {
      first,
      filter: {
        and: [
          { project: { id: { eq: params.projectId } } },
          {
            or: [
              { title: { containsIgnoreCase: params.query } },
              { description: { containsIgnoreCase: params.query } },
            ],
          },
        ],
      },
    },
    z.object({ issues: z.object({ nodes: z.array(issueFields) }) }),
    signal,
  );
  return data.issues.nodes.map(toTicket);
}
