import {
  ActionRequestSchema,
  type ActionRequest,
  type ConsequenceDecision,
} from '@ixo/common/work';
import type { ConsequenceGuard } from './contracts';

export interface ConsequenceGuardOptions {
  policyVersion: string;
  /** Verify current actor, signatures, expiry and revocation at every call. */
  authorize: (action: ActionRequest) => Promise<boolean>;
  /** Explicit host policy; a tool or skill label cannot change it. */
  allowedConsequences: readonly ActionRequest['consequence'][];
}
export function createConsequenceGuard(
  options: ConsequenceGuardOptions,
): ConsequenceGuard {
  return {
    async evaluate(input): Promise<ConsequenceDecision> {
      const action = ActionRequestSchema.parse(input);
      let authorized = false;
      try {
        authorized = await options.authorize(action);
      } catch {
        authorized = false;
      }
      const allowed =
        authorized &&
        action.privilegePlane === 'orchestration' &&
        options.allowedConsequences.includes(action.consequence) &&
        action.consequence !== 'settlement';
      return {
        version: 1,
        actionId: action.actionId,
        inputDigest: action.inputDigest,
        policyVersion: options.policyVersion,
        decision: allowed ? 'allow' : 'deny',
        reason: allowed
          ? 'Current authority and host policy permit this action.'
          : 'Current authority or host policy does not permit this action.',
      };
    },
  };
}
