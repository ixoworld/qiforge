import {
  DEFAULT_CHAIN_IDS,
  NetworkSchema,
  type Network,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';
import { DOMAIN_INDEXER_URLS } from '../domain-indexer/domain-indexer.plugin';
import {
  chainIdConfigSchema,
  chainIdsFromConfig,
} from '../ixo-transaction/chain-ids';

/**
 * The network every pod-creator surface falls back to when the merged config
 * carries no readable `NETWORK` — the safe one. On a Workers oracle the base
 * env schema always fills `NETWORK` (default `mainnet`), so in practice the
 * mainnet opt-in below is what keeps an unconfigured oracle off mainnet.
 */
export const DEFAULT_NETWORK: Network = 'testnet';

/** An IXO entity DID as the chain derives it. */
const ENTITY_DID = /^did:ixo:entity:[0-9a-f]{32}$/;

/**
 * Plugin-owned env vars. The capsules registry URL and `NETWORK` are read as
 * siblings from the merged config (owned by the skills plugin / base schema),
 * so they are intentionally NOT redeclared here — two plugins declaring one
 * key with different schemas would collide in the config-schema registry.
 * The chain ids are the ixo-transaction plugin's own schema objects, which
 * both plugins declare (one set of variables for every wallet-signing
 * plugin; the composition treats the shared objects as one key).
 */
export const podCreatorConfigSchema = z.object({
  /**
   * Must be explicitly enabled before a mainnet creation batch can be
   * prepared. Testnet / devnet require no opt-in. Accepts a real boolean
   * (tests / programmatic config) or the string `'true'` / `'false'` (a
   * Worker var).
   */
  POD_CREATOR_ALLOW_MAINNET: z
    .union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ])
    .default(false),
  /** The chain id each network's signing request names. */
  ...chainIdConfigSchema.shape,
  /**
   * The relayer node a created POD names, instead of the network's default
   * ({@link POD_RELAYER_NODE_DIDS}).
   */
  POD_CREATOR_RELAYER_NODE_DID: z
    .string()
    .regex(ENTITY_DID, 'expected an entity DID: did:ixo:entity:<32 hex>')
    .optional(),
  /**
   * The Portal a created POD is linked to, instead of the network's default
   * ({@link PORTAL_URLS}).
   */
  POD_CREATOR_PORTAL_URL: z.url().optional(),
});

/**
 * The relayer node each network's Portal names on the domains (and PODs) it
 * creates: its `NEXT_PUBLIC_DAO_DID` (ixo-portal `lib/entity/createEntity.ts`),
 * as read from the Portal's recent "Create domain:" transactions. The
 * mainnet Portal lists only entities of this relayer that are verified.
 * Not the oracles' relayer (`lib/oracle/networkConfig.ts`), which only
 * oracle entities name.
 */
export const POD_RELAYER_NODE_DIDS: Readonly<Record<Network, string>> = {
  mainnet: 'did:ixo:entity:47d9c64891e77cb8e588d33b83ab3042',
  testnet: 'did:ixo:entity:3d079ebc0b332aad3305bb4a51c72edb',
  devnet: 'did:ixo:entity:ac12c6f8f299071eb24f2a10591d7ab7',
};

/** The Portal each network's PODs are opened in. */
export const PORTAL_URLS: Readonly<Record<Network, string>> = {
  mainnet: 'https://portal.qi.space',
  testnet: 'https://test.portal.qi.space',
  devnet: 'https://dev.portal.qi.space',
};

/** Sibling env + plugin flags the tools read at request time. */
const configReadSchema = z.object({
  NETWORK: NetworkSchema.optional(),
  POD_CREATOR_ALLOW_MAINNET:
    podCreatorConfigSchema.shape.POD_CREATOR_ALLOW_MAINNET.optional(),
  ...chainIdConfigSchema.shape,
  POD_CREATOR_PORTAL_URL: podCreatorConfigSchema.shape.POD_CREATOR_PORTAL_URL,
});

export interface PodCreatorConfig {
  network: Network;
  mainnetAllowed: boolean;
  /** The chain id each network's signing request names. */
  chainIds: Readonly<Record<Network, string>>;
  /** The Portal of `network`, without a trailing slash. */
  portalUrl: string;
}

const withoutSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * The Portal a `network` entity is opened in, as the POD Creator links it:
 * `POD_CREATOR_PORTAL_URL` when the merged config sets a valid one, else the
 * network's ({@link PORTAL_URLS}); without a trailing slash.
 */
export function portalUrlFor(
  network: Network,
  config: RuntimeContext['config'],
): string {
  const override =
    podCreatorConfigSchema.shape.POD_CREATOR_PORTAL_URL.safeParse(
      config.POD_CREATOR_PORTAL_URL,
    );
  return withoutSlash(
    (override.success ? override.data : undefined) ?? PORTAL_URLS[network],
  );
}

/**
 * Network routing + the mainnet opt-in, read from the merged config. Falls
 * back to testnet with mainnet disabled when the config is unreadable — and
 * says so, since a silent network fallback on the create path would mask
 * misconfiguration.
 */
export function readPodCreatorConfig(ctx: RuntimeContext): PodCreatorConfig {
  const parsed = configReadSchema.safeParse(ctx.config);
  if (!parsed.success) {
    ctx.logger.warn(
      '[pod-creator] config unreadable; defaulting to testnet with mainnet disabled',
    );
    return {
      network: DEFAULT_NETWORK,
      mainnetAllowed: false,
      chainIds: DEFAULT_CHAIN_IDS,
      portalUrl: PORTAL_URLS[DEFAULT_NETWORK],
    };
  }
  const network = parsed.data.NETWORK ?? DEFAULT_NETWORK;
  return {
    network,
    mainnetAllowed: parsed.data.POD_CREATOR_ALLOW_MAINNET ?? false,
    chainIds: chainIdsFromConfig(parsed.data),
    portalUrl: withoutSlash(
      parsed.data.POD_CREATOR_PORTAL_URL ?? PORTAL_URLS[network],
    ),
  };
}

const relayerReadSchema = z.object({
  POD_CREATOR_RELAYER_NODE_DID:
    podCreatorConfigSchema.shape.POD_CREATOR_RELAYER_NODE_DID,
});

/** The relayer node a POD created on `network` names: the operator's, else the network's Portal's. */
export function relayerNodeDidFor(
  ctx: RuntimeContext,
  network: Network,
): string {
  const parsed = relayerReadSchema.safeParse(ctx.config);
  return (
    (parsed.success ? parsed.data.POD_CREATOR_RELAYER_NODE_DID : undefined) ??
    POD_RELAYER_NODE_DIDS[network]
  );
}

/** `DOMAIN_INDEXER_URL` is the domain-indexer plugin's; read here as a sibling. */
const indexerReadSchema = z.object({ DOMAIN_INDEXER_URL: z.url().optional() });

/** The domain indexer of `network`, without a trailing slash. */
export function domainIndexerUrlFor(
  ctx: RuntimeContext,
  network: Network,
): string {
  const parsed = indexerReadSchema.safeParse(ctx.config);
  return withoutSlash(
    (parsed.success ? parsed.data.DOMAIN_INDEXER_URL : undefined) ??
      DOMAIN_INDEXER_URLS[network],
  );
}
