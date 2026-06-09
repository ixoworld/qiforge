/**
 * Thrown by the runtime's UCAN adapter (`bootstrap/ambient-factory.ts`) when an
 * invocation cannot be minted for an EXPECTED reason — the oracle has no signing
 * key loaded, or the user has no cached delegation. It is deliberately distinct
 * from a plain `Error` (which signals an UNEXPECTED mint/sign failure) so plugin
 * auth helpers can classify the two without matching error-message substrings:
 * an `instanceof UcanMintUnavailableError` check demotes the expected case to a
 * non-error log and degrades silently, while any other throw is a real failure.
 */
export class UcanMintUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UcanMintUnavailableError';
  }
}
