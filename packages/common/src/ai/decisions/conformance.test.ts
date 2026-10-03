import { describe, expect, it } from 'vitest';
import { buildSemanticConformanceVariants } from './conformance.js';
import type { DecisionRequest } from './types.js';

const request: DecisionRequest = {
  state: { text: 'refund' },
  questions: {
    route: {
      kind: 'choice',
      instructions: 'Which route?',
      options: { billing: 'Billing', support: 'Support' },
    },
  },
};

describe('semantic conformance variants', () => {
  it('covers permutation, opaque ids, paraphrase, no-evidence and missing-question controls', () => {
    const variants = buildSemanticConformanceVariants(request, {
      paraphraseInstructions: (text) => `Equivalent: ${text}`,
    });
    expect(variants.map((variant) => variant.kind)).toEqual([
      'baseline',
      'option-permutation',
      'opaque-option-ids',
      'rubric-paraphrase',
      'no-evidence',
      'missing-question',
    ]);
    const opaque = variants.find((variant) => variant.kind === 'opaque-option-ids')!;
    expect(opaque.request.questions.route).toMatchObject({
      options: { opt_1: 'Billing', opt_2: 'Support' },
    });
    expect(opaque.optionIdMap).toEqual({
      'route:opt_1': 'billing',
      'route:opt_2': 'support',
    });
    expect(variants.find((variant) => variant.kind === 'no-evidence')?.request.state).toBeNull();
  });
});
