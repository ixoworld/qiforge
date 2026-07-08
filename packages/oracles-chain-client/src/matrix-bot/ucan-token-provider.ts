import {
  createInvocation,
  serializeInvocation,
  signerFromMnemonic,
  type Signer,
  type SupportedDID,
} from '@ixo/ucan';

function isSupportedDid(did: string): did is SupportedDID {
  return did.startsWith('did:ixo:') || did.startsWith('did:key:');
}

export type BotResource = `${string}:${string}`;

/**
 * Mints (and caches) a serialized UCAN invocation authorizing a call to the
 * given bot service. Matrix bots accept these as `Bearer` tokens since
 * @ixo/matrixclient-sdk v2.
 */
export type GetUcanToken = (
  botUrl: string,
  resource: BotResource,
) => Promise<string>;

/** Capability resources the matrix bots validate, keyed by the URL fields of
 * `getMatrixUrlsForDid`. Mirrors the portal's `utils/bot-auth.ts`. */
export const MATRIX_BOT_RESOURCES = {
  stateBot: 'ixo:matrix-state-bot',
  roomsBot: 'ixo:matrix-rooms-bot',
  claimBot: 'ixo:matrix-claims-bot',
} as const;

interface UcanTokenProviderConfig {
  /**
   * The oracle's derived claim-signing mnemonic (the output of
   * setupClaimSigningMnemonics — NOT the secp wallet mnemonic). The invocation
   * is signed with the ed25519 key derived as SHA256(mnemonic).slice(0,32),
   * which is the verification method registered on the oracle's DID; this is
   * how the bots verify the issuer. Same key apps/app's UcanService signs with.
   */
  mnemonic: string;
  /** The oracle's DID — used as the invocation issuer. */
  did: string;
  /** Invocation lifetime in seconds. Defaults to one hour. */
  ttlSeconds?: number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class UcanTokenProvider {
  private readonly mnemonic: string;
  private readonly did: string;
  private readonly ttlSeconds: number;

  private signer: Promise<Signer> | null = null;
  private readonly serviceDids = new Map<string, Promise<string>>();
  private readonly tokens = new Map<string, CachedToken>();
  private mutex: Promise<void> = Promise.resolve();

  constructor(config: UcanTokenProviderConfig) {
    this.mnemonic = config.mnemonic;
    this.did = config.did;
    this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousMutex = this.mutex;
    this.mutex = acquired;
    await previousMutex;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private getSigner(): Promise<Signer> {
    if (!this.signer) {
      if (!isSupportedDid(this.did)) {
        throw new Error(
          `Unsupported DID for UCAN signing: ${this.did} (expected did:ixo:* or did:key:*)`,
        );
      }
      this.signer = signerFromMnemonic(this.mnemonic, this.did).then(
        ({ signer }) => signer,
      );
    }
    return this.signer;
  }

  private resolveServiceDid(botUrl: string): Promise<string> {
    const cached = this.serviceDids.get(botUrl);
    if (cached) return cached;

    const resolution = (async () => {
      const response = await fetch(`${botUrl}/.well-known/did.json`);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch DID document from ${botUrl}: ${response.status}`,
        );
      }
      const doc = (await response.json()) as { id?: string };
      if (!doc.id) {
        throw new Error(`Invalid DID document from ${botUrl}: missing id`);
      }
      return doc.id;
    })();

    // Drop failed resolutions from the cache so the next call retries.
    resolution.catch(() => this.serviceDids.delete(botUrl));
    this.serviceDids.set(botUrl, resolution);
    return resolution;
  }

  async getToken(botUrl: string, resource: BotResource): Promise<string> {
    return this.withMutex(async () => {
      const cacheKey = `${botUrl}|${resource}`;
      const cached = this.tokens.get(cacheKey);
      if (cached && Date.now() < cached.expiresAtMs - EXPIRY_BUFFER_MS) {
        return cached.token;
      }

      const [signer, serviceDid] = await Promise.all([
        this.getSigner(),
        this.resolveServiceDid(botUrl),
      ]);

      const expiresAtMs = Date.now() + this.ttlSeconds * 1000;
      const invocation = await createInvocation({
        issuer: signer,
        audience: serviceDid,
        capability: { can: '*', with: resource },
        expiration: Math.floor(expiresAtMs / 1000),
      });
      const token = await serializeInvocation(invocation);

      this.tokens.set(cacheKey, { token, expiresAtMs });
      return token;
    });
  }
}

export function createUcanTokenProvider(
  config: UcanTokenProviderConfig,
): GetUcanToken {
  const provider = new UcanTokenProvider(config);
  return (botUrl, resource) => provider.getToken(botUrl, resource);
}
