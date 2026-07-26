import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { getProviderChatModel } from '../../llm/llm-provider.js';
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
  logger?: Pick<Logger, 'log' | 'warn' | 'debug'>;
}

/** Log prefix shared by every routing line, so one grep shows the whole lane. */
const LOG_PREFIX = '[commerce-router]';

/**
 * Why a turn ended up in the mode it did. One value per branch of `decide`,
 * so the decision line reads back the exact path taken.
 */
type RoutingDecision =
  | 'inactive'
  | 'sticky-engagement'
  | 'continued-engagement'
  | 'no-services'
  | 'classifier-unavailable'
  | 'classifier-support'
  | 'low-confidence'
  | 'unknown-service'
  | 'gate-failed'
  | 'start-failed'
  | 'engagement-started'
  | 'error';

/** Routing metadata for the per-turn decision line. Never carries user text. */
interface RoutingDecisionFields {
  decision: RoutingDecision;
  mode: 'support' | 'work';
  serviceId?: string;
  reason?: string;
  /**
   * What actually failed, when the refusal has more to it than its reason —
   * the chain's rejection, the engine's status. Operators reading this line
   * after a user complaint need the same sentence the agent was given.
   */
  detail?: string;
  /**
   * `intent/confidence` as the classifier returned it, pre-threshold — or the
   * literal `skipped`, which is how the line states that no classification ran
   * at all because the user is already locked into a job.
   */
  classifier?: string;
  /** Where a continued engagement actually lives, when it is not this thread. */
  engagementRoomId?: string;
  engagementThreadId?: string;
}

/** One coalesced Matrix turn, as the bridge hands it over pre-delivery. */
export interface RouteTurnInput {
  roomId: string;
  /** Thread root event id — session id and engagement key. */
  threadId: string;
  senderDid: string;
  /** The coalesced user text of the turn. */
  text: string;
}

/**
 * Routes each coalesced Matrix turn between the free support persona and the
 * contracted work persona (spec-style dual-role routing):
 *
 *   1. Active engagement for the SENDER — in this thread, another thread, or
 *      another room → PURE sticky work mode: every message goes to the work
 *      agent, no scanning of any kind. Stickiness follows the user because
 *      the escrow does: the chain holds one active claim intent per (agent,
 *      user), and a bare main-timeline message is its own thread root, so a
 *      thread-scoped check would drop a live paid job back to the free
 *      persona the moment the user answered outside the thread. The router
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
 *
 * Every branch above ends in one decision line at normal log level (routing
 * metadata only, never message content). The mode it reports is the mode the
 * agent build reads: it decides which prompt overlay renders AND which tool
 * set binds, so this line is where a "wrong persona" report gets answered.
 */
export class MessageRouterService {
  private readonly getModel: RoutingModelFactory;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'debug'>;
  /** One-shot guard for the "commerce is off" first-use notice. */
  private inactiveNoticeLogged = false;

  constructor(deps: MessageRouterDeps = {}) {
    this.getModel = deps.getModel ?? defaultModelFactory;
    this.logger = deps.logger ?? new Logger(MessageRouterService.name);
  }

  /**
   * `true` when a commerce port is registered — the bridge gates the routing
   * call itself on this. The first `false` answer says so out loud: an inert
   * router makes every Matrix turn plain support with no overlay and no
   * commerce tools, which is indistinguishable from a routing bug in the chat
   * itself.
   */
  isActive(): boolean {
    const active = getCommerceRouterPort() !== null;
    if (!active && !this.inactiveNoticeLogged) {
      this.inactiveNoticeLogged = true;
      this.logger.log(
        `${LOG_PREFIX} inactive — no commerce router port is registered, so every Matrix turn ` +
          'runs as plain support with no commerce overlay and no commerce tools. Expected when ' +
          'the oracle-payments plugin is disabled (ORACLE_PAYMENTS_DISABLED=true) or its Nest ' +
          'module never initialised.',
      );
    }
    return active;
  }

