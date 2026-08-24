/** VFS + UCAN Store worker URLs per IXO network, derived from `NETWORK`. */
export type IxoNetwork = 'mainnet' | 'testnet' | 'devnet';

export interface VfsWorkerUrls {
  vfs: string;
  store: string;
}

export const NETWORK_URLS: Record<IxoNetwork, VfsWorkerUrls> = {
  mainnet: {
    vfs: 'https://vfs.ixo.earth',
    store: 'https://store.ucan.ixo.earth',
  },
  testnet: {
    vfs: 'https://testnet.vfs.ixo.earth',
    store: 'https://testnet.store.ucan.ixo.earth',
  },
  devnet: {
    vfs: 'https://devnet.vfs.ixo.earth',
    store: 'https://devnet.store.ucan.ixo.earth',
  },
};

/** Worker URLs for a `NETWORK` value; anything unrecognised means devnet. */
export function resolveVfsWorkerUrls(
  network: string | undefined,
): VfsWorkerUrls {
  if (network === 'mainnet' || network === 'testnet') {
    return NETWORK_URLS[network];
  }
  return NETWORK_URLS.devnet;
}
