/* eslint-disable no-console */

interface CachedInvocation {
  serialized: string;
  expiresAt: number;
}

type InvocationMap = Record<string, CachedInvocation>;

const STORAGE_KEY = 'oracles_ucan_invocations';
const EXPIRY_BUFFER_MS = 30 * 1000; // 30 seconds — invocations are short-lived (~5 min)

function loadMap(): InvocationMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as InvocationMap;
  } catch {
    return {};
  }
}

function saveMap(map: InvocationMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    console.error('Failed to save invocation cache:', error);
  }
}

function cacheKey(userDid: string, oracleDid: string): string {
  return `${userDid}::${oracleDid}`;
}

export function getCachedInvocation(
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

export function setCachedInvocation(
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

export function clearInvocationCache(): void {
  localStorage.removeItem(STORAGE_KEY);
}
