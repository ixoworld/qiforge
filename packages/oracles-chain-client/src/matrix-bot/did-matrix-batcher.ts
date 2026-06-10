import { request, gql } from 'graphql-request';
import { chainNetwork } from './config.js';

export const MATRIX_SERVICE_TYPE = 'MatrixHomeServer';
const BATCH_DELAY_MS = 400;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 5000;

export interface MatrixBotUrls {
  stateBot: string;
  roomsBot: string;
  bidBot: string;
  claimBot: string;
}

export interface MatrixUrls extends MatrixBotUrls {
  homeServer: string;
  homeServerCropped: string;
}

interface CacheEntry {
  homeServerUrl: string;
  timestamp: number;
}

interface BatchState {
  dids: Set<string>;
  resolvers: Array<(results: Map<string, string | null>) => void>;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface IidService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

interface IidNode {
  id: string;
  service: IidService[];
}

interface EntityNode {
  id: string;
  service: IidService[];
}

const cache = new Map<string, CacheEntry>();

const batchState: BatchState = {
  dids: new Set(),
  resolvers: [],
  timeoutId: null,
};

function getBlocksyncGraphqlUrl(): string {
  const envUrl =
    typeof process !== 'undefined' ? process.env.BLOCKSYNC_URI : undefined;
  if (envUrl) {
    return envUrl.replace(/\/$/, '') + '/graphql';
  }

  const defaults = {
    devnet: 'https://devnet-blocksync-graphql.ixo.earth/graphql',
    testnet: 'https://testnet-blocksync-graphql.ixo.earth/graphql',
    mainnet: 'https://blocksync-graphql.ixo.earth/graphql',
  } as const;
  return (
    defaults[chainNetwork] ?? 'https://blocksync-graphql.ixo.earth/graphql'
  );
}

function isEntityDid(did: string): boolean {
  return did.startsWith('did:ixo:entity:');
}

function extractUrlDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    const cleaned = url.replace(/^https?:\/\//, '');
    return cleaned.split('/')[0] ?? cleaned;
  }
}

/**
 * Normalizes a Matrix home-server base URL so it can be safely concatenated
 * with request paths (`${url}/_matrix/...`) without producing double slashes.
 *
 * On-chain `serviceEndpoint` values are user/registration-supplied and have
 * been observed carrying trailing slashes and stray whitespace/CRLF
 * (`"https://mx.ixo.earth/\r\n"`), which break Synapse routing (`//_matrix`
 * returns 404).
 *
 * - strips all whitespace
 * - prepends "https://" when no protocol is present (bare domains)
 * - strips ALL trailing slashes
 *
 * Returns "" for empty/nullish input so callers can fall back to a default.
 */
export function normalizeMatrixHomeServerUrl(
  url: string | null | undefined,
): string {
  if (!url) return '';

  const trimmed = url.replace(/\s+/g, '');
  if (trimmed === '') return '';

  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
}

export function deriveMatrixBotUrls(homeServerUrl: string): MatrixBotUrls {
  const domain = extractUrlDomain(homeServerUrl);
  return {
    stateBot: `https://state.bot.${domain}`,
    roomsBot: `https://rooms.bot.${domain}`,
    bidBot: `https://bid.bot.${domain}`,
    claimBot: `https://claim.bot.${domain}`,
  };
}

export function buildMatrixUrlsFromHomeServer(
  homeServerUrl: string,
): MatrixUrls {
  const normalized =
    normalizeMatrixHomeServerUrl(homeServerUrl) || homeServerUrl;
  const botUrls = deriveMatrixBotUrls(normalized);
  return {
    homeServer: normalized,
    homeServerCropped: extractUrlDomain(normalized),
    ...botUrls,
  };
}

function getDefaultHomeServerForDid(_did: string): string {
  return getIxoDefaultHomeServer();
}

export function getIxoDefaultHomeServer(): string {
  const defaults = {
    devnet: 'https://devmx.ixo.earth',
    testnet: 'https://testmx.ixo.earth',
    mainnet: 'https://mx.ixo.earth',
  } as const;
  return defaults[chainNetwork] ?? 'https://mx.ixo.earth';
}

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

function getCachedHomeServer(did: string): string | null {
  const entry = cache.get(did);
  if (entry && isCacheValid(entry)) {
    return entry.homeServerUrl;
  }
  if (entry && !isCacheValid(entry)) {
    cache.delete(did);
  }
  return null;
}

function setCachedHomeServer(did: string, homeServerUrl: string): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
  cache.set(did, {
    homeServerUrl,
    timestamp: Date.now(),
  });
}

const QUERY_IIDS = gql`
  query BatchIidServices($dids: [String!]) {
    iids(filter: { id: { in: $dids } }) {
      nodes {
        id
        service
      }
    }
  }
`;

const QUERY_ENTITIES = gql`
  query BatchEntityServices($dids: [String!]) {
    entities(filter: { id: { in: $dids } }) {
      nodes {
        id
        service
      }
    }
  }
`;

