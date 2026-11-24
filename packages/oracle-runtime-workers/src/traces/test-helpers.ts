/**
 * TEST ONLY (excluded from the package files, like `test-do.ts`): a fake
 * IXO Traces ingest that decodes what the tracer sends and validates it
 * against the service's own schema (`fixtures/turn-schema.ts`).
 */
import { AIMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  attachModelCall,
  MODEL_CALL_METADATA_KEY,
  type ModelCallRecord,
} from '../llm/model-call';
import type { Logger } from '../plugin-api/types';
import type { TracesConfig } from './config';
import { TurnSchema, TurnStartSchema } from './fixtures/turn-schema';
import { TurnTracer, type TurnTracerOptions } from './turn-tracer';

export const TEST_CONFIG: TracesConfig = {
  apiKey: 'ixt_w_testtest_secret',
  baseUrl: 'https://traces.test',
};

export interface ReceivedRequest {
  path: string;
  headers: Record<string, string>;
  /** The decoded JSON body. */
  body: Record<string, unknown>;
  bytes: number;
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function bytesOf(body: BodyInit | null | undefined): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new Error('unexpected body type');
}

/** A fake ingest: records every request, answers from `answer` (default 201). */
export function fakeIngest(
  answer: (
    path: string,
    attempt: number,
  ) => Response | Promise<Response> = () => new Response(null, { status: 201 }),
) {
  const received: ReceivedRequest[] = [];
  let attempts = 0;
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    attempts += 1;
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = bytesOf(init.body);
    const text =
      headers['content-encoding'] === 'gzip'
        ? await gunzip(raw)
        : new TextDecoder().decode(raw);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('body is not an object');
    received.push({
      path: url.pathname,
      headers,
      body: Object.fromEntries(Object.entries(parsed)),
      bytes: raw.byteLength,
    });
    return answer(url.pathname, attempts);
  };
  return {
    fetch,
    received,
    turns: () => received.filter((r) => r.path === '/v1/ingest/turns'),
    starts: () => received.filter((r) => r.path === '/v1/ingest/turns/start'),
    attempts: () => attempts,
  };
}

/** Parse with the service's schema; throws with the issues when it refuses. */
export function validTurn(body: unknown) {
  const result = TurnSchema.safeParse(body);
  if (!result.success)
    throw new Error(
      `turn refused by the contract: ${JSON.stringify(result.error.issues)}`,
    );
  return result.data;
}

export function validStart(body: unknown) {
  const result = TurnStartSchema.safeParse(body);
  if (!result.success)
    throw new Error(
      `marker refused by the contract: ${JSON.stringify(result.error.issues)}`,
    );
  return result.data;
}

export const quietLogger: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A tracer over a fake ingest, collecting what it hands to `waitUntil`. */
export function tracerHarness(
  overrides: Partial<TurnTracerOptions> = {},
  ingest = fakeIngest(),
) {
  const background: Promise<unknown>[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    log: (m: unknown) => logs.push(String(m)),
    warn: (m: unknown) => logs.push(String(m)),
    error: (m: unknown) => logs.push(String(m)),
  };
  const tracer = new TurnTracer({
    config: TEST_CONFIG,
    waitUntil: (work) => {
      background.push(work);
    },
    logger,
    threadId: '$thread-1',
    userId: 'did:ixo:ixo1testuser',
    userText: 'hello there',
    oracleDid: 'did:ixo:ixo1oracle',
    network: 'devnet',
    channel: 'whatsapp',
    requestId: 'req-1',
    finishGraceMs: 50,
    transport: { fetch: ingest.fetch, sleep: async () => undefined },
    ...overrides,
  });
  return {
    tracer,
    ingest,
    background,
    logs,
    /** Settle every background job (and the jobs they start). */
    async settle(): Promise<void> {
      for (let i = 0; i < background.length; i += 1) await background[i];
    },
  };
}

export function record(
  overrides: Partial<ModelCallRecord> = {},
): ModelCallRecord {
  return {
    role: 'main',
    paidBy: 'platform',
    requestedModel: 'openai/gpt-5.6-luna',
    servedModel: 'openai/gpt-5.6-luna-20260709',
    provider: 'OpenAI',
    fallback: false,
    modelFallback: false,
    providerFallback: false,
    promptTokens: 1200,
    cachedTokens: 800,
    outputTokens: 40,
    costUsd: 0.0021,
    durationMs: 20,
    ok: true,
    ...overrides,
  };
}

/** A chat model that keeps a call record on its reply (or error), like the platform model. */
export class RecordingModel extends FakeListChatModel {
  constructor(
    private readonly kept: ModelCallRecord,
    private readonly opts: { fail?: boolean; reply?: string } = {},
  ) {
    super({ responses: [opts.reply ?? 'Hi! How can I help?'] });
  }

  override async _generate(): Promise<ChatResult> {
    if (this.opts.fail) {
      const error = new Error('502 upstream');
      attachModelCall(error, { ...this.kept, ok: false, errorKind: 'server' });
      throw error;
    }
    const text = this.opts.reply ?? 'Hi! How can I help?';
    return {
      generations: [
        {
          text,
          message: new AIMessage({
            content: text,
            response_metadata: { [MODEL_CALL_METADATA_KEY]: this.kept },
            usage_metadata: {
              input_tokens: this.kept.promptTokens ?? 0,
              output_tokens: this.kept.outputTokens ?? 0,
              total_tokens:
                (this.kept.promptTokens ?? 0) + (this.kept.outputTokens ?? 0),
            },
          }),
        },
      ],
    };
  }
}
