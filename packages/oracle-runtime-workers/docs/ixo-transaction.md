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

The plugin is in `BUNDLED_WORKERS_PLUGINS` (after `matrix-group-chats`,
before `pod-creator`), so every oracle that spreads the bundle has it, the
Companion included. A host that wants its own instance passes it after the
spread: the loader keeps one plugin per name, the last instance
(`resolvePlugins`).

It is `on-demand`: its tools stay hidden until `load_capability` (or the
capability router) loads `ixo-transaction` in the thread. The Portal must also
mount the signing hook (below); without it every signing request ends
`unavailable`.

Its tools exist on **Portal turns only** (`getRequestTools`, when
`ctx.session.client` is `portal`): the wallet is reached through the Portal
tab's AG-UI `sign_transaction` action, which a Matrix, Slack or channel turn
does not have. There the plugin contributes no tool, so it is not in the
capability catalogue and the capability router never preloads it; chain steps
in a channel chat stay with hub-actions (`request_chain_transaction`, Auth Hub
review cards), which in turn offers its tools on channel turns only. A
`load_capability('ixo-transaction')` named explicitly on such a turn loads
nothing (`tools: []`). A Portal turn without a connected tab still gets the
tools, and each signing tool answers `unavailable` without sending anything.

Enabling it everywhere is safe because nothing signs without the user:
mainnet stays refused unless `IXO_TRANSACTION_ALLOW_MAINNET=true`, every
signing call needs the user's risks quoted word for word, and the user signs
in their own wallet.

## Configuration

