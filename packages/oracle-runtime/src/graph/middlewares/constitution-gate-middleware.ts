/**
 * @fileoverview The structural gate between a model's proposal and its effect.
 *
 * Everything the model produces is a **claim**: "call this tool with these
 * arguments". This middleware is what turns a claim into a decision — it
 * classifies the proposed call into an action class, evaluates it against the
 * entity's constitution, and only then lets the handler run.
 *
 * Three properties make it a gate rather than a suggestion.
 *
 * It sits ahead of the repetition guard, which short-circuits duplicate failed
 * calls without invoking the handler. A gate behind it would never see the
 * calls the guard answers, which is a bypass.
 *
 * It fails closed. An unclassifiable tool, an object expression that throws,
 * an evaluator that throws — every one of those denies. The only path to
 * execution is an explicit permit.
 *
 * And it does not read anything the model can write. The constitution is
 * frozen at boot; the tool's effect declaration is registry metadata; the
 * arguments are the only model-supplied input, and they are data to classify
 * rather than instructions to follow. Text in a message claiming authority
 * changes nothing here.
 */
import { type AgentMiddleware, createMiddleware, ToolMessage } from 'langchain';
import {
  authorize,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizeDeps,
} from '../../constitution/authorize.js';
import { digestRequest } from '../../constitution/decision-record.js';
import type { DomainContext } from '../../constitution/domain-context.js';
import { systemClock, type TimeSource } from '../../constitution/time.js';
import type {
  Logger,
  RuntimeContext,
  ToolEffect,
} from '../../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Stable prefixes so a caller can recognise a constitutional refusal. */
export const CONSTITUTION_DENIED_PREFIX = '[constitution:denied]';
export const CONSTITUTION_REVIEW_PREFIX =
  '[constitution:manual_review_required]';

/** Reason codes the gate itself produces, distinct from the evaluator's. */
export const GATE_REASON = {
  /** The tool never said what it does, so the gate cannot classify the call. */
  undeclaredEffect: 'undeclared_tool_effect',
  /** The tool's own `effect.object` / `effect.value` expression threw. */
  effectUnresolvable: 'tool_effect_unresolvable',
  /** The evaluator threw rather than returning a verdict. */
  evaluatorFailed: 'evaluator_failed',
  /** The decision could not be recorded, so the action must not happen. */
  auditUnavailable: 'audit_unavailable',
} as const;

/**
 * Action classes that change nothing.
 *
 * The distinction matters only when the audit trail is down: a read that goes
 * unrecorded costs an entry in a log, while an unrecorded payment is an
 * entity acting with no account of why. Reads proceed; everything else stops.
 */
const NON_EFFECTFUL: ReadonlySet<string> = new Set(['read', 'propose']);

/** What the gate hands to a recorder. The decision plus what it was about. */
export interface GateDecisionRecord {
  toolName: string;
  request: AuthorizationRequest;
  decision: AuthorizationDecision;
  /** True when the tool declared no effect and permissive mode assumed `read`. */
  effectAssumed: boolean;
}

export interface ConstitutionGateMiddlewareOptions {
  /** The constitution in force. Frozen at boot. */
  domain: DomainContext;
  /**
   * What each tool does, keyed by tool name.
   *
   * A map rather than a field on the tool because `wrapPluginTool` erases
   * everything but name, description and schema before the tool reaches
   * LangChain — the effect declaration would not survive the trip.
   */
  effectByToolName: ReadonlyMap<string, ToolEffect>;
  /** The request context, for effect expressions that need it. */
  rtCtx: RuntimeContext;
  /** Declared clock. Expiry and revocation are only as good as their source. */
  time?: TimeSource;
  /** Capability-proof and review-proof verification. Absent verifiers deny. */
  deps?: Omit<AuthorizeDeps, 'time'>;
  /** Model identifier, recorded on the decision — which model proposed this. */
  model?: string;
  /**
   * Records every verdict, permits included: a log of only refusals cannot
   * show that anything was checked.
   *
   * Returns null when the decision could not be recorded — which the gate
   * treats as a refusal for effectful actions under strict enforcement. The
   * recorder can therefore stop an action, which is why it is synchronous:
   * a record that lands after the handler runs would leave a window in which
   * the entity has acted and nothing says on what authority.
   */
  recorder?: DecisionRecorder;
  /**
   * The human-review loop. Absent means `manual_review_required` stays a
   * refusal with nowhere to go — correct, but a dead end.
   */
  review?: ReviewCoordinator;
  logger?: Logger;
}

/** The ledger, as the gate needs to see it. */
export interface DecisionRecorder {
  record(decision: GateDecisionRecord): unknown | null;
}

