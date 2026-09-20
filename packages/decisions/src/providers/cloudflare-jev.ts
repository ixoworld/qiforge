import type {
  DecisionAdapter,
  DecisionProviderOptions,
  DecisionProviderResult,
  DecisionRequest,
} from '../index.js';
import { parseJevResult, toJevInput, validateJevRequest } from './jev.js';
import {
  requestJson,
  validateEndpoint,
  ProviderHttpError,
} from './transport.js';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com';
const JEV_MODEL = 'typesafe/jev';

export interface CloudflareJevAdapterOptions {
  accountId: string;
  apiToken: string;
  gatewayId?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class CloudflareJevDecisionError extends Error {
  readonly provider = 'cloudflare';
  readonly status?: number;
  readonly code?: string | number;

  constructor(
    message: string,
    opts: { status?: number; code?: string | number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'CloudflareJevDecisionError';
    this.status = opts.status;
    this.code = opts.code;
  }
}

export class CloudflareJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'cloudflare';
  readonly model = JEV_MODEL;

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly gatewayId?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CloudflareJevAdapterOptions) {
    if (!options.accountId.trim()) {
      throw new TypeError(
        'CloudflareJevDecisionAdapter accountId is required.',
      );
    }
    if (!options.apiToken.trim()) {
      throw new TypeError('CloudflareJevDecisionAdapter apiToken is required.');
    }

    this.accountId = options.accountId.trim();
    this.apiToken = options.apiToken.trim();
    this.gatewayId = options.gatewayId?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/$/, '');
    validateEndpoint(this.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
    if (this.gatewayId) {
      headers['cf-aig-gateway-id'] = this.gatewayId;
    }

    validateJevRequest(request);
    try {
      const payload = await requestJson(
        this.fetchImpl,
        `${this.baseUrl}/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run`,
        headers,
        { model: JEV_MODEL, input: toJevInput(request) },
        options?.signal,
      );
      return parseJevResult(unwrapCloudflareEnvelope(payload, 200), request);
    } catch (error) {
      if (error instanceof CloudflareJevDecisionError) throw error;
      if (
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new DOMException('Decision cancelled or timed out.', error.name);
      }
      throw new CloudflareJevDecisionError(
        'Cloudflare Jev request or response validation failed.',
        error instanceof ProviderHttpError ? { status: error.status } : {},
      );
    }
  }
}

function unwrapCloudflareEnvelope(payload: unknown, status: number): unknown {
  if (!isRecord(payload)) return payload;

  const looksLikeEnvelope = 'success' in payload || 'result' in payload;
  if (!looksLikeEnvelope) return payload;

  if (payload.success === false) {
    throw new CloudflareJevDecisionError(
      'Cloudflare Jev request was rejected by the provider.',
      {
        status,
        code: firstCloudflareErrorCode(payload.errors),
      },
    );
  }

  if (payload.success !== true || !('result' in payload)) {
    throw new CloudflareJevDecisionError(
      'Cloudflare Jev response envelope did not contain a result.',
      { status },
    );
  }

  return payload.result;
}

function firstCloudflareErrorCode(
  errors: unknown,
): string | number | undefined {
  if (!Array.isArray(errors)) return undefined;
  const first = errors[0];
  if (!isRecord(first)) return undefined;
  return typeof first.code === 'number' && Number.isSafeInteger(first.code)
    ? first.code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
