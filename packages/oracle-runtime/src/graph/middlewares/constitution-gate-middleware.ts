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
} as const;

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
   * Called with every verdict, permits included. The seam the decision-record
   * ledger hangs off; a log of only refusals cannot show that anything was
   * checked.
   */
  onDecision?: (record: GateDecisionRecord) => void;
  logger?: Logger;
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
    onDecision,
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
    if (request) onDecision?.({ toolName, request, decision, effectAssumed });
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

      let decision: AuthorizationDecision;
      try {
        decision = await authorize(request, domain.policy, {
          time,
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
        return refuse(toolName, toolCallId, decision, request, !declared);
      }

      onDecision?.({
        toolName,
        request,
        decision,
        effectAssumed: !declared,
      });
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