/** What a reviewer is shown, and what their approval is bound to. */
export interface EscalationSubject {
  toolName: string;
  action: string;
  operation: string;
  object: string;
  value: { amount: string; denom: string } | null;
  reasonCodes: readonly string[];
  ruleRefs: readonly string[];
  sessionId: string;
  requestDigest: string;
}

/** The human-review loop, as the gate needs to see it. */
export interface ReviewCoordinator {
  /** The approving reviewer for this request, if one has signed off. */
  findApproval(requestDigest: string): Promise<string | null>;
  /** Re-checks that a proof reference still covers this exact request. */
  verifyProof(ref: string, requestDigest?: string): Promise<boolean>;
  /** Puts the decision in front of a person. */
  escalate(subject: EscalationSubject): Promise<void>;
}

/** Formats a refusal the model can act on: what was refused, and on what grounds. */
function refusalText(
  prefix: string,
  toolName: string,
  decision: AuthorizationDecision,
): string {
  const parts = [
    `${prefix} The constitution did not permit "${toolName}".`,
    decision.reasonCodes.length > 0
      ? `Reason: ${decision.reasonCodes.join(', ')}.`
      : '',
    decision.ruleRefs.length > 0
      ? `Rule: ${decision.ruleRefs.join(', ')}.`
      : '',
    prefix === CONSTITUTION_REVIEW_PREFIX
      ? 'A human must approve this before it can run. Raising it is the correct next step — do not look for another route to the same effect.'
      : 'This is not a transient failure and retrying will not change it. Tell the user what was refused and why.',
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * Builds the authorization request for a proposed tool call.
 *
 * Returns `null` when the call cannot be described — which the caller treats
 * as a refusal, because an action nobody can name is an action nobody can
 * bound.
 */
function buildRequest(
  toolName: string,
  args: unknown,
  effect: ToolEffect,
  domain: DomainContext,
  rtCtx: RuntimeContext,
  model?: string,
): AuthorizationRequest | null {
  let object: string;
  let value: AuthorizationRequest['value'];
  try {
    // The object defaults to the tool itself in the entity's namespace. That
    // is deliberately unlikely to match a grant: a `read` still passes on the
    // baseline, and anything effectful is refused until the tool says what it
    // acts on. Not naming your object is not a way around naming it.
    object = effect.object?.(args, rtCtx) ?? `${domain.subject}#${toolName}`;
    value = effect.value?.(args) ?? null;
  } catch {
    return null;
  }

  return {
    // The entity is the principal. Grants are about what the *entity* may do;
    // the user is who it acts for, which is a different question answered by
    // the UCAN delegation on the way in.
    principal: {
      did: domain.subject,
      sessionId: rtCtx.session.id,
      ...(model ? { model } : {}),
    },
    action: effect.type,
    operation: effect.action,
    object,
    value,
    ...(rtCtx.user.ucanDelegation?.raw
      ? { capabilityProof: rtCtx.user.ucanDelegation.raw }
      : {}),
  };
}

/**
 * Evaluates every tool call against the entity's constitution.
 *
 * Must be composed ahead of the repetition guard — see the file overview.
 */
export const createConstitutionGateMiddleware = (
  options: ConstitutionGateMiddlewareOptions,
): AgentMiddleware => {
  const {
    domain,
    effectByToolName,
    rtCtx,
    model,
    recorder,
    review,
    logger = NOOP_LOGGER,
  } = options;
  const time = options.time ?? systemClock;
  const strict = domain.enforcement === 'strict';

  const refuse = (
    toolName: string,
    toolCallId: string,
    decision: AuthorizationDecision,
    request: AuthorizationRequest | null,
    effectAssumed = false,
  ): ToolMessage => {
    // Best effort: the action is refused either way, so a ledger that cannot
    // take this record does not change the outcome, only the account of it.
    if (request)
      recorder?.record({ toolName, request, decision, effectAssumed });
    const prefix =
      decision.outcome === 'manual_review_required'
        ? CONSTITUTION_REVIEW_PREFIX
        : CONSTITUTION_DENIED_PREFIX;
    logger.warn(
      `Constitution refused ${toolName}: ${decision.outcome} (${decision.reasonCodes.join(', ')})`,
      {
        toolName,
        outcome: decision.outcome,
        reasonCodes: decision.reasonCodes,
        ruleRefs: decision.ruleRefs,
        constitution: `${domain.domainMdCid}@${domain.documentRevision}`,
      },
    );
    return new ToolMessage({
      content: refusalText(prefix, toolName, decision),
      tool_call_id: toolCallId,
      name: toolName,
      // `error` is load-bearing: the repetition guard short-circuits a
      // duplicate failed call with identical arguments, so a model that
      // retries a refusal verbatim is stopped without re-evaluating.
      status: 'error',
    });
  };

  return createMiddleware({
    name: 'ConstitutionGateMiddleware',
    wrapToolCall: async (toolCallRequest, handler) => {
      const { toolCall } = toolCallRequest;
      const toolName = toolCall.name ?? toolCallRequest.tool?.name ?? '';
      const toolCallId = toolCall.id ?? '';

      const declared = effectByToolName.get(toolName);

      // A tool that never said what it does cannot be classified. Under strict
      // enforcement that is a refusal — an unknown effect is an unbounded one.
      // Permissive assumes `read`, which is safe because reads change nothing
      // and because a read that touches a denied object is still denied.
      if (!declared && strict) {
        return refuse(
          toolName,
          toolCallId,
          {
            outcome: 'deny',
            reasonCodes: [GATE_REASON.undeclaredEffect],
            ruleRefs: [],
            obligations: [],
            time: time.now(),
          },
          {
            principal: { did: domain.subject, sessionId: rtCtx.session.id },
            action: 'read',
            operation: toolName,
            object: `${domain.subject}#${toolName}`,
          },
        );
      }

      const effect: ToolEffect = declared ?? {
        type: 'read',
        action: toolName,
      };

      const request = buildRequest(
        toolName,
        toolCall.args,
        effect,
        domain,
        rtCtx,
        model,
      );
      if (!request) {
        return refuse(
          toolName,
          toolCallId,
          {
            outcome: 'deny',
            reasonCodes: [GATE_REASON.effectUnresolvable],
            ruleRefs: [],
            obligations: [],
            time: time.now(),
          },
          {
            principal: { did: domain.subject, sessionId: rtCtx.session.id },
            action: effect.type,
            operation: effect.action,
            object: `${domain.subject}#${toolName}`,
          },
        );
      }

      // Bind the request to a digest and look for an approval covering it,
      // before evaluating rather than after. The evaluator decides whether
      // review is required; whether it has already happened is a fact it has
      // to be given, the same as the clock.
      if (review) {
        request.requestDigest = digestRequest(request);
        const approver = await review
          .findApproval(request.requestDigest)
          .catch(() => null);
        if (approver !== null) request.reviewProofRef = approver;
      }

      let decision: AuthorizationDecision;
      try {
        decision = await authorize(request, domain.policy, {
          time,
          ...(review
            ? {
                verifyReviewProof: (ref, digest) =>
                  review.verifyProof(ref, digest),
              }
            : {}),
          ...options.deps,
        });
      } catch (error) {
        // An evaluator that throws has not permitted anything. Treating a
        // crash as a refusal is the only reading that keeps the gate closed.
        logger.error(
          `Constitution evaluator threw for ${toolName}; refusing`,
          error,
        );
        decision = {
          outcome: 'deny',
          reasonCodes: [GATE_REASON.evaluatorFailed],
          ruleRefs: [],
          obligations: [],
          time: time.now(),
        };
      }

      if (decision.outcome !== 'permit') {
        // Put it in front of a person. Awaited rather than fired and
        // forgotten: the model is about to be told that raising this is the
        // correct next step, and that has to be true by the time it reads it.
        if (decision.outcome === 'manual_review_required' && review) {
          await review
            .escalate({
              toolName,
              action: request.action,
              operation: request.operation,
              object: request.object,
              value: request.value ?? null,
              reasonCodes: decision.reasonCodes,
              ruleRefs: decision.ruleRefs,
              sessionId: request.principal.sessionId,
              requestDigest: request.requestDigest ?? digestRequest(request),
            })
            .catch((error: unknown) => {
              logger.error(
                `[constitution] Escalation for ${toolName} could not be raised`,
                error,
              );
            });
        }
        return refuse(toolName, toolCallId, decision, request, !declared);
      }

      // The record is made before the handler runs, and its absence is a
      // refusal. An entity that acts while its own audit trail is down is
      // acting unaccountably, which is the one thing the constitution claims
      // it does not do. Reads are exempt: an unrecorded read costs a log
      // entry, an unrecorded payment costs the account of why it happened.
      const recorded =
        recorder === undefined
          ? true
          : recorder.record({
              toolName,
              request,
              decision,
              effectAssumed: !declared,
            }) !== null;

      if (!recorded && strict && !NON_EFFECTFUL.has(effect.type)) {
        return refuse(
          toolName,
          toolCallId,
          {
            outcome: 'deny',
            reasonCodes: [GATE_REASON.auditUnavailable],
            ruleRefs: ['constitution.execution'],
            obligations: [],
            time: time.now(),
          },
          null,
        );
      }
      if (!recorded) {
        logger.warn(
          `[constitution] ${toolName} ran without a recorded decision; the ledger is unavailable.`,
        );
      }

      if (decision.obligations.length > 0) {
        logger.log(
          `Constitution permitted ${toolName} with obligations`,
          decision.obligations,
        );
      }
      return handler(toolCallRequest);
    },
  });
};
