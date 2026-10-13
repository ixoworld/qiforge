import { z } from 'zod';
import type {
  DecisionAdapter,
  DecisionProviderOptions,
  DecisionProviderResult,
  DecisionRequest,
} from '../types.js';
import {
  JevDecisionError,
  parseJevResult,
  systemOneInferenceProvenance,
  toJevQuestions,
} from './wire.js';

export const DATABRICKS_OPENJEV_MODEL = 'system.ai.openjev-qwen35-4b';
export const DATABRICKS_AI_DECIDE_VERSION = '1.0';

interface DatabricksBaseOptions {
  workspaceUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface DatabricksSystemOneAdapterOptions extends DatabricksBaseOptions {
  model?: string;
}

export interface DatabricksAiDecideAdapterOptions extends DatabricksBaseOptions {
  functionVersion?: string;
}

export const DATABRICKS_WORKSPACE_URL_REQUIREMENT =
  'must be the workspace origin, https://<host> with no path, query, fragment or credentials';

/**
 * Parses a Databricks workspace URL and returns its origin, or `undefined`
 * when it is not an `https:` origin. A URL copied from the browser
 * (`https://<host>/?o=123`) is refused rather than trimmed, since the route
 * paths are appended to the origin and a query would end up in the middle.
 */
export function databricksWorkspaceOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return url.origin;
}

function workspaceOrigin(value: string): string {
  const origin = databricksWorkspaceOrigin(value);
  if (!origin) {
    throw new TypeError(
      `Databricks workspaceUrl ${DATABRICKS_WORKSPACE_URL_REQUIREMENT}.`,
    );
  }
  return origin;
}

/**
 * HTTP Basic with the literal user `token` and the workspace token as the
 * password, as the System One route documents (`curl -u token:$TOKEN`). The
 * ai_decide REST reference names no scheme of its own, so it uses the same
 * workspace credential.
 */
function authHeader(token: string): string {
  if (!token.trim()) throw new TypeError('Databricks token is required.');
  return `Basic ${globalThis.btoa(`token:${token.trim()}`)}`;
}

async function readJson(response: Response, message: string): Promise<unknown> {
  if (!response.ok) {
    throw new JevDecisionError('databricks', message, {
      status: response.status,
    });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new JevDecisionError(
      'databricks',
      'Databricks decision response was not valid JSON.',
      { status: response.status, cause },
    );
  }
}

/**
 * Explicit Unity Catalog model-service path through the AI Gateway's TypeSafe
 * System One route (`POST /ai-gateway/typesafe/v1/systemone`). The requested
 * model service and the returned backend model are recorded separately
 * because Databricks documents that they may differ, which is also why the
 * model pinning is `mutable` rather than `pinned`.
 */
export class DatabricksSystemOneDecisionAdapter implements DecisionAdapter {
  readonly provider = 'databricks';
  readonly model: string;
  readonly capabilities = {
    apiDialect: 'systemone-v1' as const,
    primitives: ['boolean', 'choice', 'ordinal'] as const,
    answerSemantics: 'distribution' as const,
    modelPinning: 'mutable' as const,
  };

