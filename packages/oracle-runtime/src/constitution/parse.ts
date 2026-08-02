/**
 * @fileoverview Parsing, linting and content-addressing for `domain.md`.
 *
 * This module is the seam between the runtime and the `domain.md` format. It
 * is deliberately the only place that knows how the document is encoded, so
 * the in-repo subset parser can later be replaced by the upstream
 * `@ixo/domain.md` package (`parseDomain` / `lint`) without touching the
 * authorization evaluator, the module, or the gate.
 *
 * Two verdicts are kept separate, matching the format's own distinction:
 *
 * - **Static conformance** — what this file can prove from the bytes alone:
 *   encoding, schema shape, local references, profile invariants.
 * - **Runtime conformance** — resolving canonical IID state, capability
 *   proofs, revocation and trusted time. Those checks live elsewhere and a
 *   static pass never implies them.
 */
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import {
  domainMdFrontmatterSchema,
  MODE_RANK,
  RIGHT_TYPE_TO_ACTION,
  SUPPORTED_SCHEMA_URI,
  SUPPORTED_SPEC_VERSION,
  type DomainMdDigest,
  type DomainMdFrontmatter,
  type ParsedDomainMd,
} from './schema.js';

/** Largest `domain.md` the runtime will parse — the format's interoperability limit. */
export const MAX_DOMAIN_MD_BYTES = 1_048_576;

export interface LintFinding {
  /** Stable machine-readable code. Mirrors the format's rule registry where one exists. */
  code: string;
  severity: 'error' | 'warning';
  message: string;
  /** Dotted path into the frontmatter, when the finding is anchored to a field. */
  path?: string;
}

/** Thrown when bytes cannot be turned into a document at all. */
export class DomainMdParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainMdParseError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

const BASE32_LOWER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower-case, unpadded — the multibase `b` encoding. */
function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_LOWER_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_LOWER_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Content addresses over the exact UTF-8 bytes supplied.
 *
 * The CID is a CIDv1 with the raw codec and a sha2-256 multihash, multibase
 * base32 — the address form the format freezes for capsule artifacts, and the
 * one an anchoring record is expected to carry.
 *
 * A document never contains its own CID: the address covers the published
 * bytes, so `documents.anchoring.cid` stays null in the file and the canonical
 * anchoring record supplies the value the runtime compares against.
 */
