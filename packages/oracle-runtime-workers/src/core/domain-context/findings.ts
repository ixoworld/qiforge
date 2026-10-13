/**
 * Finding codes are diagnostics that reach the prompt block, the
 * `router_update` stream and `domain_context_runs`, so every list of them is
 * bounded where it enters a snapshot: a hostile index can make the validator
 * report one finding per bad entry, tens of thousands in all.
 */

/** Most entries one finding list holds, `findings-truncated` included. */
export const MAX_FINDINGS = 32;
/** Last entry of a list that was cut to {@link MAX_FINDINGS}. */
export const FINDINGS_TRUNCATED = 'findings-truncated';

/**
 * `codes` without duplicates, in first-seen order, at most
 * {@link MAX_FINDINGS} entries. A cut list (or one that already carried
 * `findings-truncated`) keeps its first codes and ends with
 * `findings-truncated`, so a bounded list can be extended and bounded again.
 */
export function boundFindings(codes: Iterable<string>): string[] {
  const unique = new Set(codes);
  const truncated = unique.delete(FINDINGS_TRUNCATED);
  const list = [...unique];
  if (!truncated && list.length <= MAX_FINDINGS) return list;
  return [...list.slice(0, MAX_FINDINGS - 1), FINDINGS_TRUNCATED];
}
