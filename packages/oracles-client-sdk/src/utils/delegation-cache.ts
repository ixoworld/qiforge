/* eslint-disable no-console */

interface CachedDelegation {
  serialized: string;
  expiresAt: number;
}

type DelegationMap = Record<string, CachedDelegation>;

const STORAGE_KEY = 'oracles_ucan_delegations';
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

function loadMap(): DelegationMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as DelegationMap;
  } catch {
    return {};
  }
}

function saveMap(map: DelegationMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    console.error('Failed to save delegation cache:', error);
  }
}

function cacheKey(userDid: string, oracleDid: string): string {
  return `${userDid}::${oracleDid}`;
}

export function getCachedDelegation(
  userDid: string,
  oracleDid: string,
): string | null {
  const map = loadMap();
  const key = cacheKey(userDid, oracleDid);
  const entry = map[key];

  if (!entry) return null;

  if (entry.expiresAt < Date.now() + EXPIRY_BUFFER_MS) {
    delete map[key];
    saveMap(map);
    return null;
  }

  return entry.serialized;
}

export function setCachedDelegation(
  userDid: string,
  oracleDid: string,
  serialized: string,
  expiresAt: number,
): void {
  const map = loadMap();
  const key = cacheKey(userDid, oracleDid);
  map[key] = { serialized, expiresAt };

  // Prune expired entries
  const now = Date.now();
  for (const k of Object.keys(map)) {
    if (map[k]!.expiresAt < now) {
      delete map[k];
    }
  }

  saveMap(map);
}

/** Forget one user's delegation to one oracle (it is being replaced). */
export function removeCachedDelegation(
  userDid: string,
  oracleDid: string,
): void {
  const map = loadMap();
  const key = cacheKey(userDid, oracleDid);
  if (!(key in map)) return;
  delete map[key];
  saveMap(map);
}

export function clearDelegationCache(): void {
  localStorage.removeItem(STORAGE_KEY);
}
