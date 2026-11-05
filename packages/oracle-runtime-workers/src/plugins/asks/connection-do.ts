import { DurableObject } from 'cloudflare:workers';
import { AsksConnection, type AsksWorkerEnv, type Surface } from './connection';
import { asksMcpUrlOf } from './oauth';

/**
 * One per person, named HMAC(ASKS_TOKEN_KEY, user DID). Reached from the
 * user's own object (the tools) and from the shell (the sign-in routes), so
 * the tokens live here rather than in either of them. RPC methods only.
 */
export class AsksConnectionDO extends DurableObject<AsksWorkerEnv> {
  private readonly connection: AsksConnection;

  constructor(ctx: DurableObjectState, env: AsksWorkerEnv) {
    super(ctx, env);
    const { ORACLE_PUBLIC_URL, ASKS_TOKEN_KEY } = env;
    const mcpUrl = asksMcpUrlOf(env.NETWORK);
    if (!mcpUrl || !ORACLE_PUBLIC_URL || !ASKS_TOKEN_KEY) {
      throw new Error(
        'asks: NETWORK (mainnet, testnet or devnet), ORACLE_PUBLIC_URL and ASKS_TOKEN_KEY are required',
      );
    }
    this.connection = new AsksConnection({
      storage: ctx.storage,
      config: {
        mcpUrl,
        publicUrl: ORACLE_PUBLIC_URL,
        tokenKey: ASKS_TOKEN_KEY,
      },
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
    });
  }

  begin(did: string, surface: Surface) {
    return this.connection.begin(did, surface);
  }

  authorizeUrl(state: string) {
    return this.connection.authorizeUrl(state);
  }

  complete(state: string, code: string) {
    return this.connection.complete(state, code);
  }

  status() {
    return this.connection.status();
  }

  token() {
    return this.connection.token();
  }

  refused(access: string) {
    return this.connection.refused(access);
  }

  disconnect() {
    return this.connection.disconnect();
  }

  keepUpload(draft: string, address: string, expiresAt: number) {
    return this.connection.keepUpload(draft, address, expiresAt);
  }

  uploadOf(draft: string) {
    return this.connection.uploadOf(draft);
  }
}