  async route(input: RouteTurnInput): Promise<CommerceContext | undefined> {
    const port = getCommerceRouterPort();
    if (!port) {
      this.logDecision(input, { decision: 'inactive', mode: 'support' });
      return undefined;
    }

    try {
      return await this.decide(port, input);
    } catch (error) {
      // Fail open to the free persona: routing must never error a turn.
      this.logger.warn(
        `${LOG_PREFIX} routing failed for thread ${input.threadId} — falling back to support: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.logDecision(input, { decision: 'error', mode: 'support' });
      return { mode: 'support' };
    }
  }

  private async decide(
    port: CommerceRouterPort,
    input: RouteTurnInput,
  ): Promise<CommerceContext> {
    const active = await port.findActiveEngagement({
      senderDid: input.senderDid,
      roomId: input.roomId,
      threadId: input.threadId,
    });
    if (active) {
      // Same thread or not, live work stays work: the engagement is the
      // user's, not the thread's. A message typed on the main timeline (its
      // own thread root, per the Matrix ingress rules) must not drop a paid
      // job back to the free persona.
      //
      // This returns BEFORE `getServices` and before `classify`, and that is
      // the contract, not an optimisation: once a user is locked into a job
      // the classifier is never consulted again for them — not this turn, not
      // any turn until the engagement ends. Nothing below this line runs.
      const sameThread =
        active.roomId === input.roomId && active.threadId === input.threadId;
      this.logDecision(input, {
        decision: sameThread ? 'sticky-engagement' : 'continued-engagement',
        mode: 'work',
        serviceId: active.engagement.serviceId,
        classifier: 'skipped',
        ...(sameThread
          ? {}
          : {
              engagementRoomId: active.roomId,
              engagementThreadId: active.threadId,
            }),
      });
      return {
        mode: 'work',
        engagement: active.engagement,
        engagementRoomId: active.roomId,
        engagementThreadId: active.threadId,
      };
    }

    const services = await port.getServices();
    if (!services || services.length === 0) {
      // No agent card ⇒ classifier off — plain support, no model call.
      this.logDecision(input, { decision: 'no-services', mode: 'support' });
      return { mode: 'support' };
    }
    this.logger.debug?.(
      `${LOG_PREFIX} classifying thread ${input.threadId} against ${services.length} published service(s)`,
    );

    const classification = await this.classify(port, input.text, services);
    if (!classification) {
      this.logDecision(input, {
        decision: 'classifier-unavailable',
        mode: 'support',
      });
      return { mode: 'support' };
    }

    const verdict = `${classification.intent}/${classification.confidence}`;
    if (classification.intent === 'support') {
      this.logDecision(input, {
        decision: 'classifier-support',
        mode: 'support',
        classifier: verdict,
      });
      return { mode: 'support' };
    }
    if (classification.confidence < MIN_WORK_CONFIDENCE) {
      // Fail open: a hesitant work verdict never spends the user's money.
      this.logDecision(input, {
        decision: 'low-confidence',
        mode: 'support',
        classifier: verdict,
        ...(classification.serviceId !== undefined && {
          serviceId: classification.serviceId,
        }),
      });
      return { mode: 'support' };
    }

    const service = services.find((s) => s.id === classification.serviceId);
    if (!service) {
      this.logger.warn(
        `${LOG_PREFIX} classifier picked unknown serviceId "${classification.serviceId ?? ''}" — routing to support`,
      );
      this.logDecision(input, {
        decision: 'unknown-service',
        mode: 'support',
        classifier: verdict,
        ...(classification.serviceId !== undefined && {
          serviceId: classification.serviceId,
        }),
      });
      return { mode: 'support' };
    }

    const gate = await port.checkContractGate({
      roomId: input.roomId,
      threadId: input.threadId,
      senderDid: input.senderDid,
      service,
    });
    if (!gate.ok) {
      this.logDecision(input, {
        decision: 'gate-failed',
        mode: 'support',
        serviceId: service.id,
        reason: gate.reason,
        ...(gate.detail !== undefined && { detail: gate.detail }),
        classifier: verdict,
      });
      return {
        mode: 'support',
        gate: {
          reason: gate.reason,
          serviceId: service.id,
          serviceName: service.name,
          ...(gate.detail !== undefined && { detail: gate.detail }),
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
      this.logDecision(input, {
        decision: 'start-failed',
        mode: 'support',
        serviceId: service.id,
        reason: started.reason,
        ...(started.detail !== undefined && { detail: started.detail }),
        classifier: verdict,
      });
      return {
        mode: 'support',
        gate: {
          reason: started.reason,
          serviceId: service.id,
          serviceName: service.name,
          ...(started.detail !== undefined && { detail: started.detail }),
        },
      };
    }
    this.logDecision(input, {
      decision: 'engagement-started',
      mode: 'work',
      serviceId: service.id,
      classifier: verdict,
    });
    return {
      mode: 'work',
      engagement: started.engagement,
      engagementRoomId: input.roomId,
      engagementThreadId: input.threadId,
    };
  }

  /**
   * One line per routed turn — routing metadata only, never message content.
   * Visible at normal log level: it is the record of which persona ran and
   * why, which is otherwise only recoverable by re-reading the source.
   */
  private logDecision(
    input: RouteTurnInput,
    fields: RoutingDecisionFields,
  ): void {
    this.logger.log(
      [
        `${LOG_PREFIX} thread=${input.threadId}`,
        `mode=${fields.mode}`,
        `decision=${fields.decision}`,
        ...(fields.serviceId ? [`service=${fields.serviceId}`] : []),
        ...(fields.reason ? [`reason=${fields.reason}`] : []),
        ...(fields.detail ? [`detail="${fields.detail}"`] : []),
        ...(fields.classifier ? [`classifier=${fields.classifier}`] : []),
        ...(fields.engagementRoomId
          ? [`engagementRoom=${fields.engagementRoomId}`]
          : []),
        ...(fields.engagementThreadId
          ? [`engagementThread=${fields.engagementThreadId}`]
          : []),
      ].join(' '),
    );
  }

  /**
   * Classify support vs work. Returns the verdict verbatim — the confidence
   * threshold is applied by `decide`, so the decision log can report what the
   * model actually said. `null` on any model failure, timeout, or malformed
   * output, all of which mean "support".
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
        `${LOG_PREFIX} classifier failed — routing to support: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    const parsed = classificationSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        `${LOG_PREFIX} classifier returned a malformed verdict — routing to support`,
      );
      return null;
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
