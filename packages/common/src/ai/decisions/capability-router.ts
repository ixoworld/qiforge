import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import type {
  DecisionCalibrationProfile,
  DecisionEvaluation,
} from './types.js';

export const CAPABILITY_ROUTE_DECISION_NAME = 'runtime.route-capabilities';

/**
 * A plugin manifest reduced to what the router model needs to recognise the
 * capability from a user message.
 */
export interface RoutableCapability {
  name: string;
  title: string;
  summary: string;
}

/**
 * Upper bound on the capabilities offered to the router. The choice question
 * adds one synthetic "none" option, so 30 keeps the request under the
 * 32-option limit enforced by `validateDecisionRequest`.
 */
const MAX_ROUTABLE_CAPABILITIES = 30;

const routableCapabilitySchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
});

/**
 * Returns the option key that means "no listed capability applies". The key
 * is prefixed with `_` until it collides with none of the capability names so
 * a plugin can never shadow it.
 */
export function noCapabilityOption(names: string[]): string {
  let candidate = '__no_capability__';
  while (names.includes(candidate)) candidate = `_${candidate}`;
  return candidate;
}

/**
 * The single-choice route the Node runtime uses. The Workers runtime uses
 * `capabilityPreloadDecision`, which keeps this Decision's name.
 */
export const capabilityRouteDecision = defineDecision({
  name: CAPABILITY_ROUTE_DECISION_NAME,
  version: '1.0.0',
  description:
    'Predict which on-demand capability, if any, a user message needs so its tools can be preloaded before the first model call.',
  // The router sits on the critical path of every turn, ahead of the first
  // LLM call. A slow verdict costs more than a missed preload, so the budget
  // is well below the runtime default and a timeout simply preloads nothing.
  timeoutMs: 2_000,
  inputSchema: z.object({
    text: z.string().min(1),
    recentTurns: z.array(z.string()).max(6).default([]),
    capabilities: z
      .array(routableCapabilitySchema)
      .min(1)
      .max(MAX_ROUTABLE_CAPABILITIES),
  }),
  project(input) {
    const noneOption = noCapabilityOption(
      input.capabilities.map((capability) => capability.name),
    );

    return {
      state: {
        message: input.text,
        recent: input.recentTurns,
        capabilities: input.capabilities.map((capability) => ({
          name: capability.name,
          title: capability.title,
          summary: capability.summary,
        })),
      },
      questions: {
        needsCapability: {
          kind: 'boolean',
          instructions:
            'Does answering this message require one of the listed capabilities, beyond plain conversation and the tools already available?',
          criteria: {
            true: 'The message asks for something only a listed capability can do.',
            false:
              'The message can be answered conversationally or with the tools already available; no listed capability is needed.',
          },
        },
        capability: {
          kind: 'choice',
          instructions:
            'Which single listed capability is most likely needed to answer this message?',
          options: {
            ...Object.fromEntries(
              input.capabilities.map((capability) => [
                capability.name,
                `${capability.title}: ${capability.summary}`,
              ]),
            ),
            [noneOption]: 'No listed capability is needed.',
          },
        },
      },
    };
  },
});

/**
 * - `off`: the router is never evaluated.
 * - `shadow`: the router is evaluated and its verdict logged, but nothing is
 *   preloaded. Use this to measure accuracy before switching it on.
 * - `on`: the verdict loads the routed capabilities before the first model call.
 */
export const CAPABILITY_ROUTER_MODES = ['off', 'shadow', 'on'] as const;
export type CapabilityRouterMode = (typeof CAPABILITY_ROUTER_MODES)[number];

/** A blank value in a config file means unset, as for the `CONTEXT_*` knobs. */
const optionalThreshold = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.coerce.number().min(0).optional(),
);

/** Env field every runtime spreads into its base env schema. */
export const capabilityRouterEnvShape = {
  CAPABILITY_ROUTER: z.enum(CAPABILITY_ROUTER_MODES).default('off'),
  /**
   * The preload threshold of a turn the provider's cache still holds. Above
   * 1 nothing preloads on such a turn.
   */
  CAPABILITY_ROUTER_WARM_THRESHOLD: optionalThreshold,
  /** The same for a cold turn; unset, the calibration profile's. */
  CAPABILITY_ROUTER_COLD_THRESHOLD: optionalThreshold,
};

/**
 * Minimum probability the router must assign, both to "a capability is
 * needed" and to the chosen capability, before anything is preloaded. A
 * deliberate constant rather than an env var: shadow-mode logs carry the raw
 * probabilities, so operators can tune this from real traffic later instead
 * of guessing per deployment.
 */
