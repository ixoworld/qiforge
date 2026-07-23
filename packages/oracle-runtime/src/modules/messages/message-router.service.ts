import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { getProviderChatModel } from '../../llm/llm-provider.js';
import {
  workStatusProducer,
  type WorkStatusProducer,
} from '../../matrix/work-status-producer.js';
import type { CommerceContext } from '../../plugin-api/types.js';
import {
  getCommerceRouterPort,
  type CommerceRoutedService,
  type CommerceRouterPort,
} from './commerce-router-port.js';

/** Classifier verdicts below this confidence fall open to the free persona. */
const MIN_WORK_CONFIDENCE = 0.6;

/** Hard ceiling on a classifier call — a hung model must not hang the turn. */
const CLASSIFIER_TIMEOUT_MS = 15_000;

const classificationSchema = z.object({
  intent: z.enum(['support', 'work']),
  serviceId: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

/** Structured-output surface the router needs from a chat model. */
export interface RoutingStructuredModel {
  invoke(messages: BaseMessage[]): Promise<unknown>;
}

export interface RoutingModel {
  withStructuredOutput(schema: z.ZodType): RoutingStructuredModel;
}

/** Model factory — `params.model` carries the plugin's classifier override. */
export type RoutingModelFactory = (params?: { model?: string }) => ChatModel;

type ChatModel = ReturnType<typeof getProviderChatModel>;

const defaultModelFactory: RoutingModelFactory = (params) => {
  return getProviderChatModel('routing', params);
};

export interface MessageRouterDeps {
  getModel?: RoutingModelFactory;
  /** Status-card sink — only `emit` is used (the `routing` phase). */
  producer?: Pick<WorkStatusProducer, 'emit'>;
  logger?: Pick<Logger, 'warn' | 'debug'>;
}

/** One coalesced Matrix turn, as the bridge hands it over pre-delivery. */
export interface RouteTurnInput {
  roomId: string;
  /** Thread root event id — session id and engagement key. */
  threadId: string;
  senderDid: string;
  /** The coalesced user text of the turn. */
  text: string;
  /** The turn's requestId — keys the `work_status` card. */
  requestId: string;
}

/**
 * Routes each coalesced Matrix turn between the free support persona and the
 * contracted work persona (spec-style dual-role routing):
 *
 *   1. Active engagement for the thread → PURE sticky work mode: every
 *      message goes to the work agent, no scanning of any kind. The router
 *      never cancels — cancellation is an agent decision via the plugin's
 *      `cancel_work` tool (transport-level cancel phrase detection was
 *      rejected: false positives are catastrophic when a follow-up like
 *      "now edit the report" must simply continue the work).
 *   2. No engagement, no agent card → support, no model call.
 *   3. Otherwise one structured-output classification on the cheap `routing`
 *      model decides support vs work (+ which service). Low confidence and
 *      every model/lookup failure fall OPEN to support — never accidentally
 *      into billable work.
 *   4. Work intent passes the contract gate (no other job already running for
 *      this user, then the engine record + AuthZ snapshot, via the port)
 *      before an engagement starts; a gate failure routes to support with the
 *      failure context so the agent explains + shows the contract card.
 *
 * All commerce knowledge lives behind {@link CommerceRouterPort}, registered
 * by the oracle-payments plugin. No port ⇒ `route` returns `undefined` and
 * the turn is delivered exactly as before this router existed. HTTP turns
 * never come through here.
 */
export class MessageRouterService {
  private readonly getModel: RoutingModelFactory;
  private readonly producer: Pick<WorkStatusProducer, 'emit'>;
  private readonly logger: Pick<Logger, 'warn' | 'debug'>;

  constructor(deps: MessageRouterDeps = {}) {
    this.getModel = deps.getModel ?? defaultModelFactory;
    this.producer = deps.producer ?? workStatusProducer;
    this.logger = deps.logger ?? new Logger(MessageRouterService.name);
  }

  /** `true` when a commerce port is registered — the bridge gates status-card setup on this. */
  isActive(): boolean {
    return getCommerceRouterPort() !== null;
  }

  async route(input: RouteTurnInput): Promise<CommerceContext | undefined> {
    const port = getCommerceRouterPort();
    if (!port) {
      this.logger.debug(
        `No commerce port registered for thread ${input.threadId} — falling back to support.`,
      );
      return undefined;
    }

    try {
      return await this.decide(port, input);
    } catch (error) {
      // Fail open to the free persona: routing must never error a turn.
      this.logger.warn(
        `commerce routing failed for thread ${input.threadId} — falling back to support: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { mode: 'support' };
    }
  }

  private async decide(
    port: CommerceRouterPort,
    input: RouteTurnInput,
  ): Promise<CommerceContext> {
    const engagement = await port.getActiveEngagement(
      input.roomId,
      input.threadId,
    );
    if (engagement) {
      return { mode: 'work', engagement };
    }

    const services = await port.getServices();
    if (!services || services.length === 0) {
      // No agent card ⇒ classifier off — plain support, no model call.
      return { mode: 'support' };
    }

    this.producer.emit(input.requestId, 'routing');
    const classification = await this.classify(port, input.text, services);
    if (!classification || classification.intent === 'support') {
      return { mode: 'support' };
    }

    const service = services.find((s) => s.id === classification.serviceId);
    if (!service) {
      this.logger.warn(
        `classifier picked unknown serviceId "${classification.serviceId ?? ''}" — routing to support`,
      );
      return { mode: 'support' };
    }

    const gate = await port.checkContractGate({
      roomId: input.roomId,
      threadId: input.threadId,
      senderDid: input.senderDid,
      service,
    });
    if (!gate.ok) {
      return {
        mode: 'support',
        gate: {
          reason: gate.reason,
          serviceId: service.id,
          serviceName: service.name,
          ...(gate.inProgress !== undefined && { inProgress: gate.inProgress }),
        },
      };
    }

    const started = await port.startEngagement(
      input.roomId,
      input.threadId,
      gate.start,
    );
    if (!started.ok) {
      // The contract is fine but the job could not be started (the payment
      // reservation is a chain write). Same shape as a gate failure so the
      // agent explains rather than working unpaid.
      return {
        mode: 'support',
        gate: {
          reason: started.reason,
          serviceId: service.id,
          serviceName: service.name,
        },
      };
    }
    return { mode: 'work', engagement: started.engagement };
  }

  /**
   * Classify support vs work. Returns `null` on any model failure, timeout,
   * malformed output, or sub-threshold confidence — all of which mean
   * "support".
   */
  private async classify(
    port: CommerceRouterPort,
    text: string,
    services: CommerceRoutedService[],
  ): Promise<z.infer<typeof classificationSchema> | null> {
    let raw: unknown;
    try {
      const model = this.getModel(
        port.routerModel ? { model: port.routerModel } : undefined,
      ).withStructuredOutput(classificationSchema);

      raw = await withTimeout(
        model.invoke([
          new SystemMessage(buildClassifierPrompt(services)),
          new HumanMessage(text),
        ]),
        CLASSIFIER_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn(
        `commerce classifier failed — routing to support: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    const parsed = classificationSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        'commerce classifier returned a malformed verdict — routing to support',
      );
      return null;
    }
    if (
      parsed.data.intent === 'work' &&
      parsed.data.confidence < MIN_WORK_CONFIDENCE
    ) {
      this.logger.debug?.(
        `work verdict below confidence threshold (${parsed.data.confidence}) — routing to support`,
      );
      return { ...parsed.data, intent: 'support' };
    }
    return parsed.data;
  }
}

function buildClassifierPrompt(services: CommerceRoutedService[]): string {
  const catalog = services
    .map((s) => {
      const parts = [
        `- id: ${s.id}`,
        `  name: ${s.name}`,
        ...(s.description ? [`  description: ${s.description}`] : []),
        ...(s.tags?.length ? [`  tags: ${s.tags.join(', ')}`] : []),
        ...(s.examples?.length
          ? [
              `  examples: ${s.examples.map((e) => JSON.stringify(e)).join('; ')}`,
            ]
          : []),
      ];
      return parts.join('\n');
    })
    .join('\n');

  return [
    'You route one incoming chat message for a paid AI agent.',
    '',
    'Decide whether the message ASKS THE AGENT TO PERFORM one of its paid',
    'services ("work") or is anything else — questions about the services,',
    'pricing, status, small talk, or unrelated chat ("support").',
    '',
    'Paid services:',
    catalog,
    '',
    'Rules:',
    '- "work" ONLY when the user clearly requests that a listed service be',
    '  performed now. Include the matching serviceId.',
    '- Questions ABOUT a service (what it costs, what it includes, how to',
    '  contract) are "support".',
    '- When unsure, choose "support" with low confidence.',
    '- confidence is your certainty in the verdict, 0 to 1.',
  ].join('\n');
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`model call timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