  private readonly workspaceUrl: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: DatabricksSystemOneAdapterOptions) {
    this.workspaceUrl = workspaceOrigin(options.workspaceUrl);
    this.authorization = authHeader(options.token);
    this.model = options.model?.trim() || DATABRICKS_OPENJEV_MODEL;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.workspaceUrl}/ai-gateway/typesafe/v1/systemone`,
        {
          method: 'POST',
          headers: {
            Authorization: this.authorization,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            state: request.state,
            questions: toJevQuestions(request),
          }),
          signal: options?.signal,
        },
      );
    } catch (cause) {
      if (options?.signal?.aborted) throw cause;
      throw new JevDecisionError(
        'databricks',
        'Databricks System One request failed before a response was received.',
        { cause },
      );
    }

    const payload = await readJson(
      response,
      'Databricks System One request returned a non-success HTTP status.',
    );
    const result = parseJevResult(payload, 'databricks', response.status);
    return {
      ...result,
      provenance: {
        method: { kind: 'provider-native' },
        ...systemOneInferenceProvenance(
          this.model,
          result.modelVersion,
          this.capabilities.modelPinning,
        ),
      },
    };
  }
}

/**
 * The ai_decide REST response (`POST /api/2.0/ai-functions/ai-decide`):
 * `{ response: { answers }, metadata: { version } }`. Its choice and score
 * answers have the System One fields (`choice`/`probabilities`/`confidence`,
 * `score`/`probabilities`/`legend`/`confidence`), but a noul answer carries
 * its probability as `probability`, where System One uses `noul`. The answers
 * are therefore rebound to the System One shape before the shared parser
 * validates them, instead of being handed over as-is.
 */
const aiDecideEnvelopeSchema = z.object({
  response: z.looseObject({
    answers: z.record(z.string(), z.looseObject({ type: z.string() })),
  }),
  metadata: z.object({ version: z.string().min(1) }),
});

const aiDecideNoulAnswerSchema = z.looseObject({
  type: z.literal('noul'),
  probability: z.number(),
});

function toSystemOneAnswers(
  answers: Record<string, { type: string }>,
  status: number,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => {
      if (answer.type !== 'noul') return [name, answer];
      const noul = aiDecideNoulAnswerSchema.safeParse(answer);
      if (!noul.success) {
        throw new JevDecisionError(
          'databricks',
          'Databricks ai_decide noul answer did not carry a numeric probability.',
          { status },
        );
      }
      return [name, { type: 'noul', noul: noul.data.probability }];
    }),
  );
}

/**
 * Databricks managed ai_decide path. It intentionally has a different
 * assurance class from the model-service adapter: callers pin the function
 * API version, while Databricks may change the underlying model.
 */
export class DatabricksAiDecideDecisionAdapter implements DecisionAdapter {
  readonly provider = 'databricks';
  readonly model = 'ai_decide';
  readonly capabilities = {
    apiDialect: 'databricks-ai-decide-v1' as const,
    primitives: ['boolean', 'choice', 'ordinal'] as const,
    answerSemantics: 'distribution' as const,
    modelPinning: 'mutable' as const,
  };

  private readonly workspaceUrl: string;
  private readonly authorization: string;
  private readonly functionVersion: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: DatabricksAiDecideAdapterOptions) {
    this.workspaceUrl = workspaceOrigin(options.workspaceUrl);
    this.authorization = authHeader(options.token);
    this.functionVersion =
      options.functionVersion?.trim() || DATABRICKS_AI_DECIDE_VERSION;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.workspaceUrl}/api/2.0/ai-functions/ai-decide`,
        {
          method: 'POST',
          headers: {
            Authorization: this.authorization,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            state: request.state,
            questions: toJevQuestions(request),
            options: { version: this.functionVersion },
          }),
          signal: options?.signal,
        },
      );
    } catch (cause) {
      if (options?.signal?.aborted) throw cause;
      throw new JevDecisionError(
        'databricks',
        'Databricks ai_decide request failed before a response was received.',
        { cause },
      );
    }

    const payload = await readJson(
      response,
      'Databricks ai_decide request returned a non-success HTTP status.',
    );
    const envelope = aiDecideEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new JevDecisionError(
        'databricks',
        'Databricks ai_decide response did not match the expected envelope.',
        { status: response.status },
      );
    }

    // `metadata.version` is the function API version that evaluated the
    // request. Databricks accepts only the versions it documents, so a
    // different one means the request was not evaluated as configured.
    if (envelope.data.metadata.version !== this.functionVersion) {
      throw new JevDecisionError(
        'databricks',
        'Databricks ai_decide answered with a different function version than requested.',
        { status: response.status },
      );
    }

    const result = parseJevResult(
      {
        answers: toSystemOneAnswers(
          envelope.data.response.answers,
          response.status,
        ),
      },
      'databricks',
      response.status,
    );
    return {
      ...result,
      provenance: {
        method: { kind: 'provider-native' },
        apiDialect: 'databricks-ai-decide-v1',
        functionVersion: envelope.data.metadata.version,
        modelPinning: 'mutable',
        providerArtifactRef: `databricks:ai_decide:${envelope.data.metadata.version}`,
      },
    };
  }
}
