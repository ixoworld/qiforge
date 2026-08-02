import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeDomainMdDigest,
  DomainMdParseError,
  hasBlockingFindings,
  lintDomainMdSubset,
  parseDomainMdSubset,
  type LintFinding,
} from './parse.js';
import { SUPPORTED_SCHEMA_URI, SUPPORTED_SPEC_VERSION } from './schema.js';

const EXAMPLE_DOMAIN_MD = fileURLToPath(
  new URL('../../../../apps/qiforge-example/domain.md', import.meta.url),
);

/** Minimal conforming document; tests mutate a clone to exercise one rule at a time. */
function baseFrontmatter(): Record<string, unknown> {
  return {
    version: SUPPORTED_SPEC_VERSION,
    kind: 'domain.md',
    conformance: {
      spec_version: SUPPORTED_SPEC_VERSION,
      schema: SUPPORTED_SCHEMA_URI,
      profile: 'authoring_draft',
    },
    document_revision: '0.1.0',
    domain: {
      id: 'urn:uuid:6f1d0d5a-4a1e-4f2b-9c7a-2f9a5b3c1d40',
      iid: null,
      type: 'oracle',
      status: 'draft',
      purpose: 'Test subject.',
      operating_boundary: 'Testing only.',
    },
    constitution: {
      status: 'draft',
      reason: null,
      subject: 'urn:uuid:6f1d0d5a-4a1e-4f2b-9c7a-2f9a5b3c1d40',
      type: 'con:OracleConstitution',
    },
    agent_default_mode: {
      mode: 'bounded_evaluate',
      overrides: { move_value: false },
      human_review_required_for: ['payment_release'],
    },
    rights: {
      agent_baseline: { require_explicit_grant_for: ['write', 'pay'] },
      entries: [
        {
          id: 'right:test:read',
          type: 'read',
          effect: 'allow',
          subject: 'did:ixo:entity:test',
          object: 'ixo:oracle',
          action: '*',
          capability: { format: 'policy', reference: 'domain_md' },
          conditions: {
            flow_state: null,
            claim_type: null,
            max_value: null,
            not_before: null,
            expiry: null,
            role_required: null,
            credential_required: null,
            human_review: false,
          },
          revocation: {},
          audit: {},
        },
      ],
    },
  };
}

function render(
  frontmatter: Record<string, unknown>,
  body = '# domain.md\n',
): string {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
}

