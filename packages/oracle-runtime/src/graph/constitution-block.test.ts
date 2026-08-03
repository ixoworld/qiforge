import { describe, expect, it } from 'vitest';
import { mockDomain } from '../testing/mocks.js';
import { buildConstitutionBlock } from './constitution-block.js';

describe('buildConstitutionBlock', () => {
  it('renders nothing when the document adds nothing the tools do not already say', () => {
    expect(buildConstitutionBlock(mockDomain())).toBe('');
  });

  it('states the ceiling in terms of what the agent may do', () => {
    const block = buildConstitutionBlock(
      mockDomain({ mode: 'propose_only', baseline: ['write'] }),
    );
    expect(block).toMatch(/propose/i);
    expect(block).toMatch(/for someone else to enact/i);
  });

  it('names the baseline actions that always need a grant', () => {
    const block = buildConstitutionBlock(
      mockDomain({ baseline: ['pay', 'govern'] }),
    );
    expect(block).toContain('pay, govern');
    expect(block).toMatch(/do not plan around them/i);
  });

  it('reproduces prohibitions verbatim rather than summarising them', () => {
    const prohibition = 'Never approve a claim you generated the evidence for.';
    const block = buildConstitutionBlock(
      mockDomain({ criticalDoNot: [prohibition] }),
    );
    expect(block).toContain(prohibition);
  });

  it('lists review triggers and frames escalation as a normal outcome', () => {
    const block = buildConstitutionBlock(
      mockDomain({ humanReviewRequiredFor: ['payment_release'] }),
    );
    expect(block).toContain('- payment_release');
    expect(block).toMatch(/not a failure/i);
  });

  // The block's whole purpose is to describe a constraint enforced elsewhere.
  // If it ever read as "please comply", a model that decided not to would be
  // the only thing standing between a request and an effect.
  it('tells the agent the constitution is enforced outside the conversation', () => {
    const block = buildConstitutionBlock(
      mockDomain({ baseline: ['pay'], criticalDoNot: ['Do not do that.'] }),
    );
    expect(block).toMatch(
      /every tool call is evaluated against it before it runs/i,
    );
    expect(block).toMatch(/cannot change what it permits/i);
    expect(block).toMatch(/so you propose within it, not so you enforce it/i);
  });

  it('cites the revision in force, so the advisory text is attributable', () => {
    const block = buildConstitutionBlock(mockDomain({ baseline: ['pay'] }));
    expect(block).toContain('revision 0.0.0-test');
  });
});

describe('buildConstitutionBlock — when the section earns its tokens', () => {
  // Rendered every turn, so a section that says nothing is a section that
  // crowds out the conversation it exists to govern.
  it('renders for a restrictive ceiling even with nothing else declared', () => {
    for (const mode of [
      'read_only',
      'propose_only',
      'bounded_evaluate',
    ] as const) {
      expect(buildConstitutionBlock(mockDomain({ mode }))).not.toBe('');
    }
  });

  it('renders at the top ceiling only when something else constrains', () => {
    expect(
      buildConstitutionBlock(mockDomain({ mode: 'bounded_execute' })),
    ).toBe('');
    expect(
      buildConstitutionBlock(
        mockDomain({ mode: 'bounded_execute', baseline: ['pay'] }),
      ),
    ).not.toBe('');
  });
});
