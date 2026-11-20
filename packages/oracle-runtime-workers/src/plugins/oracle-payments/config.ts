import { z } from 'zod';

export type Network = 'devnet' | 'testnet' | 'mainnet';

/** Plugin-owned env. Every URL defaults per `NETWORK`; set one only to override. */
export const oraclePaymentsConfigSchema = z.object({
  ORACLE_PAYMENTS_DISABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /**
   * The oracle's service catalog: `{ name, description?, services: [{ id,
   * name, description?, priceUsd, doneMeans?, deliveryTime? }] }` — the same
   * service shape as the buyer's `agent-services/v1` agreement.
   */
  AGENT_CARD_JSON: z.string().optional(),
  /** Cosmos REST (LCD) for authz grant reads. */
  CHAIN_REST_URL: z.url().optional(),
  /** decision-engine, where the buyer's agreement lives. */
  DECISION_ENGINE_URL: z.url().optional(),
  /** Claim bot fallback when a collection's entity names no homeserver. */
  CLAIM_BOT_URL: z.url().optional(),
  /** Escrow/payment denom. `upay` is micro-USD: 1 USD = 1 000 000 upay. */
  ORACLE_PAYMENTS_DENOM: z.string().default('upay'),
  ORACLE_PAYMENTS_MAX_DELIVERABLE_MB: z.coerce.number().positive().default(25),
});

const REST_URLS: Record<Network, string> = {
  devnet: 'https://devnet.ixo.earth/rest',
  testnet: 'https://testnet.ixo.earth/rest',
  mainnet: 'https://impacthub.ixo.world/rest',
};

const DECISION_ENGINE_URLS: Record<Network, string> = {
  devnet: 'https://decision-engine.devnet.ixo.earth',
  testnet: 'https://decision-engine.testnet.ixo.earth',
  mainnet: 'https://decision-engine.ixo.earth',
};

const HOMESERVERS: Record<Network, string> = {
  devnet: 'devmx.ixo.earth',
  testnet: 'testmx.ixo.earth',
  mainnet: 'mx.ixo.earth',
};

const BLOCKSYNC_URLS: Record<Network, string> = {
  devnet: 'https://devnet-blocksync-graphql.ixo.earth/graphql',
  testnet: 'https://testnet-blocksync-graphql.ixo.earth/graphql',
  mainnet: 'https://blocksync-graphql.ixo.earth/graphql',
};

export const MICRO_USD_PER_USD = 1_000_000;

/** Everything the lanes need, resolved once from the merged config. */
export interface ResolvedPaymentsEnv {
  network: Network;
  restUrl: string;
  blocksyncUrl: string;
  decisionEngineUrl: string;
  /** `claim.bot.<host>` for a homeserver URL (or the network default). */
  claimBotFor(homeServer: string | null): string;
  denom: string;
  maxDeliverableBytes: number;
}

function str(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function networkOf(config: Record<string, unknown>): Network {
  const n = str(config, 'NETWORK');
  return n === 'mainnet' || n === 'testnet' ? n : 'devnet';
}

/**
 * Read the plugin's keys from `ctx.config` — the runtime's ALREADY validated
 * merged config (this schema's transforms and defaults applied), so it is read,
 * never parsed again.
 */
export function resolvePaymentsEnv(
  config: Record<string, unknown>,
): ResolvedPaymentsEnv {
  const network = networkOf(config);
  const fallbackBot =
    str(config, 'CLAIM_BOT_URL') ?? `https://claim.bot.${HOMESERVERS[network]}`;
  const maxMb = config.ORACLE_PAYMENTS_MAX_DELIVERABLE_MB;
  return {
    network,
    restUrl: (str(config, 'CHAIN_REST_URL') ?? REST_URLS[network]).replace(
      /\/$/,
      '',
    ),
    blocksyncUrl:
      str(config, 'BLOCKSYNC_GRAPHQL_URL') ?? BLOCKSYNC_URLS[network],
    decisionEngineUrl: (
      str(config, 'DECISION_ENGINE_URL') ?? DECISION_ENGINE_URLS[network]
    ).replace(/\/$/, ''),
    claimBotFor: (homeServer) => {
      if (!homeServer) return fallbackBot;
      try {
        return `https://claim.bot.${new URL(homeServer).host}`;
      } catch {
        return fallbackBot;
      }
    },
    denom: str(config, 'ORACLE_PAYMENTS_DENOM') ?? 'upay',
    maxDeliverableBytes:
      (typeof maxMb === 'number' && maxMb > 0 ? maxMb : 25) * 1024 * 1024,
  };
}
