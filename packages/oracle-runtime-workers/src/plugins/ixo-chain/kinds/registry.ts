/**
 * Every `chain_lookup` kind, in catalogue order: the core kinds, then the
 * chain REST kinds, then the Blocksync-indexed kinds. Names are unique:
 * a name registered twice fails the module at load.
 */
import { CHAIN_KINDS } from './chain';
import { CORE_KINDS } from './core';
import { INDEXED_KINDS } from './indexed';
import type { KindDef } from './types';

/** `kinds` by name; throws when two share a name. */
export function indexKinds(
  kinds: readonly KindDef[],
): ReadonlyMap<string, KindDef> {
  const byName = new Map<string, KindDef>();
  for (const kind of kinds) {
    if (byName.has(kind.name))
      throw new Error(`ixo-chain: kind "${kind.name}" is registered twice`);
    byName.set(kind.name, kind);
  }
  return byName;
}

export const KINDS: readonly KindDef[] = [
  ...CORE_KINDS,
  ...CHAIN_KINDS,
  ...INDEXED_KINDS,
];

const BY_NAME = indexKinds(KINDS);

function namesOf(kinds: readonly KindDef[]): [string, ...string[]] {
  const [first, ...rest] = kinds.map((kind) => kind.name);
  if (first === undefined) throw new Error('ixo-chain: no kinds registered');
  return [first, ...rest];
}

/** Every kind's name in catalogue order: the `kind` enum of `chain_lookup`. */
export const kindNames = namesOf(KINDS);

export function kindByName(name: string): KindDef | undefined {
  return BY_NAME.get(name);
}