export const CAPABILITY_ROUTE_CALIBRATION_PROFILE = {
  id: 'ixo:calibration:runtime.route-capabilities:provisional-v1',
  version: '1.0.0',
  status: 'provisional',
  // Not tied to one provider artifact. Acceptable only while the profile is
  // provisional: a validated profile must name the artifact it was fitted on.
  providerArtifactRef: 'unscoped',
  decisionName: CAPABILITY_ROUTE_DECISION_NAME,
  decisionVersion: capabilityRouteDecision.version,
  primitive: 'boolean',
  questionId: 'needsCapability',
  threshold: 0.7,
  validFrom: '2026-10-03T00:00:00.000Z',
} satisfies DecisionCalibrationProfile;

/**
 * Backward-compatible numeric export. New policy code should retain the
 * profile reference so a threshold cannot be separated from its provenance.
 */
export const CAPABILITY_ROUTE_MIN_CONFIDENCE =
  CAPABILITY_ROUTE_CALIBRATION_PROFILE.threshold;

export interface CapabilityRouteVerdict {
  /** Capability names to preload for the turn; at most one today. */
  preload: string[];
  /** Router's probability that a listed capability is needed at all. */
  needsCapability: number;
  /** Chosen option when it is not the synthetic "none" option. */
  capability?: string;
  capabilityConfidence?: number;
  /**
   * The calibration profile whose threshold decided this verdict. Omitted
   * when the caller passed its own `minConfidence`, which no profile backs.
   */
  calibrationProfileRef?: string;
  reason:
    | 'preload'
    | 'no-capability'
    | 'low-confidence'
    | 'unknown-capability'
    | 'none-option';
}

/**
 * Deterministic policy over a router evaluation. Never throws on a
 * well-formed evaluation; answers of the wrong kind throw a plain `Error`,
 * which callers treat as "preload nothing".
 */
export function decideCapabilityRoute(
  evaluation: DecisionEvaluation,
  capabilities: readonly RoutableCapability[],
  minConfidence = CAPABILITY_ROUTE_MIN_CONFIDENCE,
): CapabilityRouteVerdict {
  const needs = evaluation.answers.needsCapability;
  const choice = evaluation.answers.capability;
  if (needs?.kind !== 'boolean') {
    throw new Error(
      'Capability route evaluation is missing a boolean "needsCapability" answer.',
    );
  }
  if (choice?.kind !== 'choice') {
    throw new Error(
      'Capability route evaluation is missing a choice "capability" answer.',
    );
  }

  const names = capabilities.map((capability) => capability.name);
  const isNoneOption = choice.value === noCapabilityOption(names);
  const base = {
    needsCapability: needs.probabilityTrue,
    ...(isNoneOption ? {} : { capability: choice.value }),
    capabilityConfidence: choice.confidence,
    ...(minConfidence === CAPABILITY_ROUTE_CALIBRATION_PROFILE.threshold
      ? { calibrationProfileRef: CAPABILITY_ROUTE_CALIBRATION_PROFILE.id }
      : {}),
  };

  if (needs.probabilityTrue < minConfidence) {
    return { ...base, preload: [], reason: 'no-capability' };
  }
  if (isNoneOption) {
    return { ...base, preload: [], reason: 'none-option' };
  }
  if (!names.some((name) => name === choice.value)) {
    return { ...base, preload: [], reason: 'unknown-capability' };
  }
  if (choice.confidence < minConfidence) {
    return { ...base, preload: [], reason: 'low-confidence' };
  }
  return { ...base, preload: [choice.value], reason: 'preload' };
}

/**
 * Reduces plugin manifests to routable capabilities. Entries without a title
 * or summary are dropped because the router has nothing to recognise them
 * by; the rest are trimmed and capped, preserving order.
 */
export function toRoutableCapabilities(
  entries: ReadonlyArray<{ name: string; title?: string; summary?: string }>,
): RoutableCapability[] {
  const routable: RoutableCapability[] = [];
  for (const entry of entries) {
    if (routable.length >= MAX_ROUTABLE_CAPABILITIES) break;
    const name = entry.name.trim();
    const title = entry.title?.trim();
    const summary = entry.summary?.trim();
    if (!name || !title || !summary) continue;
    routable.push({ name, title, summary });
  }
  return routable;
}

/**
 * Questions one preload evaluation may carry: `validateDecisionRequest` takes
 * at most 16, so the host evaluates larger candidate lists in batches.
 */
export const CAPABILITY_PRELOAD_BATCH_SIZE = 16;

/**
 * Multi-label form of the route: one yes/no question per candidate, so a
 * message that needs two capabilities preloads both, and a message that needs
 * none scores low everywhere without a separate "needs a tool?" question. A
 * single choice cannot do this: it puts its mass on one option, and it loses
 * recall when two candidates read alike.
 *
 * Each question insists on a direct ask because a yes/no question has no rival
 * options: the looser "would the assistant need X?" fires on most candidates.
 * Candidates travel in the questions, not the state, so the call does not send
 * them twice. The route's Decision name is kept, so an existing
 * `decisionProviderPolicy` route still selects its provider.
 */