function codes(findings: LintFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

describe('computeDomainMdDigest', () => {
  it('produces a CIDv1 raw sha2-256 address and matching hex digest', () => {
    const digest = computeDomainMdDigest('hello constitution');
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(digest.cid).toMatch(/^b[a-z2-7]{10,}$/);
    // CIDv1 + raw codec + sha2-256 + 32-byte length prefixes every address.
    expect(digest.cid.startsWith('bafkrei')).toBe(true);
  });

  it('is deterministic and byte-sensitive', () => {
    expect(computeDomainMdDigest('a')).toEqual(computeDomainMdDigest('a'));
    expect(computeDomainMdDigest('a').cid).not.toEqual(
      computeDomainMdDigest('b').cid,
    );
  });
});

describe('parseDomainMdSubset', () => {
  it('parses frontmatter, body and digest', () => {
    const parsed = parseDomainMdSubset(
      render(baseFrontmatter(), '# domain.md\n\nProse.\n'),
    );
    expect(parsed.frontmatter.kind).toBe('domain.md');
    expect(parsed.frontmatter.agent_default_mode.mode).toBe('bounded_evaluate');
    expect(parsed.body).toBe('# domain.md\n\nProse.');
    expect(parsed.digest.cid).toMatch(/^b/);
  });

  it('retains blocks the runtime does not evaluate', () => {
    const frontmatter = {
      ...baseFrontmatter(),
      privacy: { default_policy: 'private_by_default' },
    };
    const parsed = parseDomainMdSubset(render(frontmatter));
    expect(parsed.frontmatter).toHaveProperty('privacy');
  });

  it('rejects a document with no frontmatter', () => {
    expect(() => parseDomainMdSubset('# just prose\n')).toThrow(
      DomainMdParseError,
    );
    expect(() => parseDomainMdSubset('# just prose\n')).toThrow(/frontmatter/i);
  });

  it('rejects a byte-order mark', () => {
    expect(() => parseDomainMdSubset(`﻿${render(baseFrontmatter())}`)).toThrow(
      /byte-order/i,
    );
  });

  it('rejects frontmatter that fails schema validation', () => {
    const frontmatter = baseFrontmatter();
    delete frontmatter.rights;
    expect(() => parseDomainMdSubset(render(frontmatter))).toThrow(
      /failed validation/i,
    );
  });

  it('rejects an unknown agent mode', () => {
    const frontmatter = baseFrontmatter();
    (frontmatter.agent_default_mode as Record<string, unknown>).mode =
      'unbounded';
    expect(() => parseDomainMdSubset(render(frontmatter))).toThrow(
      /failed validation/i,
    );
  });

  it('rejects a document above the interoperability byte limit', () => {
    const frontmatter = baseFrontmatter();
    frontmatter.description = 'x'.repeat(1_100_000);
    expect(() => parseDomainMdSubset(render(frontmatter))).toThrow(/byte/i);
  });
});

describe('lintDomainMdSubset', () => {
  it('passes a conforming draft', () => {
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(baseFrontmatter())),
    );
    expect(findings).toEqual([]);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it('rejects an override that raises the ceiling', () => {
    const frontmatter = baseFrontmatter();
    (frontmatter.agent_default_mode as Record<string, unknown>).overrides = {
      move_value: true,
    };
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('open-ended-agent-authority');
    expect(hasBlockingFindings(findings)).toBe(true);
  });

  it('rejects an empty agent baseline', () => {
    const frontmatter = baseFrontmatter();
    (
      frontmatter.rights as {
        agent_baseline: { require_explicit_grant_for: string[] };
      }
    ).agent_baseline.require_explicit_grant_for = [];
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('missing-rights-baseline');
  });

  it('rejects a right type that maps to no action class', () => {
    const frontmatter = baseFrontmatter();
    const rights = frontmatter.rights as {
      entries: Array<Record<string, unknown>>;
    };
    rights.entries[0].type = 'teleport';
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('unrecognized-right-type');
  });

  it('rejects duplicate rights ids', () => {
    const frontmatter = baseFrontmatter();
    const rights = frontmatter.rights as {
      entries: Array<Record<string, unknown>>;
    };
    rights.entries.push({ ...rights.entries[0] });
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('duplicate-entry-id');
  });

  it('rejects a grant whose expiry precedes its start', () => {
    const frontmatter = baseFrontmatter();
    const rights = frontmatter.rights as {
      entries: Array<Record<string, unknown>>;
    };
    rights.entries[0].conditions = {
      ...(rights.entries[0].conditions as Record<string, unknown>),
      not_before: '2026-06-01T00:00:00Z',
      expiry: '2026-05-01T00:00:00Z',
    };
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('invalid-grant');
  });

  it('rejects a constitution subject that is not the domain subject', () => {
    const frontmatter = baseFrontmatter();
    (frontmatter.constitution as Record<string, unknown>).subject =
      'did:ixo:entity:someone-else';
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain(
      'constitutional-subject-profile-unresolved',
    );
  });

  it('rejects not_applicable for an agentic domain', () => {
    const frontmatter = baseFrontmatter();
    frontmatter.constitution = {
      status: 'not_applicable',
      reason: 'passive dataset',
      subject: 'urn:uuid:6f1d0d5a-4a1e-4f2b-9c7a-2f9a5b3c1d40',
      type: 'con:AssetConstitution',
    };
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('constitution-not-applicable-invalid');
  });

  it('rejects a spec version this runtime does not enforce', () => {
    const frontmatter = baseFrontmatter();
    frontmatter.version = '0.9.0';
    (frontmatter.conformance as Record<string, unknown>).spec_version = '0.9.0';
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('unsupported-spec-version');
  });

  it('requires anchoring evidence for an anchored profile', () => {
    const frontmatter = baseFrontmatter();
    (frontmatter.conformance as Record<string, unknown>).profile = 'anchored';
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toEqual(
      expect.arrayContaining([
        'missing-domain-id',
        'invalid-conformance-profile',
        'document-unanchored',
      ]),
    );
  });

  it('rejects a self-referential anchoring CID', () => {
    const frontmatter = baseFrontmatter();
    (frontmatter.conformance as Record<string, unknown>).profile = 'anchored';
    frontmatter.domain = {
      ...(frontmatter.domain as Record<string, unknown>),
      id: 'did:ixo:entity:example',
      iid: 'did:ixo:entity:example',
    };
    (frontmatter.constitution as Record<string, unknown>).subject =
      'did:ixo:entity:example';
    frontmatter.documents = {
      anchoring: {
        method: 'iid_linked_resource',
        reference: 'did:ixo:entity:example#domain-md',
        cid: 'bafkreialxpwjhwmceaxfrxpxfyw2ilqbwqrcvsvpi4x2rvrywnpwjt3zxa',
        verified_at: null,
      },
    };
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('document-unanchored');
  });

  it('rejects template placeholders', () => {
    const parsed = parseDomainMdSubset(
      render(baseFrontmatter(), '# domain.md\n\nOwned by {{operator_name}}.\n'),
    );
    expect(codes(lintDomainMdSubset(parsed))).toContain('template-placeholder');
  });

  it('rejects secret-bearing fields in the index', () => {
    const frontmatter = {
      ...baseFrontmatter(),
      matrix_access_token: 'syt_secret',
    };
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(render(frontmatter)),
    );
    expect(codes(findings)).toContain('secret-in-index');
  });
});

describe('the example oracle domain.md', () => {
  it('parses and lints clean', () => {
    const parsed = parseDomainMdSubset(readFileSync(EXAMPLE_DOMAIN_MD, 'utf8'));
    const findings = lintDomainMdSubset(parsed);
    expect(findings).toEqual([]);
    expect(parsed.frontmatter.domain.type).toBe('oracle');
    expect(parsed.frontmatter.agent_default_mode.mode).toBe('bounded_evaluate');
  });

  it('never authorizes value movement, issuance, or rights changes', () => {
    const parsed = parseDomainMdSubset(readFileSync(EXAMPLE_DOMAIN_MD, 'utf8'));
    const baseline =
      parsed.frontmatter.rights.agent_baseline.require_explicit_grant_for;
    expect(baseline).toEqual(
      expect.arrayContaining([
        'write',
        'evaluate',
        'execute',
        'pay',
        'issue',
        'mint',
        'transfer',
        'govern',
        'delete',
        'revoke',
      ]),
    );
    const grantedTypes = parsed.frontmatter.rights.entries.map(
      (grant) => grant.type,
    );
    expect(grantedTypes).not.toEqual(
      expect.arrayContaining(['pay', 'issue_credential', 'mint', 'transfer']),
    );
    expect(parsed.frontmatter.agent_default_mode.overrides).toMatchObject({
      move_value: false,
      issue_credentials: false,
      change_rights: false,
    });
  });
});
