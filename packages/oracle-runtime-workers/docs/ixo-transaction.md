# IXO transaction plugin

`IxoTransactionPlugin` lets an oracle turn a conversation into a validated IXO
chain transaction and ask the user's Portal wallet to sign it. The oracle never
signs, broadcasts or holds a key: it validates the transaction, the Portal shows
it to the user, and the user's wallet signs and broadcasts it.

The design and the port from the Node-era pull requests are in
[`specs/ixo-transaction-signing-plugin.md`](../../../specs/ixo-transaction-signing-plugin.md).
The catalog, intent routing and validation live in the runtime-neutral
`@ixo/ixo-transaction` package; the plugin in `src/plugins/ixo-transaction/`
wires them to the Workers plugin API and the realtime channel.

## Enabling it

The plugin ships with the runtime but is not in `BUNDLED_WORKERS_PLUGINS`. Add
it to the oracle's plugins:

```ts
import {
  BUNDLED_WORKERS_PLUGINS,
  createOracleWorker,
  IxoTransactionPlugin,
} from '@ixo/oracle-runtime-workers';

const oracle = createOracleWorker({
  config,
  plugins: [...BUNDLED_WORKERS_PLUGINS, new IxoTransactionPlugin()],
});
```

It is `on-demand`: its tools stay hidden until `load_capability` (or the
capability router) loads `ixo-transaction` in the thread. The Portal must also
mount the signing hook (below); without it every signing request ends
`unavailable`.

## Configuration

| Variable                           | Default     | Meaning                                                                                                                                                                             |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IXO_TRANSACTION_ALLOW_MAINNET`    | `'false'`   | `'true'` lets mainnet drafts through, each only with the receipt of the same message signed on testnet (see [Mainnet](#mainnet)). Off: mainnet drafts are refused, nothing is sent. |
| `IXO_TRANSACTION_CHAIN_ID_DEVNET`  | `devnet-1`  | The chain id a devnet request names.                                                                                                                                                |
| `IXO_TRANSACTION_CHAIN_ID_TESTNET` | `pandora-8` | The chain id a testnet request names.                                                                                                                                               |
| `IXO_TRANSACTION_CHAIN_ID_MAINNET` | `ixo-5`     | The chain id a mainnet request names.                                                                                                                                               |
| `IXO_TRANSACTION_SIGN_TIMEOUT_MS`  | `120000`    | How long `sign_ixo_transaction` waits for the wallet. At most `300000`. A value outside the range fails the boot.                                                                   |

The chain id defaults are what each network's RPC reported in
`/status` (`node_info.network`) on 2026-10-05: `devnet.ixo.earth` →
`devnet-1`, `testnet.ixo.earth` → `pandora-8`, `impacthub.ixo.world` →
`ixo-5`. The runtime's own `NETWORK` variable names a network but carries no
chain id, so the plugin keeps its own map; override an entry when a chain
upgrade changes the id. One variable per network (rather than one chain id
for the oracle) because one oracle prepares both the testnet run and the
mainnet run of the same transaction.

There is no key, mnemonic or endpoint to configure: the plugin makes no network
request of its own.

## Tools

| Tool                              | Effect | Returns                                                                                                                                                                        |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_ixo_transaction_routes`     | read   | The routes (`/ixo {message-type} {message-action}`), their fields, risk level and risks; deferred modules.                                                                     |
| `classify_ixo_transaction_intent` | read   | `{ status: 'resolved', intent }` or `{ status: 'unresolved', error }`.                                                                                                         |
| `validate_ixo_transaction_draft`  | read   | `{ status: 'valid', message, risks, riskLevel, requiresConfirmation, network, chainId, intent }` or `{ status: 'invalid', error }` (mainnet drafts get the receipt check too). |
| `sign_ixo_transaction`            | write  | One of the statuses below.                                                                                                                                                     |

A draft names its route by `command` (`/ixo token retire`), `messageType` +
`action`, `typeUrl`, or free text in `input`, and carries the Msg fields in
`value` as proto-JSON: camelCase field names, integer amounts as strings, bytes
as padded base64, timestamps as RFC 3339 strings, durations as
`{ seconds, nanos }`. Every nested message (payments, CW20/CW1155 payments,
mint batches, adjudicators, dispute data, durations) has a strict schema whose
field names the package tests check against the SDK codec. An entity-account
grant's `authorization` is structured JSON of an allowlisted type —
`/cosmos.authz.v1beta1.GenericAuthorization` (`{ msg }`) or
`/cosmos.bank.v1beta1.SendAuthorization` (`{ spendLimit, allowList? }`) — never
an opaque encoded `Any`; the Portal encodes it. `network` defaults to
`testnet`.

