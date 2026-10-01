import type {
  BooleanDecisionAnswer,
  ChoiceDecisionAnswer,
  DecisionEvaluation,
} from '@ixo/common';
import type { DecisionTraceOptions } from '@ixo/common/ai/decisions';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { DecisionEvaluator } from '../../decisions/decision-runtime.js';
import { getProviderChatModel } from '../../llm/llm-provider.js';
import type { CommerceContext } from '../../plugin-api/types.js';
import {
  getCommerceRouterPort,
  type CommerceRoutedService,
  type CommerceRouterEngine,
  type CommerceRouterPort,
} from './commerce-router-port.js';

/**
 * Work verdicts below this confidence fall open to the free persona. Shared by
 * both routing engines: the LLM's self-reported confidence and the Decision's
 * work probability are measured against the same floor, so switching engines
 * never moves the line between free and billable.
 */
const MIN_WORK_CONFIDENCE = 0.6;

/** Hard ceiling on a classifier call — a hung model must not hang the turn. */
const CLASSIFIER_TIMEOUT_MS = 15_000;

const classificationSchema = z.object({
  intent: z.enum(['support', 'work']),
  serviceId: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

/** The one verdict shape every engine reduces to before the gate pipeline. */
type Classification = z.infer<typeof classificationSchema>;

/**
 * A classifiable turn's verdict together with the engine that produced it.
 * `engine` is the engine that actually answered — a `decision` turn that fell
 * back to the LLM reports `llm`. The raw Decision answers ride along so the
 * decision line can show what drove a Decision-routed turn.
 */
interface EngineVerdict {
  engine: CommerceRouterEngine;
  classification: Classification | null;
  workProbability?: number;
  serviceConfidence?: number;
}

/** The Decision's input, projected identically for shadow and live routing. */
interface RouteDecisionInput {
  text: string;
  services: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    examples?: string[];
  }>;
}

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
  getDecisionEvaluator?: () => DecisionEvaluator | undefined;
  logger?: Pick<Logger, 'log' | 'warn' | 'debug'>;
}

/** Log prefix shared by every routing line, so one grep shows the whole lane. */
const LOG_PREFIX = '[commerce-router]';
const SHADOW_LOG_PREFIX = '[commerce-router-shadow]';
/**
 * Comparison-only boundary for shadow telemetry. This is NOT a production
 * routing threshold; the raw probability is logged so calibration can choose
 * that later.
 */
const SHADOW_INTENT_BOUNDARY = 0.5;

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
  /** Which engine answered this turn. Absent when no classification ran. */
  engine?: CommerceRouterEngine;
  /**
   * `intent/confidence` as the classifier returned it, pre-threshold — or the
   * literal `skipped`, which is how the line states that no classification ran
   * at all because the user is already locked into a job.
   */
  classifier?: string;
  /** Raw Decision answers, present only when the `decision` engine routed. */
  workProbability?: number;
  serviceConfidence?: number;
  /** Where a continued engagement actually lives, when it is not this thread. */
  engagementRoomId?: string;
  engagementThreadId?: string;
}

/** One coalesced Matrix turn, as the bridge hands it over pre-delivery. */
export interface RouteTurnInput {
  roomId: string;
  /** Per-turn request id, when available, for joining async shadow telemetry. */
  requestId?: string;
  /** Abort a running Decision (shadow or live) when the turn is superseded. */
  abortSignal?: AbortSignal;
  /** Thread root event id — session id and engagement key. */
  threadId: string;
  senderDid: string;
  /** The coalesced user text of the turn. */
  text: string;
  /**
   * The turn's tracer and trace metadata. Routing runs before the graph,
   * outside any LangChain run, so without these its Decision is not traced.
   */
  trace?: DecisionTraceOptions;
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
 *   3. Otherwise one classification decides support vs work (+ which
 *      service): a structured-output call on the cheap `routing` model, or —
 *      with the port's `decision` engine — the bounded Decision, mapped to the
 *      same verdict shape. Low confidence and every model/lookup failure fall
 *      OPEN to support — never accidentally into billable work.
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
  private readonly getDecisionEvaluator: () => DecisionEvaluator | undefined;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'debug'>;
  /** One-shot guard for the "commerce is off" first-use notice. */
  private inactiveNoticeLogged = false;
  /**
   * One-shot guard for the `decision` engine's configuration fallback: a
   * missing evaluator or Decision name is a boot-time fact, so it is said once
   * per process rather than once per turn. Per-turn evaluation failures are
   * not guarded — each one warns.
   */
  private decisionUnavailableNoticeLogged = false;

