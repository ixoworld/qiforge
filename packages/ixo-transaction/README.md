# @ixo/ixo-transaction

The runtime-neutral half of QiForge's IXO wallet-signing plugin: the IXO message
catalog (checked against `@ixo/impactxclient-sdk@3.0.0`), intent routing, strict
validation with the risk and mainnet gates, and the `sign_transaction` action
contract. The oracle side is `IxoTransactionPlugin` in
`@ixo/oracle-runtime-workers`; the Portal side is the hook below.

The root export depends on `zod` only and can neither sign nor broadcast.

## Portal

```tsx
import { useIxoTransactionSigningAction } from '@ixo/ixo-transaction/react';

function OracleChat({ walletChainId }: { walletChainId: string }) {
  // The chain id of the Portal's wallet, from the Portal's own wallet
  // configuration (OraclesProvider's wallet props carry none).
  useIxoTransactionSigningAction({ chainId: walletChainId });
  return <Chat />;
}
```

Mount it inside `OraclesProvider` (`@ixo/oracles-client-sdk` ≥ 1.5.0). It needs
`@ixo/impactxclient-sdk` 3.x and React as peers.

Configuration, the tools, the signing outcomes and the full handler contract:
[`packages/oracle-runtime-workers/docs/ixo-transaction.md`](../oracle-runtime-workers/docs/ixo-transaction.md).
