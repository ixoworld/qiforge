/**
 * @fileoverview Boot-time loading of the entity's `domain.md`: read, parse,
 * lint, apply the enforcement posture, and hand back either a frozen
 * `DomainContext` or the reasons the runtime must not start.
 *
 * The decision this file encodes is what a runtime is allowed to enforce on
 * behalf of an entity. A constitution the runtime cannot tie back to canonical
 * state is a file on a disk that some process wrote; enforcing against it
 * looks identical to enforcing against the real thing, which is the failure
 * mode worth refusing outright. So `strict` requires an anchored document, and
 * `permissive` — for development against a draft — says so loudly and records
 * that the anchor was never checked.
 *
 * What it does *not* do is treat "unanchored" as "ungated". Both postures
 * evaluate every call.
 */
import {
  buildDomainContext,
  isAnchoredProfile,
  type DomainContext,
  type DomainEnforcement,
} from './domain-context.js';
import {
  DomainMdParseError,
  hasBlockingFindings,
  lintDomainMdSubset,
  parseDomainMdSubset,
  type LintFinding,
} from './parse.js';
import type { Anchoring } from './schema.js';

/** A reason the runtime must not boot, shaped for the boot-error reporter. */
export interface DomainLoadError {
  field: string;
  message: string;
  hint?: string;
}

export interface LoadDomainMdResult {
  /** The constitution in force. Absent when `errors` is non-empty. */
  context: DomainContext | null;
  /** Refusals — boot must fail when this is non-empty. */
  errors: DomainLoadError[];
  /** Non-blocking findings and posture notes worth logging. */
  warnings: string[];
  /** Lint output, blocking or not, for the boot log. */
  findings: LintFinding[];
}

/**
 * Confirms a declared anchor against canonical state.
 *
 * Supplied by the host, because resolving an IID linked resource is a chain
 * call and this module stays free of network dependencies. When absent, an
 * anchor is accepted on the document's own declaration and the resulting
 * context records `anchorVerified: false` — an unproven anchor is a fact about
 * the deployment, not something to paper over.
 */
export type AnchorVerifier = (
  anchoring: Anchoring,
  expected: { cid: string; sha256: string },
) => Promise<boolean>;

export interface LoadDomainMdArgs {
  /** Where the bytes came from — a path, for diagnostics. */
  source: string;
  /** The document's exact bytes. */
  bytes: string;
  enforcement: DomainEnforcement;
  verifyAnchor?: AnchorVerifier;
}

/**
 * Parses and vets a `domain.md`, returning the context or the refusals.
 *
 * Never throws for document problems — a caller collecting boot errors wants
 * them all at once, not the first one.
 */
export async function loadDomainMd(
  args: LoadDomainMdArgs,
): Promise<LoadDomainMdResult> {
  const { source, bytes, enforcement } = args;
  const errors: DomainLoadError[] = [];
  const warnings: string[] = [];

  let parsed;
  try {
    parsed = parseDomainMdSubset(bytes);
  } catch (err) {
    const detail =
      err instanceof DomainMdParseError
        ? `${err.message} (${err.code})`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      context: null,
      errors: [
        {
          field: 'DOMAIN_MD_PATH',
          message: `The constitution at ${source} could not be parsed: ${detail}`,
          hint: 'A runtime cannot enforce a document it cannot read. Fix the document, or point DOMAIN_MD_PATH at the right one.',
        },
      ],
      warnings,
      findings: [],
    };
  }

  const findings = lintDomainMdSubset(parsed);
  if (hasBlockingFindings(findings)) {
    for (const finding of findings.filter((f) => f.severity === 'error')) {
      errors.push({
        field: finding.path ?? 'domain.md',
        message: `${finding.code}: ${finding.message}`,
      });
    }
  }
  for (const finding of findings.filter((f) => f.severity !== 'error')) {
    warnings.push(`[constitution] ${finding.code}: ${finding.message}`);
  }

  const profile = parsed.frontmatter.conformance.profile;
  const anchoring = parsed.frontmatter.documents?.anchoring ?? null;
  const anchored = isAnchoredProfile(profile);

  let anchorVerified = false;

  if (enforcement === 'strict') {
    // Only two things are decided here. Whether the anchoring block is
    // *structurally* sound — present, with a method and a reference, and
    // without a self-addressing cid — is already a blocking lint rule, so
    // re-checking it would add a second message saying the same thing and a
    // second place to keep correct.
    if (!anchored) {
      errors.push({
        field: 'DOMAIN_ENFORCEMENT',
        message:
          `The constitution at ${source} declares conformance profile '${profile}', ` +
          `which does not assert that it is bound to canonical state. Strict enforcement ` +
          `requires 'anchored' or 'runtime'.`,
        hint: "Anchor the document as a linked resource on the entity's IID, or set DOMAIN_ENFORCEMENT=permissive for development.",
      });
    } else if (!anchoring?.reference) {
      // Unreachable while the lint rule stands, and left as the fail-closed
      // floor if it ever moves: an unverifiable anchor must not become a
      // verified one by falling through to the branch below.
      errors.push({
        field: 'domain.md',
        message:
          `The constitution at ${source} claims profile '${profile}' but its anchoring ` +
          `block names no canonical record, so the claim cannot be checked.`,
      });
    } else if (args.verifyAnchor) {
      anchorVerified = await args
        .verifyAnchor(anchoring, {
          cid: parsed.digest.cid,
          sha256: parsed.digest.sha256,
        })
        .catch(() => false);
      if (!anchorVerified) {
        errors.push({
          field: 'domain.md',
          message:
            `The anchor declared at documents.anchoring could not be confirmed against ` +
            `canonical state for the document at ${source} (cid ${parsed.digest.cid}).`,
          hint: 'Re-anchor the document, or correct documents.anchoring to reference the revision actually in force.',
        });
      }
    } else {
      warnings.push(
        `[constitution] Anchor accepted on the document's own declaration — no verifier was ` +
          `supplied, so the reference at documents.anchoring was not resolved. Decisions will ` +
          `record anchorVerified=false.`,
      );
    }
  } else if (!anchored) {
    warnings.push(
      `[constitution] Running under permissive enforcement against an unanchored constitution ` +
        `(profile '${profile}', revision ${parsed.frontmatter.document_revision}, cid ` +
        `${parsed.digest.cid}). Every tool call is still evaluated, but nothing ties this ` +
        `document to canonical state — do not deploy this way.`,
    );
  }

  if (errors.length > 0) {
    return { context: null, errors, warnings, findings };
  }

  return {
    context: buildDomainContext({
      parsed,
      enforcement,
      source,
      anchorVerified,
    }),
    errors,
    warnings,
    findings,
  };
}