async function queryIidServices(
  dids: string[],
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

  if (dids.length === 0) {
    return results;
  }

  try {
    const data = await request<{
      iids: { nodes: IidNode[] };
    }>(getBlocksyncGraphqlUrl(), QUERY_IIDS, { dids });

    if (!data?.iids?.nodes) {
      // eslint-disable-next-line no-console -- browser-reachable file; @ixo/logger uses node:util and breaks webpack frontend builds (see package CLAUDE.md)
      console.error(
        '[DidMatrixBatcher] Error querying IIDs: no nodes returned',
      );
      dids.forEach((did) => results.set(did, null));
      return results;
    }

    const nodeMap = new Map<string, IidNode>();
    for (const node of data.iids.nodes) {
      nodeMap.set(node.id, node);
    }

    for (const did of dids) {
      const node = nodeMap.get(did);
      if (!node) {
        results.set(did, null);
        continue;
      }

      const matrixService = node.service?.find(
        (s) => s.type === MATRIX_SERVICE_TYPE,
      );
      const normalized = normalizeMatrixHomeServerUrl(
        matrixService?.serviceEndpoint,
      );
      results.set(did, normalized || null);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[DidMatrixBatcher] Error executing IID query:', error);
    dids.forEach((did) => results.set(did, null));
  }

  return results;
}

async function queryEntityServices(
  entityDids: string[],
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

  if (entityDids.length === 0) {
    return results;
  }

  try {
    const data = await request<{
      entities: { nodes: EntityNode[] };
    }>(getBlocksyncGraphqlUrl(), QUERY_ENTITIES, { dids: entityDids });

    if (!data?.entities?.nodes) {
      // eslint-disable-next-line no-console
      console.error(
        '[DidMatrixBatcher] Error querying entities: no nodes returned',
      );
      entityDids.forEach((did) => results.set(did, null));
      return results;
    }

    const nodeMap = new Map<string, EntityNode>();
    for (const node of data.entities.nodes) {
      nodeMap.set(node.id, node);
    }

    for (const did of entityDids) {
      const node = nodeMap.get(did);
      if (!node) {
        results.set(did, null);
        continue;
      }

      const matrixService = node.service?.find(
        (s) => s.type === MATRIX_SERVICE_TYPE,
      );
      const normalized = normalizeMatrixHomeServerUrl(
        matrixService?.serviceEndpoint,
      );
      results.set(did, normalized || null);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[DidMatrixBatcher] Error executing entity query:', error);
    entityDids.forEach((did) => results.set(did, null));
  }

  return results;
}

async function executeBatchQuery(
  dids: string[],
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

  if (dids.length === 0) {
    return results;
  }

  const entityDids = dids.filter(isEntityDid);
  const nonEntityDids = dids.filter((did) => !isEntityDid(did));

  const [entityResults, iidResults] = await Promise.all([
    queryEntityServices(entityDids),
    queryIidServices(nonEntityDids),
  ]);

  for (const [did, url] of entityResults) {
    results.set(did, url);
  }
  for (const [did, url] of iidResults) {
    results.set(did, url);
  }

  return results;
}

async function processBatch(): Promise<void> {
  const didsToQuery = Array.from(batchState.dids);
  const resolvers = [...batchState.resolvers];

  batchState.dids.clear();
  batchState.resolvers = [];
  batchState.timeoutId = null;

  if (didsToQuery.length === 0) {
    return;
  }

  const results = await executeBatchQuery(didsToQuery);

  for (const [did, matrixUrl] of results.entries()) {
    const homeServerUrl = matrixUrl || getDefaultHomeServerForDid(did);
    setCachedHomeServer(did, homeServerUrl);
  }

  const finalResults = new Map<string, string | null>();
  for (const [did, matrixUrl] of results.entries()) {
    finalResults.set(did, matrixUrl || getDefaultHomeServerForDid(did));
  }

  for (const resolver of resolvers) {
    resolver(finalResults);
  }
}

function addToBatch(did: string): Promise<string> {
  return new Promise((resolve) => {
    batchState.dids.add(did);

    const resolver = (results: Map<string, string | null>) => {
      const url = results.get(did);
      resolve(url || getDefaultHomeServerForDid(did));
    };
    batchState.resolvers.push(resolver);

    if (!batchState.timeoutId) {
      batchState.timeoutId = setTimeout(
        () => void processBatch(),
        BATCH_DELAY_MS,
      );
    }
  });
}

export async function getMatrixHomeServerForDid(did: string): Promise<string> {
  const cachedUrl = getCachedHomeServer(did);
  if (cachedUrl) {
    return cachedUrl;
  }
  return addToBatch(did);
}

export async function getMatrixUrlsForDid(did: string): Promise<MatrixUrls> {
  const homeServerUrl = await getMatrixHomeServerForDid(did);
  return buildMatrixUrlsFromHomeServer(homeServerUrl);
}

export async function getMatrixHomeServerCroppedForDid(
  did: string,
): Promise<string> {
  const homeServerUrl = await getMatrixHomeServerForDid(did);
  return extractUrlDomain(homeServerUrl);
}

export function getCachedMatrixHomeServerForDid(did: string): string | null {
  return getCachedHomeServer(did);
}

export function isMatrixCacheValidForDid(did: string): boolean {
  return getCachedHomeServer(did) !== null;
}

export async function prefetchMatrixUrlsForDids(dids: string[]): Promise<void> {
  const uncachedDids = dids.filter((did) => !getCachedHomeServer(did));

  if (uncachedDids.length === 0) {
    return;
  }

  await Promise.all(uncachedDids.map((did) => addToBatch(did)));
}

export async function getMultipleMatrixUrls(
  dids: string[],
): Promise<Map<string, MatrixUrls>> {
  await prefetchMatrixUrlsForDids(dids);

  const results = new Map<string, MatrixUrls>();

  for (const did of dids) {
    const homeServerUrl =
      getCachedHomeServer(did) || getDefaultHomeServerForDid(did);
    results.set(did, buildMatrixUrlsFromHomeServer(homeServerUrl));
  }

  return results;
}

export function clearCache(): void {
  cache.clear();
}

export function getCacheStats(): { size: number; maxSize: number } {
  return {
    size: cache.size,
    maxSize: MAX_CACHE_SIZE,
  };
}