  constructor(deps: MessageRouterDeps = {}) {
    this.getModel = deps.getModel ?? defaultModelFactory;
    this.getDecisionEvaluator = deps.getDecisionEvaluator ?? (() => undefined);
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

    const routed = await this.classifyTurn(port, input, services);
    const { classification } = routed;
    if (!classification) {
      this.logDecision(input, {
        decision: 'classifier-unavailable',
        mode: 'support',
        engine: routed.engine,
      });
      return { mode: 'support' };
    }

    // Every line below carries the same verdict fields, whichever engine
    // produced them, so one grep compares engines turn for turn.
    const verdict: Pick<
      RoutingDecisionFields,
      'engine' | 'classifier' | 'workProbability' | 'serviceConfidence'
    > = {
      engine: routed.engine,
      classifier: `${classification.intent}/${classification.confidence}`,
      ...(routed.workProbability !== undefined && {
        workProbability: routed.workProbability,
      }),
      ...(routed.serviceConfidence !== undefined && {
        serviceConfidence: routed.serviceConfidence,
      }),
    };
    if (classification.intent === 'support') {
      this.logDecision(input, {
        decision: 'classifier-support',
        mode: 'support',
        ...verdict,
      });
      return { mode: 'support' };
    }
    if (classification.confidence < MIN_WORK_CONFIDENCE) {
      // Fail open: a hesitant work verdict never spends the user's money.
      this.logDecision(input, {
        decision: 'low-confidence',
        mode: 'support',
        ...verdict,
        ...(classification.serviceId !== undefined && {
          serviceId: classification.serviceId,
        }),
      });
      return { mode: 'support' };
    }

    const service = services.find((s) => s.id === classification.serviceId);
    if (!service) {
      // For the decision engine this is also where the Decision's own
      // "no single service matches" option lands: not a catalog id ⇒ support.
      this.logger.warn(
        `${LOG_PREFIX} ${routed.engine} engine picked unknown serviceId "${classification.serviceId ?? ''}" — routing to support`,
      );
      this.logDecision(input, {
        decision: 'unknown-service',
        mode: 'support',
        ...verdict,
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
        ...verdict,
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
        ...verdict,
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
      ...verdict,
    });
    return {
      mode: 'work',
      engagement: started.engagement,
      engagementRoomId: input.roomId,
      engagementThreadId: input.threadId,
    };
  }

  /**
   * Produce the turn's verdict with whichever engine the port selects. The
   * `decision` engine routes on the bounded Decision and falls back to the LLM
   * for that turn when the Decision cannot answer; `llm` and `decision-shadow`
   * both route on the LLM, shadow additionally observing the Decision.
   */
  private async classifyTurn(
    port: CommerceRouterPort,
    input: RouteTurnInput,
    services: CommerceRoutedService[],
  ): Promise<EngineVerdict> {
    if (port.routerEngine === 'decision') {
      return this.classifyWithDecision(port, input, services);
    }

    const shadow = this.startDecisionShadow(port, input, services);
    const legacyStartedAt = Date.now();
    const classification = await this.classify(port, input.text, services);
    if (shadow) {
      this.observeDecisionShadow(
        shadow,
        input,
        services,
        classification,
        Date.now() - legacyStartedAt,
      );
    }
    return { engine: port.routerEngine ?? 'llm', classification };
  }

  /**
   * Route on the bounded Decision. Its two answers are reduced to the LLM's
   * verdict shape so the confidence floor, catalog check, contract gate and
   * engagement start run unchanged:
   *
   *   - work when `workRequestedNow` clears {@link MIN_WORK_CONFIDENCE}, with
   *     the chosen option as `serviceId` and the lower of the work probability
   *     and the choice confidence as `confidence`; the Decision's no-match
   *     option is not a catalog id and so lands in the unknown-service lane.
   *   - support otherwise, with `1 - workProbability` as `confidence`.
   *
   * Anything that stops the Decision from answering — no evaluator, no
   * Decision name, a provider error, a timeout, a malformed answer — warns
   * with safe metadata only and hands the turn to the LLM classifier. Fallback
   * is per turn: the next turn tries the Decision again.
   */
  private async classifyWithDecision(
    port: CommerceRouterPort,
    input: RouteTurnInput,
    services: CommerceRoutedService[],
  ): Promise<EngineVerdict> {
    const decisionName = port.routerDecisionName;
    const evaluator = this.getDecisionEvaluator();
    if (!decisionName || !evaluator) {
      if (!this.decisionUnavailableNoticeLogged) {
        this.decisionUnavailableNoticeLogged = true;
        this.logDecisionFallback(
          input,
          decisionName ? 'missing-evaluator' : 'missing-decision-name',
          'logged once per process',
        );
      }
      return this.classifyWithModel(port, input, services);
    }

    let evaluation: DecisionEvaluation;
    try {
      evaluation = await evaluateRouteDecision(
        evaluator,
        decisionName,
        input,
        services,
      );
    } catch (error) {
      this.logDecisionFallback(input, safeErrorType(error));
      return this.classifyWithModel(port, input, services);
    }

    const work = evaluation.answers.workRequestedNow;
    const service = evaluation.answers.service;
    if (work?.kind !== 'boolean' || service?.kind !== 'choice') {
      this.logDecisionFallback(input, 'malformed-answer');
      return this.classifyWithModel(port, input, services);
    }

    return {
      engine: 'decision',
      classification: toClassification(work, service),
      workProbability: work.probabilityTrue,
      serviceConfidence: service.confidence,
    };
  }

  /** The LLM classifier as an engine verdict — the `decision` engine's fallback. */
  private async classifyWithModel(
    port: CommerceRouterPort,
    input: RouteTurnInput,
    services: CommerceRoutedService[],
  ): Promise<EngineVerdict> {
    return {
      engine: 'llm',
      classification: await this.classify(port, input.text, services),
    };
  }

  /** Safe-metadata warn for a `decision` turn handed to the LLM classifier. */
  private logDecisionFallback(
    input: RouteTurnInput,
    reason: string,
    note?: string,
  ): void {
    this.logger.warn(
      [
        `${LOG_PREFIX} thread=${input.threadId}`,
        ...(input.requestId ? [`request=${input.requestId}`] : []),
        'engine=decision',
        'status=fallback',
        `reason=${reason}`,
        ...(note ? [`(${note})`] : []),
      ].join(' '),
    );
  }

  /**
   * Start the bounded Decision in parallel with the legacy classifier. The
   * returned promise is NEVER awaited by the routing path: shadow mode cannot
   * delay, authorize, start, or otherwise change the user's turn.
   */
  private startDecisionShadow(
    port: CommerceRouterPort,
    input: RouteTurnInput,
    services: CommerceRoutedService[],
  ): Promise<{ evaluation: DecisionEvaluation; latencyMs: number }> | null {
    if (port.routerEngine !== 'decision-shadow') return null;
    const decisionName = port.routerDecisionName;
    if (!decisionName) {
      this.logger.warn(
        `${SHADOW_LOG_PREFIX} thread=${input.threadId}${input.requestId ? ` request=${input.requestId}` : ''} status=unavailable reason=missing-decision-name`,
      );
      return null;
    }

    const evaluator = this.getDecisionEvaluator();
    if (!evaluator) {
      this.logger.warn(
        `${SHADOW_LOG_PREFIX} thread=${input.threadId}${input.requestId ? ` request=${input.requestId}` : ''} status=unavailable reason=missing-evaluator`,
      );
      return null;
    }

    const startedAt = Date.now();
    // Promise.resolve().then() also converts any synchronous preparation
    // failure into this shadow promise, keeping it out of the live route.
    return Promise.resolve()
      .then(() =>
        evaluateRouteDecision(evaluator, decisionName, input, services),
      )
      .then((evaluation) => ({
        evaluation,
        latencyMs: Date.now() - startedAt,
      }));
  }

  /**
   * Observe a shadow evaluation without blocking routing. Failures are reduced
   * to safe metadata: never log the provider's message because a third-party
   * error could echo Decision state.
   */
  private observeDecisionShadow(
    shadow: Promise<{ evaluation: DecisionEvaluation; latencyMs: number }>,
    input: RouteTurnInput,
    services: CommerceRoutedService[],
    legacy: Classification | null,
    legacyLatencyMs: number,
  ): void {
    void shadow
      .then(({ evaluation, latencyMs }) => {
        this.logDecisionShadow(
          evaluation,
          input,
          services,
          legacy,
          legacyLatencyMs,
          latencyMs,
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `${SHADOW_LOG_PREFIX} thread=${input.threadId}${input.requestId ? ` request=${input.requestId}` : ''} status=failed errorType=${safeErrorType(error)}`,
        );
      });
  }

  private logDecisionShadow(
    evaluation: DecisionEvaluation,
    input: RouteTurnInput,
    services: CommerceRoutedService[],
    legacy: Classification | null,
    legacyLatencyMs: number,
    decisionLatencyMs: number,
  ): void {
    const work = evaluation.answers.workRequestedNow;
    const service = evaluation.answers.service;
    if (work?.kind !== 'boolean' || service?.kind !== 'choice') {
      this.logger.warn(
        `${SHADOW_LOG_PREFIX} thread=${input.threadId}${input.requestId ? ` request=${input.requestId}` : ''} status=invalid-normalized-answer`,
      );
      return;
    }

    const decisionIntent =
      work.probabilityTrue >= SHADOW_INTENT_BOUNDARY ? 'work' : 'support';
    const selectedService = services.find(
      (candidate) => candidate.id === service.value,
    )?.id;
    const intentAgree =
      legacy === null ? undefined : legacy.intent === decisionIntent;
    const serviceAgree =
      legacy?.intent === 'work' && decisionIntent === 'work'
        ? legacy.serviceId === selectedService
        : undefined;

    this.logger.log(
      [
        `${SHADOW_LOG_PREFIX} thread=${input.threadId}`,
        ...(input.requestId ? [`request=${input.requestId}`] : []),
        'status=ok',
        `legacyIntent=${legacy?.intent ?? 'unavailable'}`,
        `legacyConfidence=${legacy?.confidence ?? 'unavailable'}`,
        `legacyService=${legacy?.serviceId ?? 'none'}`,
        `legacyLatencyMs=${legacyLatencyMs}`,
        `decisionIntentAt50=${decisionIntent}`,
        `workProbability=${work.probabilityTrue}`,
        `decisionService=${selectedService ?? 'none'}`,
        `serviceConfidence=${service.confidence}`,
        ...(intentAgree === undefined
          ? []
          : [`intentAgree=${String(intentAgree)}`]),
        ...(serviceAgree === undefined
          ? []
          : [`serviceAgree=${String(serviceAgree)}`]),
        `decisionLatencyMs=${decisionLatencyMs}`,
        `provider=${evaluation.provider}`,
        `model=${evaluation.model}`,
        ...(evaluation.modelVersion
          ? [`modelVersion=${evaluation.modelVersion}`]
          : []),
      ].join(' '),
    );
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
        ...(input.requestId ? [`request=${input.requestId}`] : []),
        `mode=${fields.mode}`,
        `decision=${fields.decision}`,
        ...(fields.serviceId ? [`service=${fields.serviceId}`] : []),
        ...(fields.reason ? [`reason=${fields.reason}`] : []),
        ...(fields.detail ? [`detail="${fields.detail}"`] : []),
        ...(fields.engine ? [`engine=${fields.engine}`] : []),
        ...(fields.classifier ? [`classifier=${fields.classifier}`] : []),
        ...(fields.workProbability !== undefined
          ? [`workProbability=${fields.workProbability}`]
          : []),
        ...(fields.serviceConfidence !== undefined
          ? [`serviceConfidence=${fields.serviceConfidence}`]
          : []),
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
  ): Promise<Classification | null> {
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

/**
 * One projection of the turn for the Decision, shared by shadow and live
 * routing so the two evaluate — and can be compared on — identical input.
 */
function toRouteDecisionInput(
  text: string,
  services: CommerceRoutedService[],
): RouteDecisionInput {
  return {
    text,
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      ...(service.description ? { description: service.description } : {}),
      ...(service.tags?.length ? { tags: service.tags } : {}),
      ...(service.examples?.length ? { examples: service.examples } : {}),
    })),
  };
}