Risk acceptance is checked word for word: `riskConfirmation.acceptedRisks` must
contain every string in the route's `risks` (as `list_ixo_transaction_routes`
and `validate_ixo_transaction_draft` return them). `confirmed: true` alone, or a
paraphrase, is refused.

### Signing outcomes

| Status             | When                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signed`           | The wallet signed and the transaction succeeded; carries `chainId`, `transactionHash`, `code`, `height` when it gave them, and on testnet a `testnetReceipt`. |
| `failed`           | Included in a block but failed (non-zero code); carries the real `transactionHash`, `code`, `height` and the chain's log in `error`.                          |
| `rejected`         | The call failed without a code or hash and the Portal's error says the user rejected, denied, declined or cancelled.                                          |
| `error`            | Any other failure without a delivery: a chain mismatch or a refused message in the Portal, a wallet error.                                                    |
| `timeout`          | No answer within the timeout. `outcome: 'unknown'`: the user may still sign.                                                                                  |
| `validation_error` | The draft failed validation, the risk gate or the mainnet gate. Nothing was sent.                                                                             |
| `unavailable`      | No Portal session, no browser connected to it, or the Portal has no signing handler.                                                                          |

`sign_ixo_transaction` is a write. A `timeout` result says the request "timed
out", which the tool-execution middleware treats as an unknown outcome: the
claim stays in the run ledger, and an identical signing request in a later turn
is answered with "outcome unknown, verify first" instead of reaching the wallet
again. Within one turn the repetition guard already stops an identical second
call. A result from a socket of another session never settles the call (see
`FrontendCallRegistry`).

`rejected` is only ever read from the Portal's error text when the call failed
without a code or hash: a delivered-but-failed transaction comes back as a
successful call (`failed`), so a chain log that happens to say "cancel" never
reads as the user declining.

Each settled outcome is logged to the turn's room as an `ixo.action.log` event,
as AG-UI actions are.

### Mainnet

A mainnet draft is dispatched only when `IXO_TRANSACTION_ALLOW_MAINNET=true`
and it cites the receipt of the same message signed on testnet by the same
user:

1. The testnet run returns `signed` with
   `testnetReceipt: { transactionHash, receiptId, expiresInHours: 24 }`. The
   plugin recorded it in the user's blob store (`ctx.blobStore`, the user
   object's Durable Object storage, scoped to the user's DID) under the name
   `ixo-transaction/receipt:<hash>`, with the SHA-256 of the message's
   canonical form and the testnet chain id.
2. The mainnet draft passes `testnetReceipt: { transactionHash, receiptId }`.
   Before dispatching (and in `validate_ixo_transaction_draft`), the plugin
   reads that entry for this user and requires the same hash, the testnet
   chain id, and the same message digest. A receipt the model made up, another
   user's, another plugin's blob, another hash or a different message is
   refused; so is everything when the store cannot be read.

There is no override. The blob store keeps an entry at most 24 hours (its own
limit; the plugin API has no longer-lived per-user store), so the mainnet run
must follow the testnet run within a day.

## The Portal handler contract

The Portal mounts one hook inside `OraclesProvider`, giving it the chain id its
wallet is connected to:

```tsx
import { useIxoTransactionSigningAction } from '@ixo/ixo-transaction/react';

