import { describe, expect, it, vi } from 'vitest';
import {
  buildDomainContext,
  isAnchoredProfile,
  resolveAgent,
} from './domain-context.js';
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
    grants?: Array<Record<string, unknown>>;
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
      entries: options.grants ?? [],
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
  // A deny grant with a nested ceiling: the shapes a shallow freeze leaves
  // writable are exactly the ones worth rewriting.
  const GRANT = {
    id: 'right:test:no-payment',
    type: 'payment',
    effect: 'deny',
    subject: SUBJECT,
    object: 'ixo:treasury',
    action: '*',
    capability: { format: 'policy', reference: 'domain_md' },
    conditions: {
      flow_state: null,
      claim_type: null,
      max_value: { amount: '100', denom: 'uixo' },
      not_before: null,
      expiry: null,
      role_required: null,
      credential_required: null,
      human_review: false,
    },
    revocation: { method: 'governance', reference: null },
    audit: { required: true },
  };

  const parsed = () =>
    parseDomainMdSubset(
      render(
        frontmatter({
          profile: 'anchored',
          criticalDoNot: ['Never sign on a user’s behalf.'],
          grants: [GRANT],
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
    const doc = parsed();
    const resolved = resolveAgent(
      doc.frontmatter.agents?.entries,
      doc.frontmatter.domain.id,
    );
    const ctx = buildDomainContext({
      parsed: doc,
      enforcement: 'strict',
      source: SOURCE,
      agent: resolved.kind === 'declared' ? resolved.entry : undefined,
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

  // Asserting `isFrozen` on the containers is how the shallow-freeze bug
  // survived review: every one of those assertions passed while each grant,
  // and each grant's conditions, stayed writable. The property is about what
  // is reachable, so the test walks what is reachable.
  it('freezes what governs, so holding a reference is not holding a lever', () => {
    const ctx = buildDomainContext({
      parsed: parsed(),
      enforcement: 'strict',
      source: SOURCE,
    });

    const unfrozen: string[] = [];
    const walk = (value: unknown, path: string, seen: WeakSet<object>) => {
      if (typeof value !== 'object' || value === null) return;
      if (seen.has(value)) return;
      seen.add(value);
      if (!Object.isFrozen(value)) unfrozen.push(path);
      for (const [key, child] of Object.entries(value)) {
        walk(child, `${path}.${key}`, seen);
      }
    };
    walk(ctx, 'domain', new WeakSet());

    expect(unfrozen).toEqual([]);
    expect(ctx.policy.grants.length).toBeGreaterThan(0);
  });

  // The mutation the freeze exists to stop, attempted rather than inferred.
  it('cannot have a grant rewritten through the reference the gate holds', () => {
    const ctx = buildDomainContext({
      parsed: parsed(),
      enforcement: 'strict',
      source: SOURCE,
    });
    const [first] = ctx.policy.grants;
    const originalEffect = first.effect;
    const originalObject = first.object;

    expect(() => {
      // A deny turned into an allow is the whole attack.
      first.effect = 'allow';
    }).toThrow(TypeError);
    expect(() => {
      first.object = '*';
    }).toThrow(TypeError);
    expect(() => {
      first.conditions.max_value = { amount: '999999999', denom: 'uixo' };
    }).toThrow(TypeError);

    expect(first.effect).toBe(originalEffect);
    expect(first.object).toBe(originalObject);
  });

  // Freezing the projection must not freeze the document it was projected
  // from — the caller passed it in to be read, not to be immobilised.
  it('leaves the caller’s parsed document alone', () => {
    const source = parsed();
    buildDomainContext({
      parsed: source,
      enforcement: 'strict',
      source: SOURCE,
    });
    expect(Object.isFrozen(source.frontmatter.rights.entries[0])).toBe(false);
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

// The entity is the agent for its own agentic functions — an agentic asset,
// deed, project, organisation or oracle acts as itself. These pin that shape
// across entity types, and pin what happens when a document names agents the
// entity is not.
describe('resolveAgent', () => {
  it.each([
    ['an agentic asset', 'did:ixo:entity:solar-array'],
    ['an agentic deed', 'did:ixo:entity:a-commitment'],
    ['an agentic project', 'did:ixo:entity:a-project'],
    ['an agentic organisation', 'did:ixo:entity:a-dao'],
    ['an agentic oracle', 'did:ixo:entity:an-oracle'],
  ])('resolves %s to itself, alongside other declared agents', (_label, id) => {
    const resolution = resolveAgent(
      [
        { id: 'did:ixo:agent:a-counterparty' },
        { id },
        { id: 'did:ixo:agent:another' },
      ],
      id,
    );
    expect(resolution).toMatchObject({
      kind: 'declared',
      via: 'entity-is-agent',
    });
    if (resolution.kind !== 'declared') throw new Error('unreachable');
    expect(resolution.entry.id).toBe(id);
  });

  it('lets configuration name a second agentic function the entity runs', () => {
    const entity = 'did:ixo:entity:a-dao';
    const resolution = resolveAgent(
      [{ id: entity }, { id: `${entity}#treasury` }],
      entity,
      `${entity}#treasury`,
    );
    expect(resolution).toMatchObject({ kind: 'declared', via: 'configured' });
    if (resolution.kind !== 'declared') throw new Error('unreachable');
    expect(resolution.entry.id).toBe(`${entity}#treasury`);
  });

  it('refuses an id the constitution does not declare, rather than falling back', () => {
    const entity = 'did:ixo:entity:a-dao';
    const resolution = resolveAgent(
      [{ id: entity }],
      entity,
      'did:ixo:agent:absent',
    );
    expect(resolution.kind).toBe('not-found');
  });

  it('takes a sole declared agent even when it is named apart from the entity', () => {
    const resolution = resolveAgent(
      [{ id: 'did:ixo:agent:maintenance' }],
      'did:ixo:entity:solar-array',
    );
    expect(resolution).toMatchObject({ kind: 'declared', via: 'sole-agent' });
  });

  it('reports ambiguity when several agents are declared and none is the entity', () => {
    const resolution = resolveAgent(
      [{ id: 'did:ixo:agent:one' }, { id: 'did:ixo:agent:two' }],
      'did:ixo:entity:a-dao',
    );
    expect(resolution.kind).toBe('ambiguous');
  });

  it('reports no agents rather than inventing one', () => {
    expect(resolveAgent(undefined, 'did:ixo:entity:x').kind).toBe('none');
    expect(resolveAgent([], 'did:ixo:entity:x').kind).toBe('none');
  });
});

describe('loadDomainMd — entity types and agentic functions', () => {
  const ENTITY = 'did:ixo:entity:a-dao';

  function doc(options: {
    entityType?: string;
    agents?: Array<Record<string, unknown>>;
  }) {
    const fm = frontmatter({ profile: 'anchored' });
    const domain = fm.domain as Record<string, unknown>;
    domain.id = ENTITY;
    domain.iid = ENTITY;
    domain.type = options.entityType ?? 'organisation';
    const constitution = fm.constitution as Record<string, unknown>;
    constitution.subject = ENTITY;
    constitution.type = 'con:AgenticConstitution';
    if (options.agents) fm.agents = { entries: options.agents };
    return render(fm);
  }

  const SELF = {
    id: ENTITY,
    forbidden_outputs: ['unbounded_payment'],
    escalation: { matrix_room: '!members:ixo.world' },
  };
  const OTHER = {
    id: 'did:ixo:agent:an-auditor',
    forbidden_outputs: ['unreviewed_final_approval'],
    escalation: { matrix_room: '!audit:ixo.world' },
  };

  // The runtime must not branch on entity type — it carries it so decision
  // records can say what was governed, and nothing else.
  it.each(['asset', 'deed', 'project', 'organisation', 'oracle'])(
    'governs an agentic %s the same way, carrying its type',
    async (entityType) => {
      const result = await loadDomainMd({
        source: SOURCE,
        bytes: doc({ entityType, agents: [SELF] }),
        enforcement: 'strict',
      });
      expect(result.errors).toEqual([]);
      expect(result.context?.entityType).toBe(entityType);
      expect(result.context?.agentId).toBe(ENTITY);
      expect(result.context?.advisory.escalationRoom).toBe(
        '!members:ixo.world',
      );
    },
  );

  it('takes the entity’s own bounds, not another declared agent’s', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: doc({ agents: [OTHER, SELF] }),
      enforcement: 'strict',
    });
    expect(result.context?.agentId).toBe(ENTITY);
    expect(result.context?.advisory.forbiddenOutputs).toEqual([
      'unbounded_payment',
    ]);
    expect(result.context?.advisory.escalationRoom).toBe('!members:ixo.world');
  });

  it('runs a named agentic function when configured to', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: doc({ agents: [SELF, OTHER] }),
      enforcement: 'strict',
      agentId: OTHER.id,
    });
    expect(result.context?.agentId).toBe(OTHER.id);
    expect(result.context?.advisory.escalationRoom).toBe('!audit:ixo.world');
  });

  it('refuses to start when it cannot tell which agentic function it runs', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: doc({ agents: [OTHER, { id: 'did:ixo:agent:another' }] }),
      enforcement: 'strict',
    });
    expect(result.context).toBeNull();
    expect(result.errors[0]?.field).toBe('DOMAIN_AGENT_ID');
    expect(result.errors[0]?.message).toMatch(
      /cannot tell which agentic function/i,
    );
  });

  it('warns rather than refusing under permissive enforcement', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: doc({ agents: [OTHER, { id: 'did:ixo:agent:another' }] }),
      enforcement: 'permissive',
    });
    expect(result.context).not.toBeNull();
    expect(result.context?.agentId).toBeNull();
    expect(result.warnings.join('\n')).toMatch(/set DOMAIN_AGENT_ID/i);
  });

  it('accepts an entity that declares no agents block at all', async () => {
    const result = await loadDomainMd({
      source: SOURCE,
      bytes: doc({}),
      enforcement: 'strict',
    });
    expect(result.errors).toEqual([]);
    expect(result.context?.agentId).toBeNull();
  });
});