export function computeDomainMdDigest(bytes: string): DomainMdDigest {
  const sha256 = createHash('sha256').update(bytes, 'utf8').digest();
  // <cidv1 0x01><raw codec 0x55><sha2-256 0x12><length 0x20><digest>
  const prefixed = new Uint8Array(4 + sha256.length);
  prefixed.set([0x01, 0x55, 0x12, 0x20], 0);
  prefixed.set(sha256, 4);
  return {
    sha256: sha256.toString('hex'),
    cid: `b${base32Encode(prefixed)}`,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses the enforced subset of a `domain.md`.
 *
 * Throws {@link DomainMdParseError} when the bytes are not a conforming
 * document — an unparseable constitution is never treated as an absent one.
 */
export function parseDomainMdSubset(bytes: string): ParsedDomainMd {
  if (Buffer.byteLength(bytes, 'utf8') > MAX_DOMAIN_MD_BYTES) {
    throw new DomainMdParseError(
      'file-too-large',
      `domain.md exceeds the ${MAX_DOMAIN_MD_BYTES}-byte interoperability limit.`,
    );
  }
  if (bytes.charCodeAt(0) === 0xfeff) {
    throw new DomainMdParseError(
      'encoding',
      'domain.md must be UTF-8 without a byte-order mark.',
    );
  }

  // Detected from the raw bytes rather than gray-matter's `matter` field:
  // that field is absent when the document has no frontmatter, and is also
  // dropped from gray-matter's internal cache when the same bytes are parsed
  // twice, so it cannot distinguish "no frontmatter" from "seen before".
  if (!/^---\r?\n/.test(bytes)) {
    throw new DomainMdParseError(
      'missing-frontmatter',
      'domain.md must begin with YAML frontmatter.',
    );
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(bytes);
  } catch (error) {
    throw new DomainMdParseError(
      'unsafe-yaml',
      `domain.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const data: unknown = parsed.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new DomainMdParseError(
      'frontmatter-shape',
      'domain.md frontmatter must be a mapping.',
    );
  }

  const result = domainMdFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new DomainMdParseError(
      'schema',
      `domain.md frontmatter failed validation — ${issues}`,
    );
  }

  return {
    frontmatter: result.data,
    body: parsed.content.trim(),
    digest: computeDomainMdDigest(bytes),
  };
}

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------

const TEMPLATE_PLACEHOLDER = /\{\{[^}]+\}\}|<<FILL_AT_PUBLISH:/;

const SECRET_KEY_HINT =
  /(private_key|secret|mnemonic|seed_phrase|access_token|api_key)/i;

/** Profiles that bind the document to canonical on-chain state. */
const ANCHORED_PROFILES = new Set(['anchored', 'runtime']);

/**
 * Static lint of a parsed document.
 *
 * Errors mean the document must not be used to authorize anything. Warnings
 * are operational smells that still allow enforcement to proceed.
 */
export function lintDomainMdSubset(doc: ParsedDomainMd): LintFinding[] {
  const findings: LintFinding[] = [];
  const fm = doc.frontmatter;

  if (fm.conformance.spec_version !== SUPPORTED_SPEC_VERSION) {
    findings.push({
      code: 'unsupported-spec-version',
      severity: 'error',
      path: 'conformance.spec_version',
      message: `domain.md declares spec ${fm.conformance.spec_version}; this runtime enforces ${SUPPORTED_SPEC_VERSION}.`,
    });
  }
  if (fm.conformance.schema !== SUPPORTED_SCHEMA_URI) {
    findings.push({
      code: 'spec-artifact-conflict',
      severity: 'error',
      path: 'conformance.schema',
      message: `Expected schema ${SUPPORTED_SCHEMA_URI}, found ${fm.conformance.schema}.`,
    });
  }
  if (fm.version !== fm.conformance.spec_version) {
    findings.push({
      code: 'spec-artifact-conflict',
      severity: 'error',
      path: 'version',
      message: `Top-level version '${fm.version}' disagrees with conformance.spec_version '${fm.conformance.spec_version}'.`,
    });
  }

  findings.push(...lintProfile(doc));
  findings.push(...lintAgentAuthority(fm));
  findings.push(...lintRights(fm));
  findings.push(...lintConstitution(fm));

  if (
    TEMPLATE_PLACEHOLDER.test(doc.body) ||
    TEMPLATE_PLACEHOLDER.test(JSON.stringify(fm))
  ) {
    findings.push({
      code: 'template-placeholder',
      severity: 'error',
      message: 'domain.md still contains template or publish placeholders.',
    });
  }

  for (const key of Object.keys(fm)) {
    if (SECRET_KEY_HINT.test(key)) {
      findings.push({
        code: 'secret-in-index',
        severity: 'error',
        path: key,
        message: `Field '${key}' looks like secret material; domain.md carries references, never secrets.`,
      });
    }
  }

  return findings;
}

function lintProfile(doc: ParsedDomainMd): LintFinding[] {
  const findings: LintFinding[] = [];
  const fm = doc.frontmatter;
  const { profile } = fm.conformance;
  if (!ANCHORED_PROFILES.has(profile)) return findings;

  if (!fm.domain.id.startsWith('did:ixo:')) {
    findings.push({
      code: 'missing-domain-id',
      severity: 'error',
      path: 'domain.id',
      message: `Profile '${profile}' requires domain.id to be a DID, found '${fm.domain.id}'.`,
    });
  }
  if (!fm.domain.iid) {
    findings.push({
      code: 'invalid-conformance-profile',
      severity: 'error',
      path: 'domain.iid',
      message: `Profile '${profile}' requires domain.iid to identify the canonical IID document.`,
    });
  }

  const anchoring = fm.documents?.anchoring;
  if (!anchoring || anchoring.method === 'none' || !anchoring.reference) {
    findings.push({
      code: 'document-unanchored',
      severity: 'error',
      path: 'documents.anchoring',
      message: `Profile '${profile}' requires an anchoring method and reference identifying the canonical record.`,
    });
  }
  if (anchoring?.cid) {
    findings.push({
      code: 'document-unanchored',
      severity: 'error',
      path: 'documents.anchoring.cid',
      message:
        'documents.anchoring.cid must stay null in the serialized file — the anchoring record supplies the CID of these bytes.',
    });
  }
  return findings;
}

function lintAgentAuthority(fm: DomainMdFrontmatter): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [key, value] of Object.entries(fm.agent_default_mode.overrides)) {
    if (value === true) {
      findings.push({
        code: 'open-ended-agent-authority',
        severity: 'error',
        path: `agent_default_mode.overrides.${key}`,
        message: `Override '${key}' is true; overrides may only lower the ceiling, never raise it.`,
      });
    }
  }
  if (fm.rights.agent_baseline.require_explicit_grant_for.length === 0) {
    findings.push({
      code: 'missing-rights-baseline',
      severity: 'error',
      path: 'rights.agent_baseline.require_explicit_grant_for',
      message:
        'The agent baseline is empty; at minimum the value-bearing and authority-changing actions must require an explicit grant.',
    });
  }
  return findings;
}

function lintRights(fm: DomainMdFrontmatter): LintFinding[] {
  const findings: LintFinding[] = [];
  const seen = new Set<string>();

  fm.rights.entries.forEach((grant, index) => {
    const path = `rights.entries[${index}]`;
    if (seen.has(grant.id)) {
      findings.push({
        code: 'duplicate-entry-id',
        severity: 'error',
        path: `${path}.id`,
        message: `Duplicate rights entry id '${grant.id}'.`,
      });
    }
    seen.add(grant.id);

    if (!RIGHT_TYPE_TO_ACTION[grant.type]) {
      findings.push({
        code: 'unrecognized-right-type',
        severity: 'error',
        path: `${path}.type`,
        message: `Right type '${grant.type}' maps to no known action class, so a request can never be matched against it.`,
      });
    }

    const { not_before: notBefore, expiry } = grant.conditions;
    if (notBefore && Number.isNaN(Date.parse(notBefore))) {
      findings.push({
        code: 'invalid-grant',
        severity: 'error',
        path: `${path}.conditions.not_before`,
        message: `not_before '${notBefore}' is not a valid timestamp.`,
      });
    }
    if (expiry && Number.isNaN(Date.parse(expiry))) {
      findings.push({
        code: 'invalid-grant',
        severity: 'error',
        path: `${path}.conditions.expiry`,
        message: `expiry '${expiry}' is not a valid timestamp.`,
      });
    }
    if (
      notBefore &&
      expiry &&
      !Number.isNaN(Date.parse(notBefore)) &&
      !Number.isNaN(Date.parse(expiry)) &&
      Date.parse(expiry) <= Date.parse(notBefore)
    ) {
      findings.push({
        code: 'invalid-grant',
        severity: 'error',
        path: `${path}.conditions`,
        message:
          'expiry is not after not_before; the grant can never be valid.',
      });
    }

    if (grant.effect === 'allow' && grant.capability.reference === null) {
      findings.push({
        code: 'invalid-grant',
        severity: 'warning',
        path: `${path}.capability.reference`,
        message: `Allow grant '${grant.id}' carries no capability reference; it can only be satisfied where the format does not require a proof.`,
      });
    }
  });

  return findings;
}

function lintConstitution(fm: DomainMdFrontmatter): LintFinding[] {
  const findings: LintFinding[] = [];
  const { constitution } = fm;

  if (constitution.subject !== fm.domain.id) {
    findings.push({
      code: 'constitutional-subject-profile-unresolved',
      severity: 'error',
      path: 'constitution.subject',
      message: `constitution.subject '${constitution.subject}' must equal domain.id '${fm.domain.id}'.`,
    });
  }

  if (constitution.status === 'not_applicable') {
    const declaresAgents = (fm.agents?.entries.length ?? 0) > 0;
    const agenticMode =
      MODE_RANK[fm.agent_default_mode.mode] > MODE_RANK.propose_only;
    if (declaresAgents || agenticMode) {
      findings.push({
        code: 'constitution-not-applicable-invalid',
        severity: 'error',
        path: 'constitution.status',
        message:
          'A domain that declares agents or operates above propose_only cannot declare its constitution not applicable.',
      });
    }
    if (!constitution.reason) {
      findings.push({
        code: 'constitution-not-applicable-invalid',
        severity: 'error',
        path: 'constitution.reason',
        message: 'A not_applicable constitution must explain why.',
      });
    }
  }

  if (
    constitution.status === 'suspended' ||
    constitution.status === 'superseded'
  ) {
    findings.push({
      code: 'constitution-conflicts-canonical',
      severity: 'warning',
      path: 'constitution.status',
      message: `Constitution status is '${constitution.status}'; authority-bearing actions should be halted until a canonical instrument is in force.`,
    });
  }

  return findings;
}

/** Convenience predicate — a document with no error findings may be enforced. */
export function hasBlockingFindings(findings: readonly LintFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}
