import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types.js';

/**
 * The default network for every pod-creator surface (capsule fetches and the
 * create path alike) when `NETWORK` is unset — the safe one.
 */
export const DEFAULT_NETWORK = 'testnet';

/**
 * Plugin-owned env vars. The capsules registry URL and `NETWORK` are read as
 * siblings from the merged config (owned by the skills plugin / base schema),
 * so they are intentionally NOT redeclared here — that would collide in the
 * config-schema registry when both plugins are loaded.
 */
export const podCreatorConfigSchema = z.object({
  /**
   * Must be explicitly enabled before a mainnet creation batch can be
   * prepared. Testnet / devnet require no opt-in. Accepts a real boolean
   * (tests / programmatic config) or the string `'true'` / `'false'` (env).
   */
  POD_CREATOR_ALLOW_MAINNET: z
    .union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ])
    .default(false),
});

/** Sibling env + plugin flags the tools read at request time. */
const configReadSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
  POD_CREATOR_ALLOW_MAINNET:
    podCreatorConfigSchema.shape.POD_CREATOR_ALLOW_MAINNET.optional(),
});

export interface PodCreatorConfig {
  network: string;
  mainnetAllowed: boolean;
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
    return { network: DEFAULT_NETWORK, mainnetAllowed: false };
  }
  return {
    network: parsed.data.NETWORK ?? DEFAULT_NETWORK,
    mainnetAllowed: parsed.data.POD_CREATOR_ALLOW_MAINNET ?? false,
  };
}
