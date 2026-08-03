import { describe, expect, it, vi } from 'vitest';
import { buildDomainContext, isAnchoredProfile } from './domain-context.js';
import { loadDomainMd } from './load.js';
import { parseDomainMdSubset } from './parse.js';
import { SUPPORTED_SCHEMA_URI, SUPPORTED_SPEC_VERSION } from './schema.js';

const SUBJECT = 'did:ixo:entity:oracle';

function frontmatter(
  options: {
    profile?: string;
    anchoring?: Record<string, unknown> | null;
    criticalDoNot?: string[];
    agents?: Array<Record<string, unknown>>;
    mode?: string;
  } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    version: SUPPORTED_SPEC_VERSION,
    kind: 'domain.md',
    conformance: {
      spec_version: SUPPORTED_SPEC_VERSION,
      schema: SUPPORTED_SCHEMA_URI,
      profile: options.profile ?? 'authoring_draft',
    },
    document_revision: '1.2.0',
    domain: {
      id: SUBJECT,
      // Set for every fixture: an anchored profile requires it, and a draft
      // is unharmed by having one.
      iid: SUBJECT,
      type: 'oracle',
      status: 'active',
      purpose: 'Test subject.',
      operating_boundary: 'Testing.',
    },
    constitution: {
      status: 'in_force',
      reason: null,
      subject: SUBJECT,
      type: 'con:OracleConstitution',
    },
    agent_default_mode: {
      mode: options.mode ?? 'bounded_evaluate',
      overrides: { move_value: false },
      human_review_required_for: ['payment_release'],
    },
    rights: {
      agent_baseline: { require_explicit_grant_for: ['write', 'pay'] },
      entries: [],
    },
  };
  if (options.anchoring !== null) {
    base.documents = {
      anchoring: options.anchoring ?? {
        method: 'iid_linked_resource',
        reference: `${SUBJECT}#constitution`,
        // Null by rule: a document cannot address its own bytes, so the CID
        // lives in the anchoring record `reference` names.
        cid: null,
        verified_at: '2026-08-01T00:00:00.000Z',
      },
    };
  }
  if (options.criticalDoNot) base.critical_do_not = options.criticalDoNot;
  if (options.agents) base.agents = { entries: options.agents };
  return base;
}

function render(fm: Record<string, unknown>): string {
  return `---\n${JSON.stringify(fm, null, 2)}\n---\n# domain.md\n`;
}

const SOURCE = '/etc/oracle/domain.md';

describe('loadDomainMd — permissive', () => {
  it('accepts an unanchored draft and says so loudly', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(frontmatter({ anchoring: null })),
      enforcement: 'permissive',
    });
    expect(result.errors).toEqual([]);
    expect(result.context?.enforcement).toBe('permissive');
    expect(result.warnings.join('\n')).toMatch(/do not deploy this way/i);
  });

  it('still refuses a document that cannot be parsed', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: '# no frontmatter here\n',
      enforcement: 'permissive',
    });
    expect(result.context).toBeNull();
    expect(result.errors[0]?.field).toBe('DOMAIN_MD_PATH');
    expect(result.errors[0]?.message).toMatch(/could not be parsed/i);
  });

  it('refuses a document whose lint findings are blocking', async () => {
    // An override that raises the ceiling is the canonical blocking finding:
    // a document cannot grant itself more than its own mode allows.
    const fm = frontmatter();
    (fm.agent_default_mode as Record<string, unknown>).overrides = {
      move_value: true,
    };
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(fm),
      enforcement: 'permissive',
    });
    expect(result.context).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('loadDomainMd — strict', () => {
  it('refuses a draft profile', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(frontmatter({ profile: 'persisted_draft' })),
      enforcement: 'strict',
    });
    expect(result.context).toBeNull();
    expect(result.errors[0]?.field).toBe('DOMAIN_ENFORCEMENT');
    expect(result.errors[0]?.message).toMatch(/anchored.*runtime|profile/i);
  });

  // These assert the outcome rather than which layer produces it: today the
  // lint rules catch a structurally broken anchor before the posture check
  // reaches it, and either way the runtime must not start.
  it.each([
    ['no anchoring block at all', null],
    [
      'an anchoring method of none',
      { method: 'none', reference: null, cid: null, verified_at: null },
    ],
    [
      'an anchor naming no canonical record',
      {
        method: 'iid_linked_resource',
        reference: null,
        cid: null,
        verified_at: null,
      },
    ],
    [
      'a cid the document cannot address itself with',
      {
        method: 'iid_linked_resource',
        reference: `${SUBJECT}#constitution`,
        cid: 'bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr',
        verified_at: null,
      },
    ],
  ])('refuses an anchored profile with %s', async (_label, anchoring) => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(
        frontmatter({
          profile: 'anchored',
          anchoring: anchoring as Record<string, unknown> | null,
        }),
      ),
      enforcement: 'strict',
    });
    expect(result.context).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts a complete anchor without a verifier, and records that it was unverified', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(frontmatter({ profile: 'anchored' })),
      enforcement: 'strict',
    });
    expect(result.errors).toEqual([]);
    expect(result.context?.anchorVerified).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/no verifier was supplied/i);
  });

  it('marks the anchor verified when a verifier confirms it', async () => {
    const verifyAnchor = vi.fn().mockResolvedValue(true);
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(frontmatter({ profile: 'runtime' })),
      enforcement: 'strict',
      verifyAnchor,
    });
    expect(result.errors).toEqual([]);
    expect(result.context?.anchorVerified).toBe(true);
    // The verifier is handed the document's real digest, not the one the
    // document claims for itself — otherwise it would be checking a self-report.
    const [, expected] = verifyAnchor.mock.calls[0] as [
      unknown,
      { cid: string; sha256: string },
    ];
    expect(expected.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(expected.cid).toBe(result.context?.domainMdCid);
  });

  it('refuses when the verifier rejects the anchor', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(frontmatter({ profile: 'runtime' })),
      enforcement: 'strict',
      verifyAnchor: vi.fn().mockResolvedValue(false),
    });
    expect(result.context).toBeNull();
    expect(result.errors[0]?.message).toMatch(/could not be confirmed/i);
  });

  it('treats a verifier that throws as a failed check, not a passed one', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: render(frontmatter({ profile: 'runtime' })),
      enforcement: 'strict',
      verifyAnchor: vi.fn().mockRejectedValue(new Error('chain unreachable')),
    });
    expect(result.context).toBeNull();
    expect(result.errors[0]?.message).toMatch(/could not be confirmed/i);
  });
});