| Variable                           | Default     | Meaning                                                                                                                                                                                                                                                              |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IXO_TRANSACTION_ALLOW_MAINNET`    | `'false'`   | `'true'` lets mainnet drafts through, each only with the receipt of the same message signed on testnet (see [Mainnet](#mainnet)), and the DAO DAO tools (`create_dao_group` and the proposal steps) on a mainnet oracle (no receipt). Off: refused, nothing is sent. |
| `IXO_TRANSACTION_CHAIN_ID_DEVNET`  | `devnet-1`  | The chain id a devnet request names.                                                                                                                                                                                                                                 |
| `IXO_TRANSACTION_CHAIN_ID_TESTNET` | `pandora-8` | The chain id a testnet request names.                                                                                                                                                                                                                                |
| `IXO_TRANSACTION_CHAIN_ID_MAINNET` | `ixo-5`     | The chain id a mainnet request names.                                                                                                                                                                                                                                |
| `IXO_TRANSACTION_SIGN_TIMEOUT_MS`  | `120000`    | How long the signing tools wait for the wallet. At most `300000`. A value outside the range fails the boot.                                                                                                                                                          |

The chain id defaults are what each network's RPC reported in
`/status` (`node_info.network`) on 2026-10-05: `devnet.ixo.earth` →
`devnet-1`, `testnet.ixo.earth` → `pandora-8`, `impacthub.ixo.world` →
`ixo-5`. The runtime's own `NETWORK` variable names a network but carries no
chain id, so the plugin keeps its own map; override an entry when a chain
upgrade changes the id. One variable per network (rather than one chain id
for the oracle) because one oracle prepares both the testnet run and the
mainnet run of the same transaction. The POD Creator declares the same three
variables (the same schema objects, `src/plugins/ixo-transaction/chain-ids.ts`,
so the boot does not report them as a collision): one set names the chain
for both plugins' signing requests.

There is no key, mnemonic or endpoint to configure. The plugin's only network
requests are chain REST reads at the oracle's chain endpoint (the one
`chain_lookup` reads, from `NETWORK`): a DAO DAO proposal before a vote,
carry-out or close, and a new group's transaction after `create_dao_group`.

## Tools

| Tool                              | Effect | Returns                                                                                                                                                                        |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_ixo_transaction_routes`     | read   | The routes (`/ixo {message-type} {message-action}`), their fields, risk level and risks; deferred modules.                                                                     |
| `classify_ixo_transaction_intent` | read   | `{ status: 'resolved', intent }` or `{ status: 'unresolved', error }`.                                                                                                         |
| `validate_ixo_transaction_draft`  | read   | `{ status: 'valid', message, risks, riskLevel, requiresConfirmation, network, chainId, intent }` or `{ status: 'invalid', error }` (mainnet drafts get the receipt check too). |
| `sign_ixo_transaction`            | write  | One of the statuses below.                                                                                                                                                     |
| `create_dao_group`                | write  | A new DAO DAO group of its own ([below](#a-new-dao-dao-group)).                                                                                                                |
| `link_dao_group`                  | write  | An existing DAO DAO group made the governing group of an entity the user can change ([below](#linking-a-group-to-an-entity)).                                                  |
| `create_dao_proposal`             | write  | A DAO DAO group proposal step ([below](#dao-dao-proposal-steps)).                                                                                                              |
| `vote_on_dao_proposal`            | write  | A DAO DAO group proposal step.                                                                                                                                                 |
| `execute_dao_proposal`            | write  | A DAO DAO group proposal step.                                                                                                                                                 |
| `close_dao_proposal`              | write  | A DAO DAO group proposal step.                                                                                                                                                 |

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
| `rejected`         | The call failed without a code or hash and the Portal's error says the user rejected, denied, declined or cancelled (and is not the chain's own words).       |
| `error`            | Any other failure without a delivery: a chain mismatch or a refused message in the Portal, a wallet error, the chain refusing the wallet's simulation.        |
| `timeout`          | No answer: the timeout passed, the Portal tab's socket dropped, or the turn ended after the request was sent. `outcome: 'unknown'`: the user may still sign.  |
| `validation_error` | The draft failed validation, the risk gate or the mainnet gate. Nothing was sent.                                                                             |
| `unavailable`      | No Portal session, no browser connected to it, or the Portal has no signing handler.                                                                          |

`sign_ixo_transaction` is a write. A `timeout` result carries
`outcome: 'unknown'` (the bridge's `FRONTEND_OUTCOME_UNKNOWN` answer, see
`frontend-bridge.md`), which the tool-execution middleware treats as an unknown
outcome: the claim stays in the run ledger, and an identical signing request in
a later turn is answered with "outcome unknown, verify first" instead of
reaching the wallet again. Within one turn the repetition guard already stops
an identical second call. The call is bound to the one socket it was sent to;
a result from any other socket never settles it (see `FrontendCallRegistry`),
and the turn's abort signal ends it as unknown once it was sent.

`rejected` is only ever read from the Portal's error text when the call failed
without a code or hash: a delivered-but-failed transaction comes back as a
successful call (`failed`), so a chain log that happens to say "cancel" never
reads as the user declining. Nor does a chain error the wallet passes on from
its simulation (it carries cosmos-sdk's `failed to execute message; message
index: N`), whatever the contract's words: DAO DAO's "only rejected proposals
may be closed" is `error`, not `rejected`. Every error text reaches the
model as one line of at most 600 characters (`WALLET_ERROR_MAX_CHARS`), so
the chain's or contract's reason — e.g. "proposal is not in 'passed' state"
from the passkey or session-key signer's fee simulation — is what the model
tells the user. The Portal passes that text on since its signing adapter asks
`transactSignX` to rethrow (`hooks/useSignBroadcastAdapter.ts`); before, a
failure there was swallowed and replaced with "The wallet could not start
signing this transaction".

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

On `action_call` with `toolName: 'sign_transaction'` the oracle sends
(`SignTransactionActionArgsSchema`):

```ts
{
  action: 'sign_transaction';
  network: 'devnet' | 'testnet' | 'mainnet';
  chainId: string; // e.g. 'pandora-8'
  messages: { typeUrl: string; value: Record<string, unknown> }[]; // proto-JSON; see the two forms below
  memo?: string;
  intent:
    | { source: 'slash-command' | 'natural-language' | 'type-url' | 'explicit-route'; module; action; messageName; typeUrl; confidence; ambiguities }
    | { source: 'batch'; summary: string; messages: { module; action; messageName; typeUrl }[] };
  risks: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresConfirmation: boolean;
  riskConfirmation?: { confirmed: true; acceptedRisks: string[] };
  testnetReceipt?: { transactionHash: string; receiptId: string }; // single form, mainnet only
}
```

`intent.source` tells the two forms apart:

- **Single message** (a conversational draft, `sign_ixo_transaction`):
  exactly one message, whose route `intent` describes.
- **Batch** (`intent.source: 'batch'`, the POD Creator's
  `request_pod_signature`): 1 to `MAX_BATCH_MESSAGES` (16) messages signed
  together in one wallet transaction; `intent.messages` names each message's
  route in order and must match `messages`; no `testnetReceipt`. See
  [The batch form](#the-batch-form).

The handler:

1. validates the args, and every message against the catalog: a known
   typeUrl, exactly its fields, each of its kind, nested messages included —
   the same check the oracle ran, so a tampered or mis-built message never
   reaches the wallet; one bad message refuses the whole request;
2. refuses a `chainId` other than the one it was given;
3. decodes every message with the IXO SDK's generated `fromJSON` (bytes,
   `Long`, `Timestamp`), encoding an allowlisted authorization into the
   grant's `Any` with the SDK codec;
4. calls `transactSignX(messages, memo)` once — one transaction for one
   message or a whole batch — and answers `action_call_result`.

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

## The batch form

A caller that composes several messages itself — today only the POD
Creator, whose chain gateway builds the entity, its claim collection and the
grants — signs them as one transaction (all or nothing on chain) through the
same action and the same Portal handler. Conversational drafts stay single:
`TransactionDraftSchema` has no `messages`, and
`validate_ixo_transaction_draft` / `sign_ixo_transaction` take one message.

- `TransactionBatchSchema` — strict: `messages` (1–16), `summary` (1–1000
  characters), `memo?`, `network` (default testnet), `riskConfirmation?`.
- `validateTransactionBatch(input, { allowMainnet, requireRiskConfirmation })`
  — every message through `validateMessage`; `risks` are every message's
  catalog risks, each once, in message order; `riskLevel` is the highest;
  `requiresConfirmation` is true when any message is risky; with
  `requireRiskConfirmation` every risk must be accepted word for word, as
  for one message. Mainnet needs `allowMainnet`. There is no testnet receipt:
  the receipt check proves "the same message was signed on testnet", which a
  batch that creates new entities cannot repeat; each caller owns its
  mainnet policy (the POD Creator's is `POD_CREATOR_ALLOW_MAINNET`).
- `buildBatchSignTransactionActionArgs(input, { allowMainnet, chainIds })` —
  validates with the risk gate on and renders the batch form of the args.

The bound (16) keeps what the user reviews in one wallet prompt, and the
transaction's size, small. It is a review bound, not a gas figure: a batch
within it can still run out of gas; the chain's block gas limit was not
checked against it.

The catalog already holds every message the POD batch uses —
`MsgCreateEntity`, `MsgCreateEntityAccount`, `MsgCreateCollection`,
`MsgCreateClaimAuthorization` and `MsgGrantEntityAccountAuthz` — each
checked against the SDK by `tests/catalog-sdk.test.ts`, so the batch added
no catalog entries. The POD's claim authorizations go through
`MsgCreateClaimAuthorization`, whose fields are all structured; an
entity-account grant's `authorization` stays limited to the allowlist
(generic, bank send).

## DAO DAO groups

Module `daodao` (DAO DAO contracts v2.0.3; native `x/group` is never used)
has five routes: `/ixo daodao create-group`
(`/cosmwasm.wasm.v1.MsgInstantiateContract`) and `propose`, `vote`,
`execute`, `close` (all `/cosmwasm.wasm.v1.MsgExecuteContract`, told apart
by the one top-level key of `msg`; `group` is an alias of `daodao`). Each
value must be exactly one shape (`packages/ixo-transaction/src/daodao-schemas.ts`),
never an arbitrary instantiate or execute: `create-group` is the Portal's
multisig group (`dao_core` + `dao_voting_cw4` over a `cw4_group`, one
`dao_proposal_single` behind a `dao_pre_propose_single`, absolute-count
threshold, no deposit, a voting time of 1 hour to 30 days
(`DAODAO_VOTING_PERIOD_SECONDS`, default the Portal's 7 days) and vote changes
on or off (`allow_revoting`, default on, as the Portal), no minimum voting
time), every code id the network's
(`DAODAO_CODE_IDS`, checked against the SDK's `getContractCode`), unique
checksummed members, threshold 1..members, wasm admin the sender or none,
no funds; the execute steps go to a 32-byte contract address, with the
Auth Hub's vote options and text limits, and a proposal holds at most 4
actions of the allowlisted types (`DAODAO_PROPOSAL_ACTION_ACTORS`), each a
valid catalog message whose actor is the group. A proposal's risks are its
own and those of each action it holds (`daoDaoProposalActions` reads them),
in the batch, the single draft and the Portal's consent sheet alike, and its
level is the highest of them: a proposal that would send the group's funds
is `high` and discloses `Transfers tokens to another address.`, one that
would retire credits `critical`. `describeMessageValues` /
`describeDaoDaoProposalAction` word a message with its catalog fields'
values (coins as `<amount> <denom>`, token batches as `<amount> of token
<id>`, other values as text or JSON, each clipped to 120 characters).
Validation needs the
network (`validateMessage(message, { network })`; the draft, batch and
Portal paths pass it). In the shown value every CosmWasm `Binary` is
decoded (nested module messages as JSON, proposal actions as
`{ stargate: { type_url, value: <proto-JSON> } }`); the Portal encoder turns
them into base64 and the `msg` into UTF-8 JSON bytes once. Because the
execute routes share a typeUrl, `findMessageByTypeUrl` returns nothing for
it: use `findMessageForValue(message)`, and the Portal handler refuses a
request whose `intent` names another route than its message. Builders for
the runtime: `buildDaoDaoGroupInstantiate`, `buildDaoDaoProposalMessage`,
`buildDaoDaoGroupLinkMessages` (link the group to its entity and make it a
controller), and `findDaoDaoCoreAddress` (the `instantiate` event whose
`code_id` is `dao_core`) to read the new group from the transaction.

### A new DAO DAO group

`create_dao_group` (`dao-tools.ts`) creates a DAO DAO group of its own from
a Portal chat: the model gives a few fields and the tool builds the one
`MsgInstantiateContract` with `buildDaoDaoGroupInstantiate`, the Portal's
multisig group with the network's code ids, so the model never writes the
nested instantiate message or a code id. The governance group of a POD the
conversation created is the POD Creator's `create_pod_group` instead
([pod-creator](pod-creator.md#the-governance-group)), which also links it to the
POD; the tool description and the operating guide say so.

| Input                  | Bounds                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | 1 to 64 characters, one line (`DAODAO_MAX_NAME_LENGTH`)                                                                                                                                             |
| `members`              | 1 to 12 checksummed 20-byte `ixo1…` account addresses, each once, one vote each (`MAX_DAO_GROUP_MEMBERS`: every address is quoted in the 1000-character summary); the user's own account among them |
| `threshold`            | 1 to the number of members: the yes votes that pass a proposal                                                                                                                                      |
| `votingPeriodSeconds?` | 3600 to 2592000 (1 hour to 30 days), default 604800 (`DAODAO_VOTING_PERIOD_SECONDS`)                                                                                                                |
| `allowRevoting?`       | default `true` (`DAODAO_DEFAULT_ALLOW_REVOTING`)                                                                                                                                                    |
| `description?`         | at most 300 characters, one line (`DAODAO_MAX_DESCRIPTION_LENGTH`); empty without one                                                                                                               |
| `riskConfirmation?`    | as the other signing tools                                                                                                                                                                          |
| `txHash?`              | 64 hex characters: only to read back this exact group after its wallet answer was lost (below); nothing is sent then                                                                                |

The tool description tells the model to ask the user how long voting lasts
and whether votes can be changed when they did not say, with the trade-off:
with vote changes a proposal passes only when voting closes, even once
enough members voted yes; without them it passes as soon as enough members
vote yes, and a vote cannot be changed. Those words, the bounds and the
plain-words helpers (`votingPeriodText`, `passRuleText`, `membersText`)
are shared with `create_pod_group` (`dao-group.ts`).

**The creator must be a member.** The sender is the user's own account
(`did:ixo:ixo1…`), and a group whose members leave it out is refused
(`validation_error`, nothing sent) with the user's address, so the model can
ask them to add it. A group its creator is not in is almost always a slip:
they could not propose, vote on or carry out anything in it, and
`chain_lookup daos` would not list it among their groups. There is no
override; someone who is a member creates such a group.

Confirm first, as the proposal steps: without `riskConfirmation` the call
sends nothing and answers `{ status: 'confirm', network, name, description,
members, threshold, votingPeriodSeconds, allowRevoting, summary, risks,
message }`, with the catalog's two `create-group` risks (the group decides
what its account does; the wasm admin, the creating wallet, can replace its
code without a vote). The summary the wallet shows names the group, the
network, the sender, every member, the threshold, the voting time in words
and the vote-change rule (`Create the DAO DAO group "Borehole fund" on
testnet from your account ixo1…: a DAO DAO multisig of 2 members, one vote
each: ixo1…, ixo1…. A proposal needs 1 yes vote; voting lasts 1 hour. It
passes as soon as it has them, and votes cannot be changed. You are a
member.`); the description does not always fit its 1000 characters, so it
is in the preview and in the wallet's view of the message. The signing call
quotes every risk (compared with `riskTextKey`: `group's` quotes
`group’s`) and comes from a later request than the preview, with the same
fields ([confirmed in a later message](#confirmed-in-a-later-message)).
Mainnet needs `IXO_TRANSACTION_ALLOW_MAINNET=true`, no receipt.

**Once per conversation.** Each group is recorded by the digest of its
arguments (network, sender, name, members in order, threshold, voting
rules, description) in the confirmation record (`dao-confirmations.ts`):
`sending` when the signing claims it, then `created` (signed, with its
transaction and address when read), or `unknown` after a timeout; a
`failed`, `rejected`, `error` or `unavailable` answer releases it. The same
group is refused (`status: 'refused'`, nothing sent, in the preview and in
the signing call) while it is `sending`, once `created` (the message names
its address and transaction), and while `unknown`: the message tells the
model to check `chain_lookup daos`, and, when the user has the hash from
their wallet, to call again with the same fields and `txHash`. That call
sends nothing: it reads the transaction back as after a signature, and a
transaction that is this group records it `created` and answers `created`
with its addresses; anything else (another transaction, a failed one, not
readable yet) leaves the outcome unknown. A `sending` or `unknown` attempt
holds for `GROUP_ATTEMPT_HOLD_MS` (1 hour) from when it was sent; after that
the same group can be shown and confirmed again (the message gives the
time). A group with any other choice is another group.

After the signature the wallet answers with the hash only, so the tool
reads the transaction back (`findDaoGroup` in `dao-group.ts` over
`lookupTransaction` in `ixo-chain/tx-lookup.ts`, both shared with the POD
Creator's `findPodGroup`: `/cosmos/tx/v1beta1/txs/{hash}`, polled every 2 s
through 404s and transient failures within 20 s, the ixo-chain retry policy
and per-user permits). It accepts only exactly one `dao_core`
instantiate from the user's account with the name, members (any order,
weight 1), threshold, voting time and vote-change rule sent, and reads every
address from the transaction's `instantiate` events, with no further
query: the core (`dao_core`, `findDaoDaoCoreAddress`), the proposal module
(`dao_proposal_single`) and its intake (`dao_pre_propose_single`), each
taken only when exactly one event of its code id is there. A devnet group
transaction (Nov 9 2026) carries the five `instantiate` events of the core
and its modules; the suite reads one back.

| Result                                                                                         | When                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ status: 'created', network, name, txHash, coreAddress, proposalModule?, intake?, message }` | Signed and read back: `intake` goes to `create_dao_proposal`, `proposalModule` to the vote, carry-out and close tools; one the transaction did not name is left out and the message says to read it with `chain_lookup daos`.       |
| `{ status: 'created', network, name, txHash?, message }`                                       | Signed, but no hash came back, the transaction is not readable within 20 s, or it is not the group sent. Never sent again: the message points at `chain_lookup daos` (or, for a transaction that is not the group, the wallet).     |
| the [signing outcomes](#signing-outcomes) other than `signed`                                  | `failed`, `rejected`, `error`, `timeout` (outcome unknown, never resent), `unavailable`; no `hint`, since no group contract ran yet.                                                                                                |
| `{ status: 'refused', retryable, message }`                                                    | Nothing sent: not previewed in an earlier request with these fields, or this exact group was already sent in this conversation (above); a `txHash` read-back that did not show the group (`retryable` when it may later).           |
| `validation_error` / `unavailable`                                                             | Refused before anything is sent: input out of bounds, a member twice, the user not a member, a missing risk, mainnet off, a `txHash` without a lost answer to read back; a DID that is not an IXO account, a host without `ctx.kv`. |

### Linking a group to an entity

`link_dao_group({ entityDid, coreAddress, riskConfirmation? })`
(`dao-link.ts`, its chain reads in `dao-link-check.ts`) makes an existing
DAO DAO group the governing group of a POD or any other entity the user can
change, after the fact: a POD created earlier, elsewhere or in the Portal,
or a group made with `create_dao_group` ("make my existing POD a DAO" is
`create_dao_group`, then `link_dao_group` with its `coreAddress`). The POD
Creator's `create_pod_group` / `link_pod_group` stay the path for the POD
created in the same conversation; the tool descriptions, the operating
guide and the POD Creator's hand-offs say so. It sends what the Portal
sends when it provisions a POD's group (`buildDaoDaoGroupLinkMessages`):
`MsgAddLinkedEntity` (`{id}#<core>`, type `group`, relationship `governs`)
and `MsgAddController did:ixo:wasm:<core>`, signed by the user's account in
one batch — or only the one still missing.

| Input               | Bounds                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `entityDid`         | `did:ixo:entity:` + 32 hex characters                                                                           |
| `coreAddress`       | a checksummed 32-byte `ixo1…` contract address: the group's core (`dao` in `chain_lookup daos`)                 |
| `riskConfirmation?` | as the other signing tools: the risks of the messages that will be sent (`add-linked-entity`, `add-controller`) |

**The chain check.** Before the preview and again in the signing call (after
the schema and mainnet checks, before the confirmation is claimed), within
one 20 s budget of bounded chain REST reads (`restJson`: time, size, the
ixo-chain retry policy, the user's read permits):

| Read                                                                     | What it decides                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ixo/entity/{did}` (404 = none)                                         | The entity exists; its type; its IID document. The user's account must be a verification method named under `authentication` (`iid-signer.ts`, shared with the POD Creator's owner check): the IID message server runs both messages only for such a signer (`ExecuteOnDidWithRelationships`), so the `controller` list is not what decides. Existing links: another group's `governs` link refuses; this group's link or controller already there is left out. |
| `/cosmwasm/wasm/v1/contract/{core}`                                      | A contract lives there (`no such contract` is refused) and its `code_id` is the network's `dao_core` (`DAODAO_CODE_IDS`).                                                                                                                                                                                                                                                                                                                                       |
| `dump_state` of the core                                                 | The group's name, voting module, proposal lists and pause state.                                                                                                                                                                                                                                                                                                                                                                                                |
| `group_contract` of the voting module, then `list_members { limit: 30 }` | The members (a full page of 30 says "or more"). A voting module that does not know `group_contract` (not a cw4 multisig) is a note, not a refusal.                                                                                                                                                                                                                                                                                                              |
| `config` of each enabled proposal list (at most 3)                       | The pass rule in words: threshold, voting time, vote changes, who carries out.                                                                                                                                                                                                                                                                                                                                                                                  |
| IXO Names worker (3 s at most, skipped with `IXO_NAMES=off`)             | The entity's name for the summary, when known.                                                                                                                                                                                                                                                                                                                                                                                                                  |

Refusals (`{ status: 'refused', retryable, message }`, nothing sent), word
for word after `Nothing was sent: `:

- not able to change it: `your account <addr> cannot change <did>: the entity’s identity document does not list your account under authentication, and the chain adds a linked entity or a controller only for such an account. Only someone who controls the entity can link a group to it: ask them to do it, or to add your account to it first.`
- no entity: `the chain has no entity <did> on <network>. Check the DID (chain_lookup entity).`
- another group governs it: `<did> is already governed by the DAO DAO group <other>. Replacing the group that governs an entity is a separate, deliberate change (the old group’s link and its control of the entity are removed, then the new one is added), which this tool does not make; the entity’s owner can change its governance in the Portal, in the entity’s settings.`
- this group already governs it (link and controller both there): `the DAO DAO group <core> already governs <did>: it is linked as its governing group and is a controller of its identity, so there is nothing to link.`
- the same id linked otherwise (another type or relationship): the chain takes one link per id, so it is removed first.
- no contract: `there is no contract at <core> on <network>, so it is not a DAO DAO group. Copy the group’s address exactly: …`
- another code: `<core> is a contract of code <n>, not a DAO DAO group: a group’s address is its core contract (code <dao_core> on <network>). Give the group’s own address (…), not one of its modules (its proposal list, intake or voting module).`
- a read that failed: `<what> could not be read from the chain (<detail>).`, `retryable` as the failure.

A bad DID or address is a `validation_error` before any read; mainnet needs
`IXO_TRANSACTION_ALLOW_MAINNET=true` (`validation_error`, as the other DAO
DAO tools).

**Membership.** The user need not be a member of the group: a POD's board
may well not include the account that created the POD. It is shown
(`youAreMember`) and, when false, a note says the user then cannot propose
or vote on what the group decides for the entity. Other notes: an entity
type the Portal shows no Decisions tab for (anything but `dao`, `dao/pod`,
`pod`, `protocol/dao`, `protocol/pod`; the link is made all the same), a
group without a member list, more than 30 members, no enabled proposal list,
a paused group, and a partial link (only the missing message is sent).

**The preview**: `{ status: 'confirm', network, entityDid, entityType,
entityName?, coreAddress, groupName, members?, moreMembers?, rules,
youAreMember?, sends, notes, summary, risks, message }`. The summary the
wallet shows names the group and its address, the entity (type, name when
known, DID), the network, that the group gets full control of the entity's
identity (`did:ixo:wasm:<core>`), the user's account (which stays a
controller), and, when they fit its 1000 characters, the group's size and
first pass rule. The risks are the catalog's for each message sent
(`Attaches a linked entity relationship to the IID document.`, `Adds a
controller DID — grants full control over the identity.`). Confirmation
works as for the other DAO DAO tools ([below](#confirmed-in-a-later-message)),
except that the signing call reads the chain before it claims the preview,
since the messages depend on what the chain shows: a link that grew a
missing message since its preview needs that message's risk too.

**Once per conversation.** The link is recorded by the digest of `network`,
the user's account, `entityDid` and `coreAddress`, in the same record and
with the same states as `create_dao_group`'s groups: `sending`, `created`
(the link confirmed on chain), `unknown` (a timeout, or signed but not
confirmed). Since the chain check comes first, a link the entity now shows
is refused as already linked whatever the record says; one it does not show
yet is refused while `sending` or `unknown` (for `GROUP_ATTEMPT_HOLD_MS`).

**After the signature** the transaction is read back (`lookupTransaction`,
polled within 20 s): it counts as linked only in a block with code 0 and
carrying each message sent (same entity, same group).

| Result                                                                                  | When                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ status: 'linked', network, entityDid, coreAddress, txHash, decisionsUrl, message }`  | Read back with code 0. `decisionsUrl` is `<portal>/domain/<did>/overview?tab=decisions`, the Portal as the POD Creator links it (`portalUrlFor`, `POD_CREATOR_PORTAL_URL` or the network's). |
| `{ status: 'signed', network, entityDid, coreAddress, txHash?, decisionsUrl, message }` | The wallet signed, but returned no hash, the transaction is not readable within 20 s, or it does not carry the link. Recorded `unknown`: not sent again.                                     |
| `{ status: 'failed', …, code, transactionHash, height, error, hint? }`                  | The read-back shows a failed transaction (or the wallet reports one): released, can be shown again.                                                                                          |
| the other [signing outcomes](#signing-outcomes)                                         | `rejected`, `error` (with a `hint` for the chain's signer refusal, a duplicate linked entity, a missing identity document), `timeout`, `unavailable`.                                        |

### DAO DAO proposal steps

Four thin tools (`dao-tools.ts`) propose to, vote on, carry out and close
proposals of a DAO DAO group, a POD's governance group included. The model
never writes the nested contract message: each tool takes a few fields,
builds the one `MsgExecuteContract` with `buildDaoDaoProposalMessage`, and
sends it through the same `sign_transaction` path as a one-message **batch**,
whose `summary` says what it does with every value it carries (the single
form has no summary). The generic route (`/ixo daodao vote` through
`sign_ixo_transaction`) still validates, but is not what the model is
guided to: the nested shapes are easy to get wrong, and a mainnet group has
no testnet run to cite.

| Tool                   | Input                                                                                                               | Message                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `create_dao_proposal`  | `intake` (or `proposalModule` for a list without one), `title`, `description`, `actions?` (catalog messages, max 4) | `propose` to the intake (`{ propose: { msg: { propose } } }`) or the list |
| `vote_on_dao_proposal` | `proposalModule`, `proposalId`, `vote` (`yes` / `no` / `abstain`), `rationale?`                                     | `{ vote: { proposal_id, vote, rationale } }` (`null` without one)         |
| `execute_dao_proposal` | `proposalModule`, `proposalId`                                                                                      | `{ execute: { proposal_id } }`                                            |
| `close_dao_proposal`   | `proposalModule`, `proposalId`                                                                                      | `{ close: { proposal_id } }`                                              |

Each also takes `riskConfirmation`. Without it the call sends nothing and
answers `{ status: 'confirm', network, summary, risks, message }`: the model
shows the summary and every risk and stops; with every risk quoted, in a
later request than that preview ([below](#confirmed-in-a-later-message)), it
sends. A proposal's summary names each action with its values
(`describeDaoDaoProposalAction`, the actor field left out: `…If it passes,
the group’s own account does MsgSend (to address ixo1…, amount 5000000
uixo).`), and its risks are the proposal's and each action's (the
package's batch risks); when the actions do not fit the 1000-character
summary with the description, the description gives way (`the description
is in the wallet’s details`), and past that the proposal is refused
(`validation_error`: propose fewer actions). The sender is the user's own account (`did:ixo:ixo1…`; any
other DID is `unavailable`), the network the oracle's chain network
(`NETWORK`, as `chain_lookup` reads it, so the addresses found there are on
the chain signed for). Mainnet needs `IXO_TRANSACTION_ALLOW_MAINNET=true`
and no testnet receipt: a group and its proposals exist on one network only.
A proposal action must be a catalog message of an allowed type whose actor
is the group (`DAODAO_PROPOSAL_ACTION_ACTORS`), checked by the package.

The model finds what to pass with `chain_lookup`: a POD's group from
`entity` (`governingGroup`: the core address of its `group` linked entity
with relationship `governs`, in any case, as the Portal's Decisions tab
reads it), the user's groups and where each takes proposals from `daos`
(each proposal list's `proposalModule` and `intake`), and proposals with
their tally and the user's vote from `dao_proposals` (`dao` set). The
operating guide says to copy addresses and the proposal `id` exactly.

Vote, carry out and close read the proposal first (`dao-proposal-check.ts`),
on the preview call and again right before sending: one CosmWasm smart query
`{ "proposal": { "proposal_id": N } }` on the proposal module through chain
REST (`/cosmwasm/wasm/v1/contract/{module}/smart/{base64}`, `restJson` with
`contractQuery`, a 10 s budget, the ixo-chain retry policy and per-user
permits). The contract answers the proposal's current status, so the check
follows DAO DAO 2.0.3 `dao-proposal-single`:

| Step    | Goes ahead when                                              | Refused (`status: 'refused'`, nothing sent)                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vote    | voting has not closed (`expiration` `at_time` in the future) | voting closed (the contract's `Expired`), whatever the status. A decided proposal still open for votes goes ahead with a note: the vote is recorded but cannot change it.                                                   |
| execute | `passed`                                                     | `open` (with vote changes allowed DAO DAO decides only when voting closes: the message says it will pass then when it already has enough yes votes), `rejected`, `closed`, `executed`, `execution_failed` (never run again) |
| close   | `rejected`                                                   | `open`, `passed`, `closed`, `executed`, `execution_failed`                                                                                                                                                                  |

The same answer's `msgs` are what a carry-out makes the group's own account
do (`proposal-actions.ts`): a `stargate` action of an allowed type
(`DAODAO_PROPOSAL_ACTION_ACTORS`) is decoded from its protobuf with the
SDK's codec (`decode` + `toJSON`, the catalog's proto-JSON) and worded with
its values and catalog risks; any other action (another stargate type, a
`bank`, `wasm` or other message, a value that does not decode) is named
and said plainly to be unreadable here, to check in the Portal's Decisions
tab. The `execute_dao_proposal` preview's summary lists them (`…: the group’s
own account does its 2 actions: 1) MsgSend (to address ixo1…, amount 5000000
uixo); 2) an action this oracle cannot read (a bank message): …`; a proposal
without actions `only marks it carried out`; as many as fit the summary, the
rest counted), `actions` carries every one, and `risks` adds each decoded
action's catalog risks to the carry-out's: the signing call must quote them
too (checked after the re-read; `validation_error` otherwise). The Portal's
consent sheet shows the carry-out's own risk only: it does not read the
proposal.

The refusal's `message` gives the status, the tally against the threshold
(yes / no / abstain of the total power) and when voting closes. A proposal
the chain does not have (the contract refuses the query) is refused, not
retryable; an answer that is not a single-choice proposal too; a chain that
cannot be read is `retryable: true`, never a guess. The preview's `summary`
carries the proposal's title, and `proposal` its state for the user. A
deadline in blocks (`at_height`) is left to the chain, and only an absolute
count threshold is said to be met (a percentage one is described).

The chain still decides who may propose, vote (a member with voting power
when the proposal opened) and carry out (members only), and the wallet's
simulation or the chain refuses anyone else. Results are the
[signing outcomes](#signing-outcomes) with the `step`; a refusal carries the
chain's words in `error` and, for the DAO DAO 2.0.3 errors people run into, a
plain `hint` (`daoStepHint`, each matched on the contract's own text from
`dao-proposal-single` `ContractError` and `dao-pre-propose-base`
`PreProposeError`): not registered to vote, not a member (propose), already
voted with vote changes off, the same vote again, expired, not in `passed`
state, only rejected proposals may be closed, unauthorized (the contract's,
not the SDK's signature `unauthorized`), no such proposal, the group paused.
A `rejected` result is the user declining; `error` tells the model to pass the
wallet's reason on in plain words. Both say a retry starts with a new preview.

### Confirmed in a later message

As `create_pod_group`, every DAO DAO tool signs only what the user saw in an
earlier message. A preview records the digest of the step's arguments
(`operationKey(tool, { network, input })`; for a group its fields) and the
request that showed it in the user's own store (`ctx.kv`, namespace
`ixo-transaction/dao-confirmations`, one row per user and session, 1 hour
idle and 1000 sessions, as the POD Creator's create sessions; at most 16
previews and 16 group attempts a session). The signing call, after the risk
and wallet checks and before any chain read, claims the preview with the
same digest: none (other fields, another session, already used) and the
call from the request that showed it are `refused` (nothing sent; the
message tells the model to show the preview and wait for the user's reply).
A claim spends the preview, so each wallet request needs one of its own; a
retry after `rejected` or `error` starts with a new preview. A host without
`ctx.kv` signs nothing (`unavailable`).

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

- Votes per voter are not read: `dao_proposals` gives a proposal's tally
  and the user's own vote. A per-voter list would push the ixo-chain tool
  definitions over their size budget.
- Coverage is entity, iid, claims (minus the dispute-deposit, adjudication,
  membership and withdrawal messages new in `@ixo/impactxclient-sdk@3.0.0`),
  token, smart-account and DAO DAO groups (no proposal deposits, no
  multiple-choice proposals, no staking, network-vote or grant-wrapped
  collection actions in a proposal). The catalog is checked against SDK 3.0.0 by the
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
  user has to check (it has no chain-read tool; after a `create_dao_group`
  timeout, `chain_lookup daos` lists the group once it exists).
- `link_dao_group` does not replace or remove a governing group, and takes
  `did:ixo:entity:` DIDs only. It reads 30 members and 3 proposal lists at
  most. It checks the user's account against the entity's `authentication`
  methods, as the chain's IID message server does (ixo-blockchain v8
  `x/iid/keeper/msg_server.go`); signing through an authz grant is not
  supported.
- `create_dao_group` records the groups it sent in the session's row,
  which expires after 1 hour without use (as the POD Creator's create
  sessions): the same group confirmed again in a later conversation, or
  after that hour, is a second group. A group whose answer was lost blocks
  only for `GROUP_ATTEMPT_HOLD_MS` (1 hour) unless read back by its hash.
- A carry-out names the actions it can decode only (the stargate types a
  proposal made here can hold); any other action is shown as unreadable,
  with no risks of its own. The Portal's consent sheet does not read the
  proposal, so it shows the carry-out's own risk, not its actions'.

## Tests

- `pnpm --filter @ixo/ixo-transaction test` — the runtime-neutral package
  (`packages/ixo-transaction/tests/`): the catalog against the SDK version
  the lockfile resolves and its codec, intent routing, the proto-JSON
  conversion, the Portal `sign_transaction` handler (a single message and a
  POD-shaped batch decoded and signed in one wallet call), validation and
  the per-network chain ids, the batch form (`tests/batch.test.ts`: bounds,
  drafts staying single, risk derivation, the mainnet gate, the builder, the
  args schema refusing a misnamed batch or a receipt), and a scan proving
  the package imports nothing but `zod` outside `./react` (no signing
  capability on the oracle side).
- `pnpm test` (workerd) — `src/plugins/ixo-transaction/*.test.ts`; what they
  cover is listed in [testing](testing.md#unit-tests-seconds). The dispatch
  and the outcome mapping are shared with the POD Creator
  (`wallet-signing.ts`), whose suite is listed in
  [pod-creator](pod-creator.md#tests).
- The devnet feature matrix — the step
  `realtime: sign_ixo_transaction sends sign_transaction to the browser wallet and the signed hash returns`
  answers the request with a recording wallet over the real socket
  ([testing](testing.md#the-devnet-feature-matrix-minutes-deployed-worker)).
