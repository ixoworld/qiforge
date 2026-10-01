/**
 * Semantic port types (spec §5/§7.5). Actions don't ship typed input/output
 * ports, so we infer a semantic type from the field name (a documented core
 * vocabulary), with the metadata overlay as the authoritative override.
 *
 * Open vocabulary: an unrecognised field falls back to its primitive type.
 */
export const CORE_PORT_TYPES = [
  'did',
  'entityDid',
  'chainAddress',
  'transactionHash',
  'claimId',
  'claimCollectionId',
  'roomId',
  'messageId',
  'eventId',
  'proposalId',
  'bidId',
  'invoiceId',
] as const;

const CORE = new Set<string>(CORE_PORT_TYPES);

/** Field-name (leaf) patterns -> semantic port type. Order matters (most specific first). */
const PATTERNS: Array<[RegExp, string]> = [
  [/transactionhash$/i, 'transactionHash'],
  [/entitydid$/i, 'entityDid'],
  [/collectionid$/i, 'claimCollectionId'],
  [/claimid$/i, 'claimId'],
  [/proposalid$/i, 'proposalId'],
  [/invoiceid$/i, 'invoiceId'],
  [/bidid$/i, 'bidId'],
  [/roomid$/i, 'roomId'],
  [/messageid$/i, 'messageId'],
  [/eventid$/i, 'eventId'],
  [/(^|[a-z])did$/i, 'did'],
  [/address$/i, 'chainAddress'],
];

/** Whether a port type is part of the documented core (i.e. safe to enforce on a mismatch). */
export function isCorePortType(type: string): boolean {
  return CORE.has(type);
}

/** Infer a semantic port type from a field path, falling back to the primitive type. */
export function inferPortType(path: string, primitive?: string): string {
  const leaf = path.split('.').pop() ?? path;
  for (const [pattern, type] of PATTERNS) {
    if (pattern.test(leaf)) return type;
  }
  return primitive ?? 'string';
}
