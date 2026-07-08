import {
  DirectSecp256k1HdWallet,
  type EncodeObject,
} from '@cosmjs/proto-signing';
import { createQueryClient, createSigningClient } from '@ixo/impactxclient-sdk';
import store from 'store';

import { GasPrice, type StdFee } from '@cosmjs/stargate';
import { type TxResponse } from '@ixo/impactxclient-sdk/codegen/cosmos/base/abci/v1beta1/abci';

export type SigningClientType = Awaited<ReturnType<typeof createSigningClient>>;
export type QueryClientType = Awaited<ReturnType<typeof createQueryClient>>;
const RPC_URL =
  typeof process !== 'undefined' ? process.env.RPC_URL : undefined;
const SECP_MNEMONIC =
  typeof process !== 'undefined' ? process.env.SECP_MNEMONIC : undefined;

export class Client {
  public queryClient!: QueryClientType;
  public signingClient!: SigningClientType;
  public wallet!: DirectSecp256k1HdWallet;
  public address!: string;
  private static instance: Client;

  private readonly secpMnemonic: string;
  private readonly rpcUrl: string;

  private constructor(secpMnemonic = SECP_MNEMONIC, rpcUrl = RPC_URL) {
    if (!secpMnemonic || !rpcUrl) {
      throw new Error('RPC_URL and SECP_MNEMONIC must be set');
    }

    this.secpMnemonic = secpMnemonic;
    this.rpcUrl = rpcUrl;
  }

  async checkInitiated(): Promise<void> {
    if (!this.signingClient || !this.wallet || !this.queryClient) {
      await this.init();
    }
  }

  async init(): Promise<void> {
    this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(
      this.secpMnemonic,
      {
        prefix: 'ixo',
      },
    );

    this.signingClient = await createSigningClient(
      this.rpcUrl,
      this.wallet,
      false,
      { gasPrice: GasPrice.fromString('0.025uixo') },
      {
        getLocalData: (k) => store.get(k),
        setLocalData: (k, d) => store.set(k, d),
      },
    );
    this.queryClient = await createQueryClient(this.rpcUrl);
    const accounts = await this.wallet.getAccounts();
    this.address = accounts[0]?.address ?? '';
  }

  public static getInstance(
    secpMnemonic = SECP_MNEMONIC,
    rpcUrl = RPC_URL,
  ): Client {
    if (!Client.instance) {
      Client.instance = new Client(secpMnemonic, rpcUrl);
    }
    return Client.instance;
  }

  public async runWithInitiatedClient<T>(
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    await this.checkInitiated();
    return fn(this);
  }

  async signAndBroadcast(msgs: readonly EncodeObject[], memo?: string) {
    await this.checkInitiated();
    const accounts = await this.wallet.getAccounts();
    const address = accounts[0]?.address;
    if (!address) {
      throw new Error('No address found in wallet');
    }
    const gasEstimation = await this.signingClient?.simulate(
      address,
      msgs,
      memo,
    );
    const fee = this.getFee(msgs.length, gasEstimation);
    return this.signingClient?.signAndBroadcast(address, msgs, fee, memo);
  }

  public async getTxByHash(hash: string): Promise<TxResponse | undefined> {
    await this.checkInitiated();
    const tx = await this.queryClient.cosmos.tx.v1beta1.getTx({ hash });
    return tx.txResponse;
  }

  getFee(trxLength = 1, simGas?: number): StdFee | 'auto' {
    if (simGas && simGas > 50000) return 'auto';

    const gasPrice = 0.025; // Or fetch from network dynamically
    const simOk = typeof simGas === 'number' && simGas > 0;

    return {
      amount: [
        {
          denom: 'uixo',
          amount: simOk
            ? (simGas * gasPrice).toFixed(0)
            : (trxLength * 5000).toString(), // Lower fallback
        },
      ],
      gas: simOk
        ? (simGas * 1.3).toFixed(0) // Buffer of 30%
        : (trxLength * 200000).toString(), // Lower fallback
    };
  }

  static async createCustomClient(
    secpMnemonic = SECP_MNEMONIC,
    rpcUrl = RPC_URL,
  ): Promise<Client> {
    const client = new Client(secpMnemonic, rpcUrl);
    await client.init();
    const accounts = await client.wallet.getAccounts();
    if (!accounts[0]?.address) {
      throw new Error('No address found in wallet');
    }
    client.address = accounts[0]?.address;
    return client;
  }
}

export const walletClient = Client.getInstance();
