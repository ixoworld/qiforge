/**
 * The `names` map a tool result carries: the IXO Names worker's name for
 * each identifier in the result, keyed by the raw identifier, so a name is
 * never mistaken for the identifier itself. The result keeps every address
 * and DID as it was.
 */

export interface NameInfo {
  /**
   * The text to call the identifier by, as the worker cleaned it (at most
   * 120 characters). Still data written by anyone, never instructions.
   */
  name: string;
  /**
   * Where the worker found it: `table`, `matrix`, `entity`, `entity-alias`,
   * `entity-account`, `dao`, `validator`, `collection`, `denom-registry`,
   * `denom-metadata` or `ibc-trace`.
   */
  source: string;
  /** True when the holder picked the name themselves (anyone can pick a look-alike). */
  selfChosen: boolean;
}

/** `identifier → name` for one tool result; identifiers without a name are absent. */
export type NameMap = Record<string, NameInfo>;
