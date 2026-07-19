import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import { sha256Hex, type AuditSink } from '../kernel/audit.js';
import type { Logger } from '../types.js';
import type {
  RouteClassifier,
  RouteDecision,
  RouterConfig,
} from './route-config.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface SemanticRouterMiddlewareOptions {
  config: RouterConfig;
  classify: RouteClassifier;
  /**
   * Per-turn capability grant shared with the CapabilityGate: the router
   * ADDS to it, the gate reads it, and it dies with the request — nothing
   * is written to (checkpointed) graph state, so a route decision can
   * never become persistent authority.
   */
  routedCapabilities: Set<string>;
  /** Resolve a model role for the per-turn override (policy-constrained). */
  resolveModel: (role: string) => BaseChatModel;
  /** Emit the decision on the `router.update` UI channel. */
  emitRouter?: (payload: Record<string, unknown>) => void;
  audit?: AuditSink;
  sessionId: string;
  requestId: string;
  logger?: Logger;
}

/**
 * Per-turn semantic routing. `beforeAgent` classifies the incoming human
 * message; a confident match grants the route's capabilities FOR THIS TURN
 * (via the shared set the CapabilityGate consults), stages a model-role
 * override, and stages a delegation hint. `wrapModelCall` applies the
 * override and appends the hint to the system message.
 *
 * Failure semantics are fail-open TO THE DEFAULT: any classifier error or
 * no-match leaves the turn exactly as it would have been without a router —
 * default model, no extra capabilities. Every decision (or non-decision) is
 * audited and optionally emitted.
 */
export function createSemanticRouterMiddleware(
  options: SemanticRouterMiddlewareOptions,
): AgentMiddleware {
  const {
    config,
    classify,
    routedCapabilities,
    resolveModel,
    emitRouter,
    audit,
    sessionId,
    requestId,
  } = options;
  const logger = options.logger ?? NOOP_LOGGER;

  // Ephemeral per-request middleware instance: the decision lives here and
  // nowhere else.
  let decision: RouteDecision | null = null;

  const appendAudit = (detail: Record<string, unknown>): void => {
    if (!audit) return;
    void Promise.resolve(
      audit.append({
        kind: 'route.decision',
        at: new Date().toISOString(),
        sessionId,
        requestId,
        detail,
      }),
    ).catch(() => undefined);
  };

  return createMiddleware({
    name: 'SemanticRouterMiddleware',
    beforeAgent: async (state) => {
      if (config.strategy === 'off' || config.routes.length < 2) {
        return undefined;
      }
      const lastHuman = [...state.messages]
        .reverse()
        .find((message) => message instanceof HumanMessage);
      const text =
        typeof lastHuman?.content === 'string' ? lastHuman.content : '';
      if (!text.trim()) return undefined;

      try {
        decision = await classify({ text });
      } catch (err) {
        logger.warn(
          `[router] classification failed — proceeding unrouted: ${err instanceof Error ? err.message : String(err)}`,
        );
        appendAudit({
          step: 'route.none',
          reason: 'classifier-error',
          strategy: config.strategy,
        });
        decision = null;
        return undefined;
      }

      if (!decision) {
        appendAudit({
          step: 'route.none',
          reason: 'below-threshold-or-no-match',
          strategy: config.strategy,
        });
        return undefined;
      }

      for (const capability of decision.route.target.loadCapabilities ?? []) {
        routedCapabilities.add(capability);
      }

      const detail = {
        step: 'route.selected',
        route: decision.route.name,
        strategy: decision.strategy,
        confidence: decision.confidence,
        modelRole: decision.route.target.modelRole,
        routedCapabilities: decision.route.target.loadCapabilities ?? [],
        subAgentHint: Boolean(decision.route.target.subAgentHint),
        textDigest: await sha256Hex(text),
      };
      appendAudit(detail);
      if (config.emitEvents) emitRouter?.(detail);
      logger.log(
        `[router] route='${decision.route.name}' strategy=${decision.strategy} confidence=${decision.confidence.toFixed(2)}`,
      );
      return undefined;
    },

    wrapModelCall: (request, handler) => {
      if (!decision) return handler(request);

      let next = request;
      const hint = decision.route.target.subAgentHint;
      if (hint) {
        const suffix = `\n\nFor this request, prefer delegating to ${hint} if applicable.`;
        next = {
          ...next,
          systemMessage: next.systemMessage.concat(suffix),
        };
      }
      const role = decision.route.target.modelRole;
      if (role) {
        try {
          next = { ...next, model: resolveModel(role) };
        } catch (err) {
          // Out-of-policy or unresolvable role: keep the default model —
          // never block the turn on a routing enhancement.
          logger.warn(
            `[router] model override '${role}' failed — using default: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return handler(next);
    },
  });
}
