import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import type { DecisionEvaluation } from './types.js';

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
 * - `on`: the verdict preloads the routed capability for the turn.
 */
export const CAPABILITY_ROUTER_MODES = ['off', 'shadow', 'on'] as const;
export type CapabilityRouterMode = (typeof CAPABILITY_ROUTER_MODES)[number];

/** Env field every runtime spreads into its base env schema. */
export const capabilityRouterEnvShape = {
  CAPABILITY_ROUTER: z.enum(CAPABILITY_ROUTER_MODES).default('off'),
};

/**
 * Minimum probability the router must assign, both to "a capability is
 * needed" and to the chosen capability, before anything is preloaded. A
 * deliberate constant rather than an env var: shadow-mode logs carry the raw
 * probabilities, so operators can tune this from real traffic later instead
 * of guessing per deployment.
 */
export const CAPABILITY_ROUTE_MIN_CONFIDENCE = 0.7;

export interface CapabilityRouteVerdict {
  /** Capability names to preload for the turn; at most one today. */
  preload: string[];
  /** Router's probability that a listed capability is needed at all. */
  needsCapability: number;
  /** Chosen option when it is not the synthetic "none" option. */
  capability?: string;
  capabilityConfidence?: number;
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
