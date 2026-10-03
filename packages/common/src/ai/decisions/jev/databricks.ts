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
  toJevQuestions,
} from './wire.js';

export const DATABRICKS_OPENJEV_MODEL =
  'system.ai.openjev-qwen35-4b';
export const DATABRICKS_AI_DECIDE_VERSION = '1.0';

interface DatabricksBaseOptions {
  workspaceUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface DatabricksSystemOneAdapterOptions
  extends DatabricksBaseOptions {
  model?: string;
}

export interface DatabricksAiDecideAdapterOptions
  extends DatabricksBaseOptions {
  functionVersion?: string;
}

function normalizeWorkspaceUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(trimmed)) {
    throw new TypeError('Databricks workspaceUrl must use https.');
  }
  return trimmed;
}

function authHeader(token: string): string {
  if (!token.trim()) throw new TypeError('Databricks token is required.');
  return `Basic ${globalThis.btoa(`token:${token.trim()}`)}`;
}

async function readJson(
  response: Response,
  message: string,
): Promise<unknown> {
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
 * Pinned model-service path through Unity Gateway's TypeSafe System One route.
 * The requested model service and returned backend model are recorded
 * separately because Databricks documents that they may differ.
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
    this.workspaceUrl = normalizeWorkspaceUrl(options.workspaceUrl);
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
        apiDialect: 'systemone-v1',
        requestedModel: this.model,
        ...(result.modelVersion ? { returnedModel: result.modelVersion } : {}),
        modelPinning: 'mutable',
        providerArtifactRef: this.model,
      },
    };
  }
}

const aiDecideEnvelopeSchema = z.object({
  response: z.unknown(),
  metadata: z.object({ version: z.string() }),
});

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
    this.workspaceUrl = normalizeWorkspaceUrl(options.workspaceUrl);
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

    const result = parseJevResult(
      envelope.data.response,
      'databricks',
      response.status,
    );
    return {
      ...result,
      provenance: {
        apiDialect: 'databricks-ai-decide-v1',
        functionVersion: envelope.data.metadata.version,
        modelPinning: 'mutable',
        providerArtifactRef: `databricks:ai_decide:${envelope.data.metadata.version}`,
      },
    };
  }
}