export const capabilityPreloadDecision = defineDecision({
  name: CAPABILITY_ROUTE_DECISION_NAME,
  version: '2.0.0',
  description:
    'Predict every on-demand capability a user message needs so their tools can be preloaded before the first model call.',
  // On the critical path of every turn. A provider call answers in about
  // 350 ms; past this budget a missed preload costs less than the wait, and
  // the model can still load what it needs with `load_capability`.
  timeoutMs: 1_000,
  inputSchema: z.object({
    text: z.string().min(1),
    recentTurns: z.array(z.string()).max(6).default([]),
    capabilities: z
      .array(routableCapabilitySchema)
      .min(1)
      .max(CAPABILITY_PRELOAD_BATCH_SIZE),
  }),
  project(input) {
    return {
      state: { message: input.text, recent: input.recentTurns },
      questions: Object.fromEntries(
        input.capabilities.map((capability) => [
          capability.name,
          {
            kind: 'boolean' as const,
            instructions: `Does the user's latest message directly ask for something only "${capability.title}" can do? ${capability.summary} Answer false when another capability fits better or plain conversation is enough.`,
          },
        ]),
      ),
    };
  },
});

/**
 * Lowest probability that preloads a capability. A missed preload costs one
 * `load_capability` round trip, a wrong one the capability's tools and usage
 * for the rest of the session, about even at a precision of 0.5 to 0.6. A
 * wrong one also steers: its usage note sits on the user's message, and the
 * model reaches for the tools it was handed before the ones it already had.
 * Fitted on `typesafe/jev-1.13` with each candidate described by its manifest
 * `summary` plus `whenToUse`; thin descriptions score far lower, so it does not
 * carry over to them. Over two full lab runs (372 turns) scores from 0.6 to 0.7
 * were used 10 times in 43, from 0.7 to 0.8 10 in 19, from 0.8 to 0.9 25 in 30
 * and above 0.9 83 in 83. The top scores are logged so it can be refitted from
 * real traffic. Provisional until then.
 */
export const CAPABILITY_PRELOAD_CALIBRATION_PROFILE = {
  id: 'ixo:calibration:runtime.route-capabilities:multi-label-provisional-v3',
  version: '3.0.0',
  status: 'provisional',
  providerArtifactRef: 'typesafe/jev-1.13',
  decisionName: CAPABILITY_ROUTE_DECISION_NAME,
  decisionVersion: capabilityPreloadDecision.version,
  primitive: 'boolean',
  questionId: '*',
  threshold: 0.7,
  validFrom: '2026-11-02T00:00:00.000Z',
} satisfies DecisionCalibrationProfile;

/**
 * The bar on a warm turn. A preload changes the tool list, so on a warm turn a
 * wrong one costs a full cache miss, about 11 times the one cached round trip
 * a right one saves (a right one pays the same miss as `load_capability`): it
 * earns its place at a precision of about 0.9. On the bakeoff's 166 messages
 * 0.8 gave precision 0.91 to 0.93 at recall 0.82 to 0.93, and 0.94 at recall
 * 0.70 on the first full lab run. On a cold turn the prefix is being paid for anyway, so a wrong preload
 * costs only its tools and `threshold` applies. Provisional, as that profile.
 */
export const CAPABILITY_PRELOAD_WARM_THRESHOLD = 0.8;

export interface CapabilityPreloadVerdict {
  /** Capability names to load before the first model call, most likely first. */
  preload: string[];
  /** The router's probability for every candidate, most likely first. */
  scores: Array<{ name: string; probability: number }>;
  /**
   * The calibration profile whose threshold decided this verdict. Omitted
   * when the caller passed its own `threshold`, which no profile backs.
   */
  calibrationProfileRef?: string;
}

/**
 * Deterministic policy over preload evaluations, one per batch. Never throws
 * on well-formed evaluations; a missing or non-boolean answer throws a plain
 * `Error`, which callers treat as "preload nothing".
 */
export function decideCapabilityPreload(
  evaluations: readonly DecisionEvaluation[],
  capabilities: readonly RoutableCapability[],
  threshold?: number,
): CapabilityPreloadVerdict {
  const answers = new Map(
    evaluations.flatMap((evaluation) => Object.entries(evaluation.answers)),
  );
  const scores = capabilities
    .map(({ name }) => {
      const answer = answers.get(name);
      if (answer?.kind !== 'boolean') {
        throw new Error(
          `Capability preload evaluation is missing a boolean answer for "${name}".`,
        );
      }
      return { name, probability: answer.probabilityTrue };
    })
    .sort((a, b) => b.probability - a.probability);
  return {
    preload: scores
      .filter(
        ({ probability }) =>
          probability >=
          (threshold ?? CAPABILITY_PRELOAD_CALIBRATION_PROFILE.threshold),
      )
      .map(({ name }) => name),
    scores,
    ...(threshold === undefined
      ? { calibrationProfileRef: CAPABILITY_PRELOAD_CALIBRATION_PROFILE.id }
      : {}),
  };
}