/** Evaluate the route Decision, forwarding the turn's abort signal when it has one. */
function evaluateRouteDecision(
  evaluator: DecisionEvaluator,
  decisionName: string,
  input: RouteTurnInput,
  services: CommerceRoutedService[],
): Promise<DecisionEvaluation> {
  const decisionInput = toRouteDecisionInput(input.text, services);
  return evaluator.evaluateByName(decisionName, decisionInput, {
    ...input.trace,
    ...(input.abortSignal && { signal: input.abortSignal }),
  });
}

/** Reduce the Decision's two answers to the classifier's verdict shape. */
function toClassification(
  work: BooleanDecisionAnswer,
  service: ChoiceDecisionAnswer,
): Classification {
  if (work.probabilityTrue >= MIN_WORK_CONFIDENCE) {
    return {
      intent: 'work',
      serviceId: service.value,
      confidence: Math.min(work.probabilityTrue, service.confidence),
    };
  }
  // Rounded so the routing log line prints 0.03, not the float residue of
  // `1 - 0.97`; the value only feeds that line, never a threshold.
  return {
    intent: 'support',
    confidence: Number((1 - work.probabilityTrue).toFixed(4)),
  };
}

/**
 * An error's type name and nothing else. Provider messages can echo Decision
 * state (which includes the user's text), so they never reach a log line.
 */
function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : typeof error;
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