function OracleChat({ walletChainId }: { walletChainId: string }) {
  // The chain the Portal's wallet is configured for — from the Portal's own
  // chain/wallet configuration, never a literal copied from here.
  useIxoTransactionSigningAction({ chainId: walletChainId });
  return <Chat />;
}
```

`OraclesProvider`'s wallet props (`address`, `did`, `matrix`) carry no chain
id, and the SDK cannot find it out, so the Portal must pass the id from its own
wallet configuration. Every request names its target `chainId`; the handler
refuses any other before the wallet is touched. Hard-coding a chain id here
defeats the check.

It registers the `sign_transaction` AG-UI action with `exposeToAgent: false`
(`@ixo/oracles-client-sdk` ≥ 1.5.0): the socket answers it, but it is not sent
with the turn's `agActions`, so the model cannot call it — only
`sign_ixo_transaction` reaches it.

On `action_call` with `toolName: 'sign_transaction'` the oracle sends:

```ts
{
  action: 'sign_transaction';
  network: 'devnet' | 'testnet' | 'mainnet';
  chainId: string; // e.g. 'pandora-8'
  messages: [{ typeUrl: string; value: Record<string, unknown> }]; // exactly one, proto-JSON
  memo?: string;
  intent: { source; module; action; messageName; typeUrl; confidence; ambiguities };
  risks: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresConfirmation: boolean;
  riskConfirmation?: { confirmed: true; acceptedRisks: string[] };
  testnetReceipt?: { transactionHash: string; receiptId: string }; // mainnet only
}
```

The handler:

1. validates the args (exactly one message), and the message itself against
   the catalog: a known typeUrl, exactly its fields, each of its kind, nested
   messages included — the same check the oracle ran, so a tampered or
   mis-built message never reaches the wallet;
2. refuses a `chainId` other than the one it was given;
3. decodes the message with the IXO SDK's generated `fromJSON` (bytes, `Long`,
   `Timestamp`), encoding an allowlisted authorization into the grant's `Any`
   with the SDK codec;
4. calls `transactSignX(messages, memo)` and answers `action_call_result`.

Results:

| Wallet outcome                          | `action_call_result.result`                                              |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Included, code 0                        | `{ success: true, transactionHash, code, height }`                       |
| Included, non-zero code                 | `{ success: true, delivered: { code, transactionHash, height }, error }` |
| Wallet threw, refused, returned nothing | `{ success: false, error }`                                              |

An included-but-failed transaction is a successful call on purpose: the
runtime's call registry turns `success: false` into a bare error string, which
would lose the hash and code. The handler never forwards the wallet's own
response object: a cosmjs `DeliverTxResponse` carries `bigint` fields that
socket.io cannot serialise. A Portal with its own handler must keep to the
same result shape.

## Risks to disclose

From the plugin's risk policy (each catalog entry lists its own risks; the
model must quote the ones the user accepts in `riskConfirmation`):

| Category            | Examples                                       | Confirm                                                                     |
| ------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| Entity creation     | `/ixo entity create`                           | The entity DID is chain-derived; relayer node and owner fields are correct. |
| Ownership transfer  | `/ixo entity transfer`                         | Ownership and control change, possibly irreversibly.                        |
| Entity verification | `/ixo entity update-verified`                  | Only the relayer node should verify or unverify.                            |
| DID control         | IID controllers and verification methods       | Wrong controllers or keys lock users out or grant control.                  |
| Authz grants        | Entity-account grants, claim authorizations    | Grantee, expiration, message scope and limits are intended.                 |
| Claims              | Submit, evaluate, dispute, collection payments | Status and payment effects trigger external workflows.                      |
| Tokens and credits  | Mint, transfer, retire, cancel, pause, stop    | Credits move or burn permanently; amounts are integer micro-units.          |
| Mainnet             | Any mainnet signing                            | The same message was signed on testnet first (the receipt is checked).      |

Failure modes worth telling the user about before they sign: the wrong signer
address or DID; a missing relayer node, entity, collection or grant; decimal
amounts instead of integer chain units; timestamps outside the intended window;
a partial entity or IID update that resets omitted fields; and a transaction
that succeeds on testnet but fails on mainnet because its references differ by
network.

## Routing

Slash commands are case-insensitive, `_` and `-` are interchangeable, and these
aliases resolve: `domain` → `entity`, `did` → `iid`, `claim` → `claims`,
`credit`/`credits` → `token`, `smartaccount`/`authenticator` →
`smart-account`; `MsgCreateEntity`, `msgCreateEntity`, `createEntity` and the
typo `megCreateEntity` → `/ixo entity create`. Natural language covers the
common requests ("create a new domain", "retire credits", "submit a claim",
"add a linked resource"). A request for `bonds`, `liquidstake` or `names`
(deferred) or `epochs` / `mint` (query-only) is refused with the reason, by
slash command or by typeUrl (`/ixo.bonds.v1beta1.MsgBuy`). Every
natural-language rule is tried: a request two routes fit ("transfer my credits
to the domain account") is refused with both candidates rather than given to
the first rule.

## Limits

- Coverage is entity, iid, claims (minus the dispute-deposit, adjudication,
  membership and withdrawal messages new in `@ixo/impactxclient-sdk@3.0.0`),
  token and smart-account. The catalog is checked against SDK 3.0.0 by the
  package tests; bump them together.
- `rejected` is recognised from the wallet's error text: SignX gives no
  structured reason, and its wording has not been checked against a real
  SignX session.
- A wallet whose broadcast succeeded but whose wait for inclusion timed out
  (cosmjs words it "was submitted but was not yet found on the chain") throws,
  so it reaches the oracle as `error`, which reads as a definite failure,
  although the transaction may still be included. The exact wording the
  Portal's wallet produces in that case has not been verified; it is not
  treated as an unknown outcome.
- Mainnet runs need a testnet run of the same message within 24 hours (the
  blob store's limit).
- The entity-account authorization allowlist is the generic and bank-send
  authorizations; claims authorizations (submit, evaluate, withdraw) are not
  in it yet.
- The plugin cannot tell whether a timed-out request was signed later; the
  user has to check (it has no chain-read tool).
