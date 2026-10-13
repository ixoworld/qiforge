# @ixo/ixo-transaction

The runtime-neutral half of QiForge's IXO wallet-signing plugin: the IXO message
catalog (checked against `@ixo/impactxclient-sdk@3.0.0`), intent routing, strict
validation with the risk and mainnet gates, and the `sign_transaction` action
contract. The oracle side is `IxoTransactionPlugin` in
`@ixo/oracle-runtime-workers`; the Portal side is the hook below.

The root export depends on `zod` only and can neither sign nor broadcast.

## Entry points

`@ixo/ixo-transaction`:

- **Catalog** — `MESSAGE_CATALOG` (the entity, iid, claims, token and
  smart-account modules), `QUERY_ONLY_MODULES`, `DEFERRED_MODULES`,
  `findMessageByRoute`, `findMessageByTypeUrl`, `routeForMessageName`.
- **Intent routing** — `parseSlashCommand`, `classifyIntent`, `resolveIntent`.
- **Validation** — `validateMessage`, `validateTransactionDraft`,
  `describeValidationError`, and the strict Zod schemas for every message
  field (`TransactionDraftSchema`, `ITrxMsgSchema`, …).
- **The `sign_transaction` action contract** — `SIGN_TRANSACTION_ACTION_NAME`,
  `SignTransactionActionArgsSchema`, `SignTransactionActionResultSchema`,
  `buildSignTransactionActionArgs`, `normalizeWalletSignResult`,
  `signIxoTransactionWithWallet`, `ChainIdSchema`, `DEFAULT_CHAIN_IDS`.
- **Batches** — `TransactionBatchSchema`, `validateTransactionBatch`,
  `buildBatchSignTransactionActionArgs`, `BatchIntentSchema`,
  `MAX_BATCH_MESSAGES` (16): several catalogued messages signed in one wallet
  transaction (the POD Creator's create path). The args carry
  `intent.source: 'batch'`; risks are every message's, the level the
  highest. Conversational drafts stay one message.

`@ixo/ixo-transaction/react`: `useIxoTransactionSigningAction({ chainId })`,
plus `createSignTransactionHandler` and the proto-JSON helpers
(`toEncodeObject`, `encodeAuthorization`, `resolveProtoCodec`) it is built
from.

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

The hook registers the `sign_transaction` AG-UI action with
`exposeToAgent: false`, so the model never sees the raw wallet action and
reaches the wallet only through the validating plugin tools — the
ixo-transaction plugin's `sign_ixo_transaction` (one message) and the POD
Creator's `request_pod_signature` (a batch). The handler re-validates every
message against the catalog, refuses a request for another chain than
`chainId`, decodes the proto-JSON with the SDK's `fromJSON` and signs all the
messages in one `transactSignX` call.

## Tests

```bash
pnpm --filter @ixo/ixo-transaction test
```

Configuration, the tools, the signing outcomes and the full handler contract:
[`packages/oracle-runtime-workers/docs/ixo-transaction.md`](../oracle-runtime-workers/docs/ixo-transaction.md).
