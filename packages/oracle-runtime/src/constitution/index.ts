/**
 * @fileoverview The constitution layer, importable on its own.
 *
 * Everything here is pure: parse, lint, project, evaluate. No Matrix, no Nest,
 * no network. That is why it has its own entrypoint — a fork validating its
 * `domain.md` in CI, or a tool reasoning about a constitution outside a
 * running oracle, should not have to satisfy a runtime's environment to do it.
 */
export {
  authorize,
  toConstitutionPolicy,
  REASON,
  type AuthorizationRequest,
  type AuthorizationDecision,
  type AuthorizationOutcome,
  type AuthorizeDeps,
  type CapabilityVerdict,
  type ConstitutionPolicy,
  type Obligation,
} from './authorize.js';
export {
  buildDomainContext,
  isAnchoredProfile,
  resolveAgent,
  type AgentResolution,
  type DomainContext,
  type DomainEnforcement,
} from './domain-context.js';
export {
  loadDomainMd,
  type AnchorVerifier,
  type DomainLoadError,
  type LoadDomainMdArgs,
  type LoadDomainMdResult,
} from './load.js';
export {
  computeDomainMdDigest,
  hasBlockingFindings,
  lintDomainMdSubset,
  parseDomainMdSubset,
  DomainMdParseError,
  MAX_DOMAIN_MD_BYTES,
  type LintFinding,
} from './parse.js';
export * from './schema.js';
export {
  systemClock,
  fixedClock,
  type TimeReading,
  type TimeSource,
} from './time.js';
