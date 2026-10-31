/**
 * The IXO chain SDK, loaded lazily and narrowly for workerd.
 *
 * Two workerd constraints shape this module (both found in production by
 * decision-engine, `src/lib/ixo/chain.ts`):
 *
 *  - workerd's `Buffer.prototype.utf8Write` mis-encodes protobufjs strings of
 *    40+ chars that end a message (ixo addresses hit it), throwing
 *    `ERR_OUT_OF_RANGE`. The fix swaps `BufferWriter.prototype.string` for the
 *    pure-JS writer. It must be prototype-level — the SDK's codegen calls
 *    `_m0.configure()` at import, which resets statics — and it must run
 *    BEFORE the SDK loads, so every SDK import here is dynamic.
 *  - The barrel `@ixo/impactxclient-sdk` materialises every module; the
 *    narrow subpaths keep the bundle and cold start to what we sign.
 */

async function patchProtobufjsForWorkerd(): Promise<void> {
  const { Writer, BufferWriter } = await import('protobufjs/minimal.js');
  BufferWriter.prototype.string = Writer.prototype.string;
}

async function loadIxoSdk() {
  await patchProtobufjsForWorkerd();
  const [signing, cloudflare, claimsTx, authzTx] = await Promise.all([
    import('@ixo/impactxclient-sdk/module/stargate_client/customClient.js'),
    import('@ixo/impactxclient-sdk/cloudflare'),
    import('@ixo/impactxclient-sdk/module/codegen/ixo/claims/v1beta1/tx.js'),
    import('@ixo/impactxclient-sdk/module/codegen/cosmos/authz/v1beta1/tx.js'),
  ]);
  return {
    createSigningClient: signing.createSigningClient,
    createDOStoreFunctions: cloudflare.createDOStoreFunctions,
    MsgClaimIntent: claimsTx.MsgClaimIntent,
    MsgSubmitClaim: claimsTx.MsgSubmitClaim,
    MsgExec: authzTx.MsgExec,
  };
}

export type IxoSdk = Awaited<ReturnType<typeof loadIxoSdk>>;

let sdkPromise: Promise<IxoSdk> | null = null;

/** The SDK surface the claim lane signs with, loaded once per isolate. */
export function getIxoSdk(): Promise<IxoSdk> {
  if (!sdkPromise) {
    sdkPromise = loadIxoSdk();
    // A failed load is retried by the next caller, never memoised.
    sdkPromise.catch(() => {
      sdkPromise = null;
    });
  }
  return sdkPromise;
}
