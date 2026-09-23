// The Decision runtime implementation is shared with the Workers runtime
// through @ixo/common; this module only preserves the Node import path.
export {
  DEFAULT_DECISION_TIMEOUT_MS,
  DecisionProviderUnavailableError,
  DecisionRuntime,
  UNAVAILABLE_DECISION_EVALUATOR,
} from '@ixo/common';
export type { DecisionEvaluator } from '@ixo/common';
