import { describe, expect, it } from 'vitest';
import {
  buildSemanticConformanceVariants,
  type SemanticConformanceVariant,
} from './semantic-conformance.js';
import type { DecisionRequest } from './types.js';

function routeOptions(variant: SemanticConformanceVariant) {
  const route = variant.request.questions.route;
  if (route?.kind !== 'choice') throw new Error('route is not a choice');
  return route.options;
}

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
    const { variants, notApplicable } = buildSemanticConformanceVariants(
      request,
      { paraphraseInstructions: (text) => `Equivalent: ${text}` },
    );
    expect(notApplicable).toEqual([]);
    expect(variants.map((variant) => variant.kind)).toEqual([
      'baseline',
      'option-permutation',
      'opaque-option-ids',
      'rubric-paraphrase',
      'no-evidence',
      'missing-question',
    ]);
    const opaque = variants.find(
      (variant) => variant.kind === 'opaque-option-ids',
    )!;
    expect(opaque.request.questions.route).toMatchObject({
      options: { opt_1: 'Billing', opt_2: 'Support' },
    });
    expect(opaque.optionIdMap).toEqual({
      'route:opt_1': 'billing',
      'route:opt_2': 'support',
    });
    expect(
      variants.find((variant) => variant.kind === 'no-evidence')?.request.state,
    ).toBeNull();
  });

  it('permutes string option ids against the baseline', () => {
    const { variants } = buildSemanticConformanceVariants(request);
    const permuted = variants.find(
      (variant) => variant.kind === 'option-permutation',
    )!;

    expect(permuted.comparesWith).toBe('baseline');
    expect(permuted.optionIdMap).toBeUndefined();
    expect(JSON.stringify(permuted.request.questions.route)).toBe(
      JSON.stringify({
        kind: 'choice',
        instructions: 'Which route?',
        options: { support: 'Support', billing: 'Billing' },
      }),
    );
  });

  it('permutes integer-like option ids over the opaque rebinding, so the serialised order really changes', () => {
    const numbered: DecisionRequest = {
      state: { text: 'refund' },
      questions: {
        route: {
          kind: 'choice',
          instructions: 'Which route?',
          options: { 1: 'Billing', 2: 'Support', 3: 'Sales' },
        },
      },
    };
    // A plain reversal is invisible: integer-like keys enumerate numerically.
    expect(
      JSON.stringify(
        Object.fromEntries(
          Object.entries({ 1: 'Billing', 2: 'Support', 3: 'Sales' }).reverse(),
        ),
      ),
    ).toBe(JSON.stringify({ 1: 'Billing', 2: 'Support', 3: 'Sales' }));

    const { variants } = buildSemanticConformanceVariants(numbered);
    const permuted = variants.find(
      (variant) => variant.kind === 'option-permutation',
    )!;
    const opaque = variants.find(
      (variant) => variant.kind === 'opaque-option-ids',
    )!;

    expect(permuted.comparesWith).toBe('opaque-option-ids');
    expect(JSON.stringify(permuted.request)).not.toBe(JSON.stringify(numbered));
    expect(Object.entries(routeOptions(permuted))).toEqual([
      ['opt_3', 'Sales'],
      ['opt_2', 'Support'],
      ['opt_1', 'Billing'],
    ]);
    expect(Object.keys(routeOptions(opaque))).toEqual([
      'opt_1',
      'opt_2',
      'opt_3',
    ]);
    expect(permuted.optionIdMap).toEqual({
      'route:opt_1': '1',
      'route:opt_2': '2',
      'route:opt_3': '3',
    });
  });

  it('reports probes that would equal the baseline as not applicable instead of emitting them', () => {
    const { variants, notApplicable } = buildSemanticConformanceVariants({
      state: null,
      questions: {
        billing: { kind: 'boolean', instructions: 'Is this about billing?' },
      },
    });

    expect(variants.map((variant) => variant.kind)).toEqual([
      'baseline',
      'missing-question',
    ]);
    expect(notApplicable.map((skipped) => skipped.kind)).toEqual([
      'option-permutation',
      'opaque-option-ids',
      'no-evidence',
    ]);
    expect(notApplicable[0]?.reason).toMatch(/no choice question/);
  });
});
