/**
 * The chain id each network's signing requests name, as plugin config. Every
 * plugin that asks the Portal wallet to sign (`IxoTransactionPlugin`, the POD
 * creator) declares this same schema object, so one set of variables
 * configures them all and the env composition does not report the shared
 * keys as a collision.
 */
import {
  ChainIdSchema,
  DEFAULT_CHAIN_IDS,
  type Network,
} from '@ixo/ixo-transaction';
import { z } from 'zod';

/**
 * The defaults are what each network's RPC reports (`DEFAULT_CHAIN_IDS`);
 * override an entry after a chain upgrade changes the id. The Portal refuses
 * a request for another chain than its wallet's.
 */
export const chainIdConfigSchema = z.object({
  IXO_TRANSACTION_CHAIN_ID_DEVNET: ChainIdSchema.default(
    DEFAULT_CHAIN_IDS.devnet,
  ),
  IXO_TRANSACTION_CHAIN_ID_TESTNET: ChainIdSchema.default(
    DEFAULT_CHAIN_IDS.testnet,
  ),
  IXO_TRANSACTION_CHAIN_ID_MAINNET: ChainIdSchema.default(
    DEFAULT_CHAIN_IDS.mainnet,
  ),
});

export type ChainIdConfig = z.output<typeof chainIdConfigSchema>;

/** The chain id per network, from the parsed config. */
export function chainIdsFromConfig(
  config: ChainIdConfig,
): Readonly<Record<Network, string>> {
  return {
    devnet: config.IXO_TRANSACTION_CHAIN_ID_DEVNET,
    testnet: config.IXO_TRANSACTION_CHAIN_ID_TESTNET,
    mainnet: config.IXO_TRANSACTION_CHAIN_ID_MAINNET,
  };
}
