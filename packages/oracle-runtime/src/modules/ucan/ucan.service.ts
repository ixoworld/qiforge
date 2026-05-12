/**
 * @fileoverview UCAN service for Oracle
 *
 * Handles:
 * 1. UCAN validation for MCP tool invocations (client → oracle)
 * 2. UCAN invocation creation for downstream services (oracle → sandbox, etc.)
 * 3. Ed25519 signing key management (stored in memory at startup)
 * 4. Service DID resolution via did:web (/.well-known/did.json)
 * 5. User delegation caching (keyed by user DID)
 */

import { type Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import {
  buildRequiredCapability,
  createMCPUCANConfig,
  loadUCANConfigFromEnv,
  type MCPUCANConfig,
  requiresUCANAuth,
} from './ucan.config.js';

// ============================================================================
// Inline implementations (can be replaced with @ixo/ucan imports once built)
// ============================================================================

type KeyDID = `did:key:${string}`;

type DIDKeyResolver = (
  did: string,
) => Promise<
  { ok: KeyDID[] } | { error: { name: string; did: string; message: string } }
>;

interface InvocationStore {
  has(cid: string): Promise<boolean>;
  add(cid: string, ttlMs?: number): Promise<void>;
  cleanup?(): Promise<void>;
}

class InMemoryInvocationStore implements InvocationStore {
  private store = new Map<string, number>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly defaultTtlMs: number;

  constructor(
    options: { defaultTtlMs?: number; cleanupIntervalMs?: number } = {},
  ) {
    this.defaultTtlMs = options.defaultTtlMs ?? 24 * 60 * 60 * 1000;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1000;

    this.cleanupInterval = setInterval(() => {
      void this.cleanup();
    }, cleanupIntervalMs);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  async has(cid: string): Promise<boolean> {
    const expiry = this.store.get(cid);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.store.delete(cid);
      return false;
    }
    return true;
  }

  async add(cid: string, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(cid, Date.now() + ttl);
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [cid, expiry] of this.store.entries()) {
      if (now > expiry) {
        this.store.delete(cid);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

function createIxoDIDResolver(config: { indexerUrl: string }): DIDKeyResolver {
  const DID_DOCUMENT_QUERY = `
    query GetDIDDocument($id: String!) {
      iids(filter: { id: { equalTo: $id } }) {
        nodes {
          id
          verificationMethod
        }
      }
    }
  `;

  return async (did: string) => {
    if (!did.startsWith('did:ixo:')) {
      return {
        error: {
          name: 'DIDKeyResolutionError',
          did,
          message: `Cannot resolve ${did}: not a did:ixo identifier`,
        },
      };
    }

    try {
      const response = await fetch(config.indexerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: DID_DOCUMENT_QUERY,
          variables: { id: did },
        }),
      });

      if (!response.ok) {
        return {
          error: {
            name: 'DIDKeyResolutionError',
            did,
            message: `Failed to fetch DID document: HTTP ${response.status}`,
          },
        };
      }

      interface VerificationMethod {
        id: string;
        type: string;
        publicKeyMultibase?: string;
      }

      const data = (await response.json()) as {
        data?: {
          iids?: {
            nodes?: Array<{ verificationMethod?: VerificationMethod[] }>;
          };
        };
        errors?: Array<{ message: string }>;
      };

      if (data.errors && data.errors.length > 0) {
        return {
          error: {
            name: 'DIDKeyResolutionError',
            did,
            message: `GraphQL error: ${data.errors[0]?.message ?? 'Unknown error'}`,
          },
        };
      }

      const didDoc = data.data?.iids?.nodes?.[0];
      if (!didDoc) {
        return {
          error: {
            name: 'DIDKeyResolutionError',
            did,
            message: `DID document not found for ${did}`,
          },
        };
      }

      const keys: KeyDID[] = [];
      for (const vm of didDoc.verificationMethod || []) {
        if (
          vm.type.includes('Ed25519') &&
          vm.publicKeyMultibase?.startsWith('z')
        ) {
          keys.push(`did:key:${vm.publicKeyMultibase}`);
        }
      }

      if (keys.length === 0) {
        return {
          error: {
            name: 'DIDKeyResolutionError',
            did,
            message: `No valid Ed25519 verification methods found for ${did}`,
          },
        };
      }

      return { ok: keys };
    } catch (error) {
      return {
        error: {
          name: 'DIDKeyResolutionError',
          did,
          message: `Failed to resolve ${did}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      };
    }
  };
}

function createCompositeDIDResolver(
  resolvers: DIDKeyResolver[],
): DIDKeyResolver {
  return async (did: string) => {
    for (const resolver of resolvers) {
      const result = await resolver(did);
      if ('ok' in result) {
        return result;
      }
      if (result.error.message.includes('not a did:')) {
        continue;
      }
      return result;
    }
    return {
      error: {
        name: 'DIDKeyResolutionError',
        did,
        message: `No resolver could handle ${did}`,
      },
    };
  };
}

function createMCPResourceURI(
  oracleDid: string,
  serverName: string,
  toolName: string,
): string {
  return `ixo:oracle:${oracleDid}:mcp/${serverName}/${toolName}`;
}

// ============================================================================
// Constants
// ============================================================================

const DELEGATION_CACHE_PREFIX = 'ucan_delegation_';
const INVOCATION_CACHE_PREFIX = 'ucan_invocation_';
const MAX_INVOCATION_TTL_SECONDS = 3600; // 1 hour max

// ============================================================================
// UCAN Service
// ============================================================================

export interface MCPValidationResult {
  valid: boolean;
  error?: string;
  invokerDid?: string;
}

@Injectable()
export class UcanService implements OnModuleDestroy {
  private readonly logger = new Logger(UcanService.name);
  private readonly config: MCPUCANConfig;
  private readonly invocationStore: InvocationStore;
  private readonly didResolver: DIDKeyResolver;

  private signingMnemonic: string | null = null;
  private oracleDid: string | null = null;
  private readonly serviceDidCache = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {
    this.config = this.loadConfig();

    this.invocationStore = new InMemoryInvocationStore({
      defaultTtlMs: 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
    });

    const indexerUrl = this.configService.get<string>('BLOCKSYNC_GRAPHQL_URL');
    this.didResolver = this.createDIDResolver(indexerUrl);

    this.logger.log('UCAN service initialized');
    this.logger.log(`Oracle DID: ${this.config.oracleDid}`);
    this.logger.log(`Root issuers: ${this.config.rootIssuers.join(', ')}`);
    this.logger.log(
      `Protected MCP servers: ${Object.keys(this.config.requirements).join(', ') || 'none'}`,
    );
  }

  onModuleDestroy() {
    if (this.invocationStore instanceof InMemoryInvocationStore) {
      this.invocationStore.destroy();
    }
  }

  private loadConfig(): MCPUCANConfig {
    const envConfig = loadUCANConfigFromEnv();
    const oracleDid =
      this.configService.get<string>('ORACLE_ENTITY_DID') ||
      envConfig.oracleDid;
    const rootIssuers =
      envConfig.rootIssuers.length > 0 ? envConfig.rootIssuers : [oracleDid];

    return createMCPUCANConfig(oracleDid, rootIssuers, {});
  }

  private createDIDResolver(indexerUrl?: string): DIDKeyResolver {
    const resolvers: DIDKeyResolver[] = [];

    if (indexerUrl) {
      resolvers.push(createIxoDIDResolver({ indexerUrl }));
    }

    const didKeyResolver: DIDKeyResolver = async (did) => {
      if (did.startsWith('did:key:')) {
        return { ok: [did as KeyDID] };
      }
      return {
        error: {
          name: 'DIDKeyResolutionError',
          did,
          message: 'Not a did:key',
        },
      };
    };
    resolvers.push(didKeyResolver);

    return createCompositeDIDResolver(resolvers);
  }

  // ============================================================================
  // Signing key management
  // ============================================================================

  /**
   * Store the Ed25519 signing mnemonic in memory (called once at startup).
   * Uses the same mnemonic from setupClaimSigningMnemonics.
   */
  setSigningMnemonic(mnemonic: string, did: string): void {
    this.signingMnemonic = mnemonic;
    this.oracleDid = did;
    this.logger.log(`[UCAN] Signing mnemonic stored for ${did}`);
  }

  hasSigningKey(): boolean {
    return this.signingMnemonic !== null;
  }

  // ============================================================================
  // User delegation caching
  // ============================================================================

  /**
   * Cache a raw UCAN delegation string for a user.
   * Called by auth-header.middleware after successful validation.
   */
  async cacheDelegation(
    userDid: string,
    rawDelegation: string,
    expirationUnix?: number,
  ): Promise<void> {
    const ttlMs = expirationUnix
      ? expirationUnix * 1000 - Date.now()
      : 7 * 24 * 60 * 60 * 1000; // 7 days default

    if (ttlMs <= 0) {
      this.logger.warn(`[UCAN] Delegation for ${userDid} already expired`);
      return;
    }

    await this.cacheManager.set(
      `${DELEGATION_CACHE_PREFIX}${userDid}`,
      rawDelegation,
      ttlMs,
    );
    this.logger.debug(
      `[UCAN] Cached delegation for ${userDid} (TTL: ${Math.round(ttlMs / 1000)}s)`,
    );
  }

  async getCachedDelegation(userDid: string): Promise<string | null> {
    const cached = await this.cacheManager.get<string>(
      `${DELEGATION_CACHE_PREFIX}${userDid}`,
    );
    return cached ?? null;
  }

  // ============================================================================
  // Service DID resolution (did:web via /.well-known/did.json)
  // ============================================================================

  /**
   * Resolve a service URL to its did:web DID.
   * Fetches /.well-known/did.json from the service's domain and caches the result.
   */
  async resolveServiceDid(serviceUrl: string): Promise<string | null> {
    try {
      const url = new URL(serviceUrl);
      const origin = url.origin;

      const cached = this.serviceDidCache.get(origin);
      if (cached) return cached;

      const didDocUrl = `${origin}/.well-known/did.json`;
      const response = await fetch(didDocUrl);

      if (!response.ok) {
        this.logger.warn(
          `[UCAN] Failed to fetch DID document from ${didDocUrl}: HTTP ${response.status}`,
        );
        return null;
      }

      const doc = (await response.json()) as { id?: string };
      if (!doc.id) {
        this.logger.warn(`[UCAN] DID document at ${didDocUrl} has no id field`);
        return null;
      }

      this.serviceDidCache.set(origin, doc.id);
      this.logger.log(`[UCAN] Resolved service DID for ${origin}: ${doc.id}`);
      return doc.id;
    } catch (error) {
      this.logger.warn(
        `[UCAN] Failed to resolve service DID for ${serviceUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ============================================================================
  // Service invocation creation (oracle → downstream service)
  // ============================================================================

  /**
   * Create a serialized UCAN invocation for calling a downstream service.
   * The invocation embeds the user's delegation as proof, forming:
   *   user (delegation.iss) → oracle (invocation.iss) → service (invocation.aud)
   *
   * @param serviceUrl - URL of the downstream service (used to resolve did:web)
   * @param userDid - The user's DID (used to look up cached delegation)
   * @param resource - The capability resource URI (e.g., 'ixo:sandbox')
   * @returns Base64-encoded invocation CAR, or null if unavailable
   */
  async createServiceInvocation(
    serviceUrl: string,
    userDid: string,
    resource = 'ixo:sandbox',
  ): Promise<string | null> {
    const serviceDid = await this.resolveServiceDid(serviceUrl);
    if (!serviceDid) {
      this.logger.debug(
        `[UCAN] Could not resolve service DID for ${serviceUrl}`,
      );
      return null;
    }
    return this.mintInvocationForServiceDid(userDid, serviceDid, resource);
  }

  /**
   * Mint a UCAN invocation when the downstream service DID is already known
   * (e.g. a plugin called `resolveServiceDid` separately and now wants to
   * mint with the resolved DID directly). Same semantics as
   * `createServiceInvocation` minus the URL → DID lookup.
   */
  async mintInvocationForServiceDid(
    userDid: string,
    serviceDid: string,
    resource = 'ixo:sandbox',
  ): Promise<string | null> {
    if (!this.signingMnemonic || !this.oracleDid) {
      this.logger.debug('[UCAN] No signing key available, skipping invocation');
      return null;
    }

    const rawDelegation = await this.getCachedDelegation(userDid);
    if (!rawDelegation) {
      this.logger.debug(
        `[UCAN] No cached delegation for ${userDid}, skipping invocation`,
      );
      return null;
    }

    // Check invocation cache
    const cacheKey = `${INVOCATION_CACHE_PREFIX}${userDid}:${serviceDid}`;
    const cached = await this.cacheManager.get<{
      invocation: string;
      expiresAt: number;
    }>(cacheKey);
    if (cached && cached.expiresAt > Date.now() / 1000) {
      this.logger.debug(
        `[UCAN] Using cached invocation for ${userDid} → ${serviceDid}`,
      );
      return cached.invocation;
    }

    try {
      const {
        signerFromMnemonic,
        createInvocation,
        serializeInvocation,
        parseDelegation,
      } = await import('@ixo/ucan');

      const { signer } = await signerFromMnemonic(
        this.signingMnemonic,
        this.oracleDid as `did:ixo:${string}`,
      );

      const delegation = await parseDelegation(rawDelegation);

      // Invocation TTL = min(1 hour, delegation expiration), whichever comes first
      const nowSeconds = Math.floor(Date.now() / 1000);
      const delegationExp =
        typeof delegation.expiration === 'number' &&
        isFinite(delegation.expiration)
          ? delegation.expiration
          : null;
      const maxExp = nowSeconds + MAX_INVOCATION_TTL_SECONDS;
      const expirationSeconds = delegationExp
        ? Math.min(maxExp, delegationExp)
        : maxExp;

      const invocation = await createInvocation({
        issuer: signer,
        audience: serviceDid as `did:${string}:${string}`,
        capability: { can: '*', with: resource as `${string}:${string}` },
        proofs: [delegation],
        expiration: expirationSeconds,
      });

      const serialized = await serializeInvocation(invocation);

      // Cache the invocation for its full lifetime
      const ttlMs = (expirationSeconds - nowSeconds) * 1000;
      if (ttlMs > 0) {
        await this.cacheManager.set(
          cacheKey,
          { invocation: serialized, expiresAt: expirationSeconds },
          ttlMs,
        );
        this.logger.debug(
          `[UCAN] Cached invocation for ${userDid} → ${serviceDid} (TTL: ${expirationSeconds - nowSeconds}s)`,
        );
      }

      this.logger.debug(
        `[UCAN] Created invocation: iss=${this.oracleDid} aud=${serviceDid} user=${userDid}`,
      );
      return serialized;
    } catch (error) {
      this.logger.warn(
        `[UCAN] Failed to create service invocation: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ============================================================================
  // MCP tool validation (existing)
  // ============================================================================

  requiresAuth(serverName: string, toolName?: string): boolean {
    return requiresUCANAuth(this.config, serverName, toolName);
  }

  async validateMCPInvocation(
    serverName: string,
    toolName: string,
    invocationData: Uint8Array | string,
  ): Promise<MCPValidationResult> {
    try {
      const invocationBytes =
        typeof invocationData === 'string'
          ? Buffer.from(invocationData, 'base64')
          : invocationData;

      if (invocationBytes.length === 0) {
        return { valid: false, error: 'Empty invocation data' };
      }

      const crypto = await import('node:crypto');
      const hash = crypto
        .createHash('sha256')
        .update(invocationBytes)
        .digest('hex');
      const pseudoCid = `bafy${hash.slice(0, 52)}`;

      if (await this.invocationStore.has(pseudoCid)) {
        return {
          valid: false,
          error: 'Invocation has already been used (replay attack prevented)',
        };
      }

      const requiredCapability = buildRequiredCapability(
        this.config,
        serverName,
        toolName,
      );

      this.logger.log(
        `UCAN validation for ${serverName}/${toolName} - Required capability: ${requiredCapability.can} on ${requiredCapability.with}`,
      );

      this.logger.warn(
        `UCAN validation is in placeholder mode. Full ucanto validation will be enabled once @ixo/ucan is built.`,
      );

      await this.invocationStore.add(pseudoCid);

      return { valid: true, invokerDid: 'placeholder:invoker' };
    } catch (error) {
      this.logger.error(
        `UCAN validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        valid: false,
        error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  getRequiredCapabilityURI(serverName: string, toolName: string): string {
    return createMCPResourceURI(this.config.oracleDid, serverName, toolName);
  }

  getOracleDid(): string {
    return this.config.oracleDid;
  }

  getRootIssuers(): string[] {
    return this.config.rootIssuers;
  }
}