describe('buildDomainContext', () => {
  const parsed = () =>
    parseDomainMdSubset(
      render(
        frontmatter({
          profile: 'anchored',
          criticalDoNot: ['Never sign on a user’s behalf.'],
          agents: [
            {
              id: SUBJECT,
              forbidden_outputs: ['unbounded_payment'],
              escalation: {
                human_role: 'steward',
                matrix_room: '!review:ixo.world',
              },
            },
          ],
        }),
      ),
    );

  it('carries identity, policy and advisory content', () => {
    const ctx = buildDomainContext({
      parsed: parsed(),
      enforcement: 'strict',
      source: SOURCE,
    });
    expect(ctx.subject).toBe(SUBJECT);
    expect(ctx.documentRevision).toBe('1.2.0');
    expect(ctx.domainMdCid).toMatch(/^bafkrei/);
    expect(ctx.policy.modeCeiling).toBe('bounded_evaluate');
    expect(ctx.policy.baseline).toContain('pay');
    expect(ctx.advisory.criticalDoNot).toEqual([
      'Never sign on a user’s behalf.',
    ]);
    expect(ctx.advisory.forbiddenOutputs).toEqual(['unbounded_payment']);
    expect(ctx.advisory.escalationRoom).toBe('!review:ixo.world');
    expect(ctx.advisory.escalationRole).toBe('steward');
  });

  it('freezes what governs, so holding a reference is not holding a lever', () => {
    const ctx = buildDomainContext({
      parsed: parsed(),
      enforcement: 'strict',
      source: SOURCE,
    });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.policy)).toBe(true);
    expect(Object.isFrozen(ctx.policy.grants)).toBe(true);
    expect(Object.isFrozen(ctx.advisory)).toBe(true);
    expect(Object.isFrozen(ctx.advisory.criticalDoNot)).toBe(true);
  });

  it('defaults an unchecked anchor to unverified rather than assuming', () => {
    const ctx = buildDomainContext({
      parsed: parsed(),
      enforcement: 'strict',
      source: SOURCE,
    });
    expect(ctx.anchorVerified).toBe(false);
  });
});

describe('isAnchoredProfile', () => {
  it('recognises only the profiles that assert binding to canonical state', () => {
    expect(isAnchoredProfile('anchored')).toBe(true);
    expect(isAnchoredProfile('runtime')).toBe(true);
    expect(isAnchoredProfile('authoring_draft')).toBe(false);
    expect(isAnchoredProfile('persisted_draft')).toBe(false);
  });
});
