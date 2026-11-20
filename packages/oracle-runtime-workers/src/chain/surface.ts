import type { ChainSigningSurface } from '../plugin-api/types';
import {
  createChainSigner,
  signerAddress,
  type SequenceStubFor,
} from './signer';

const DEFAULT_RPC_URLS = {
  devnet: 'https://devnet.ixo.earth/rpc/',
  testnet: 'https://testnet.ixo.earth/rpc/',
  mainnet: 'https://impacthub.ixo.world/rpc/',
} as const;

export function defaultRpcUrl(network: keyof typeof DEFAULT_RPC_URLS): string {
  return DEFAULT_RPC_URLS[network];
}

/**
 * `ctx.chain` over the oracle's secp mnemonic. The signer (client + DO stub)
 * is built per broadcast — see `createChainSigner`.
 */
export function createChainSurface(opts: {
  mnemonic: string;
  rpcUrl: string;
  sequenceFor: SequenceStubFor;
}): ChainSigningSurface {
  return {
    address: () => signerAddress(opts.mnemonic),
    signAndBroadcast: async (messages, memo) =>
      (await createChainSigner(opts)).signAndBroadcast(messages, memo),
  };
}
