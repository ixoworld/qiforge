import type { DecisionApplicability } from './types.js';

const UNAVAILABLE_MESSAGE =
  'No Decision provider is configured. Set DECISION_PROVIDER (openrouter-jev or cloudflare-jev), pass decisionProviders (or a decisionAdapter) to the runtime, or configure a test decision mock.';

export class DecisionProviderUnavailableError extends Error {
  constructor(message: string = UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'DecisionProviderUnavailableError';
  }
}

/**
 * The request declared itself inapplicable or its evidence incomplete, so no
 * provider was invoked. This is an abstention, not a negative answer: the
 * caller's policy decides whether to pass through, gather evidence or
 * escalate.
 */
export class DecisionNotApplicableError extends Error {
  constructor(readonly applicability: DecisionApplicability) {
    super(
      applicability.reason
        ? `Decision is not applicable: ${applicability.reason}`
        : applicability.applicable
          ? 'Decision is not applicable because decision-relevant evidence is incomplete.'
          : 'Decision is not applicable to the projected state.',
    );
    this.name = 'DecisionNotApplicableError';
  }
}
