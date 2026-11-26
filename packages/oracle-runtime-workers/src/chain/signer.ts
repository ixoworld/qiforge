import type {
  DirectSecp256k1HdWallet,
  EncodeObject,
} from '@cosmjs/proto-signing';
import { getIxoSdk } from './ixo-sdk';

/**
 * The oracle's secp256k1 chain signer on Workers.
 *
 * Only the wallet (pure crypto derived from the mnemonic) is memoised per
 * isolate. The signing client and the `SequenceManagerDO` stub are built
 * fresh for every call: Cloudflare forbids reusing I/O objects across
 * requests, and a cached client fails only under load.
 *
 * Account sequences come from `SequenceManagerDO` (one instance per signer
 * address), so concurrent user objects signing as the same oracle never
 * collide on a sequence number.
 */

/** The one surface of a `SequenceManagerDO` stub the signer touches. */
export interface SequenceStub {
  fetch(request: Request): Promise<Response>;
}

/** Resolves the sequence keeper for a signer address. */
export type SequenceStubFor = (address: string) => SequenceStub;

export interface ChainSignerOptions {
  mnemonic: string;
  rpcUrl: string;
  sequenceFor: SequenceStubFor;
}

export interface BroadcastResult {
  code: number;
  transactionHash: string;
  rawLog?: string;
  gasUsed: bigint;
}

export interface ChainSigner {
  address: string;
  signAndBroadcast(
    messages: readonly EncodeObject[],
    memo: string,
  ): Promise<BroadcastResult>;
}

let walletMemo: {
  mnemonic: string;
  wallet: Promise<{ address: string; wallet: DirectSecp256k1HdWallet }>;
} | null = null;

function walletFor(
  mnemonic: string,
): Promise<{ address: string; wallet: DirectSecp256k1HdWallet }> {
  if (walletMemo?.mnemonic !== mnemonic) {
    const wallet = (async () => {
      const { DirectSecp256k1HdWallet } = await import('@cosmjs/proto-signing');
      const hd = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
        prefix: 'ixo',
      });
      const [account] = await hd.getAccounts();
      if (!account) throw new Error('The secp mnemonic yields no account');
      return { address: account.address, wallet: hd };
    })();
    wallet.catch(() => {
      if (walletMemo?.wallet === wallet) walletMemo = null;
    });
    walletMemo = { mnemonic, wallet };
  }
  return walletMemo.wallet;
}

/** The address the mnemonic signs as, without building a client. */
export async function signerAddress(mnemonic: string): Promise<string> {
  return (await walletFor(mnemonic)).address;
}

export function isSequenceMismatch(cause: unknown): boolean {
  const text = String(cause).toLowerCase();
  return (
    text.includes('account sequence mismatch') ||
    text.includes('incorrect account sequence')
  );
}

/** One ImpactHub block — how long a "behind" mismatch waits for its own tx. */
const BLOCK_TIME_MS = 6_000;

/**
 * Broadcast with the poisoned-counter heal. The DO allocates on request with
 * no failure feedback, so a tx that dies before inclusion burns its number
 * and every later send reads "expected N, got N+k" ("ahead"): clear the
 * counter so the next send re-reads the chain. "Behind" (we signed off a
 * committed read while our own previous tx was still in the mempool) needs
 * the opposite: wait one block, never reset. The heal never masks the error.
 */
export async function broadcastWithSequenceHeal<
  T extends { code: number; rawLog?: string },
>(stub: SequenceStub, broadcast: () => Promise<T>): Promise<T> {
  const heal = (cause: unknown): Promise<void> => {
    const m = String(cause).match(/expected (\d+), got (\d+)/);
    const behind = m !== null && Number(m[2]) < Number(m[1]);
    return behind
      ? new Promise((resolve) => setTimeout(resolve, BLOCK_TIME_MS))
      : stub.fetch(new Request('http://do/reset', { method: 'POST' })).then(
          () => undefined,
          () => undefined,
        );
  };
  try {
    const res = await broadcast();
    if (res.code !== 0 && isSequenceMismatch(res.rawLog))
      await heal(res.rawLog);
    return res;
  } catch (err) {
    if (isSequenceMismatch(err)) await heal(err);
    throw err;
  }
}

export async function createChainSigner(
  opts: ChainSignerOptions,
): Promise<ChainSigner> {
  const { address, wallet } = await walletFor(opts.mnemonic);
  return {
    address,
    async signAndBroadcast(messages, memo) {
      const [sdk, { GasPrice }] = await Promise.all([
        getIxoSdk(),
        import('@cosmjs/stargate'),
      ]);
      const stub = opts.sequenceFor(address);
      const client = await sdk.createSigningClient(
        opts.rpcUrl,
        wallet,
        false,
        { gasPrice: GasPrice.fromString('0.025uixo') },
        sdk.createDOStoreFunctions(stub),
      );
      const res = await broadcastWithSequenceHeal(stub, () =>
        client.signAndBroadcast(address, messages, 'auto', memo),
      );
      return {
        code: res.code,
        transactionHash: res.transactionHash,
        gasUsed: res.gasUsed,
        ...(res.rawLog !== undefined && { rawLog: res.rawLog }),
      };
    },
  };
}
