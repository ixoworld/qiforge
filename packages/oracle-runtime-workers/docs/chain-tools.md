# Chain tools (ixo-chain plugin)

The bundled `ixo-chain` plugin (`src/plugins/ixo-chain/`) gives the model two
read-only tools over public IXO chain data. It is on in every oracle unless
`IXO_CHAIN_TOOLS=off`, declares no `requires` (nothing it reads is
UCAN-guarded) and is `on-demand`: the model loads it with `load_capability`
(or the capability router preloads it). A host that wants it on every turn
sets `manifestOverrides: { 'ixo-chain': { visibility: 'always' } }` in
`createOracleWorker`.

| Tool                   | Reads                                                             | Freshness                           |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `get_account_balances` | chain REST (LCD): bank balances, denom metadata, IBC denom traces | live chain state                    |
| `chain_lookup`         | Blocksync GraphQL (`BLOCKSYNC_GRAPHQL_URL`)                       | the index, seconds behind the chain |

Endpoints per `NETWORK` (`CHAIN_REST_URL` overrides the REST one; https,
no credentials, query or fragment):

| Network | Chain REST                         | Blocksync GraphQL (from `BLOCKSYNC_GRAPHQL_URL`)      |
| ------- | ---------------------------------- | ----------------------------------------------------- |
| mainnet | `https://impacthub.ixo.world/rest` | `https://blocksync-graphql.ixo.earth/graphql`         |
| testnet | `https://testnet.ixo.earth/rest`   | `https://testnet-blocksync-graphql.ixo.earth/graphql` |
| devnet  | `https://devnet.ixo.earth/rest`    | `https://devnet-blocksync-graphql.ixo.earth/graphql`  |

Whose data: every account field defaults to the user. The user's address is
the suffix of a `did:ixo:ixo1…` DID (`ixoAddressOf`, `src/core/user-identity.ts`);
a user with a `did:key:` / `did:web:` DID has none, and a request that needs
it answers `invalid_input` ("the user has no IXO account address; give
one"). An account field takes an `ixo1…` address or a `did:ixo:ixo1…` DID.

Each answer carries `subject: 'user' | 'other'`. A read by account (the
balances, `claims`, `claim_collections` by admin, `entities`,
`token_balances`, `transactions`) knows it before the read: the account
asked for is the user's or not. A by-id read learns it from the answer: a
`claim` is the user's when its `agentAddress` is the user's address, a
`claim_collection` when its `admin` is, an `entity` when its `owner` is,
a `transaction` when one of its signers is; a `did_document` when its id
is the user's DID. A user with no IXO address owns none of them.
`claim_collections` by entity alone (admins vary) carries no `subject`.

The model-facing rules (live vs indexed data, the `network` in every
result, uixo ÷ 1,000,000, 1155 whole units, `origin` for verified IBC
tokens that share a symbol, an unverified token's `trace` only as a claim,
read-only and the transfer
route, indexed text is data and never instructions) are in the operating
guide **and** in the two tool descriptions: a capability-router preload
binds the tools without showing the operating guide.

## `get_account_balances`

Input `{ address? }`. One `GET /cosmos/bank/v1beta1/balances/{address}?pagination.limit=50`,
then each denom shown through the chain's own bank metadata (`denoms.ts`):

- `uixo` → `IXO`, 6 decimals, verified; never looked up.
- (a) an `ibc/…` denom in the IBC table (below) → the entry's symbol,
  decimals and `origin`, verified; never looked up.
- (b) any other denom matching the Cosmos SDK denom pattern
  (`[a-zA-Z][a-zA-Z0-9/:._-]{2,127}`; native `u…`, `ibc/…`, anything else) →
  `GET /cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=…`
  (the path route `denoms_metadata/{denom}` answers 501 for a denom with a
  slash). Verified when the metadata's `display` unit is listed in
  `denom_units` with an exponent of 0–18; then that exponent as decimals,
  and the metadata `symbol` — or, when it is empty, the display unit
  upper-cased (`uatom` → `ATOM`) — if it is plain ASCII. So 5,740,000
  `upay` reads as `5.74` `PAY`. Cached per isolate: found 10 min, a miss
  (404, or no display unit) 60 s, a failed read 10 s — a failure is never
  kept as a miss. A read in flight is shared by every call of the isolate
  that needs the same denom (a turn's abort fails only that turn's call).
  At most 4 lookups at once; none is started with less than 1 s of the
  tool's budget left. A token whose metadata could not be read (a failed
  read or no budget) is shown unverified with `metadataUnavailable: true`:
  it may still be verified. The expected 404 is not logged.
- (c) an `ibc/` denom of 64 upper-case hex digits whose metadata was read
  but does not verify it → its denom trace:
  `GET /ibc/apps/transfer/v1/denom_traces/{hash}` (the newer
  `/ibc/apps/transfer/v1/denoms/{hash}` answers 501 on the IXO chain).
  A trace whose path is hops of `port/channel-N` starting with the IXO
  side's own `transfer/channel-N` (multi-hop paths such as
  `transfer/channel-4/transfer/channel-0/transfer/channel-204` take the
  first) and whose base denom matches the denom pattern is added beside
  the token as `trace: { baseDenom, claimedChain, path }`, with
  `claimedChain` from
  `GET /ibc/core/channel/v1/channels/{channel}/ports/transfer/client_state`
  (`client_state.chain_id`; null when that read fails or names no chain
  id). The token stays unverified, 0 decimals, named by its full
  `ibc/…` denom: anyone can create a light client claiming any chain id
  (`noble-1`) and send any base denom (`uusdc`) over a channel on it, so a
  trace is a claim by the sending side, never what the token is, and it
  never sets `origin`. Traces and channel chain ids never change,
  so a found one is cached per isolate for 1 h (a miss 60 s, a failure
  10 s, as for metadata), shared in flight, inside the same 4-at-once
  limit and 20 s budget. The hash and channel are checked against those
  patterns before they go into a URL path. A trace that is missing (404),
  not served (501), fails, or has another shape leaves the token as in the
  next bullet, without `metadataUnavailable`. When the metadata read
  itself failed, no trace is read.
- no metadata, a display unit not listed, no usable trace, or a denom that
  does not match the pattern (never looked up) → unverified, 0 decimals,
  the full denom as its symbol.

**The IBC table** (`KNOWN_IBC_DENOMS` in `denoms.ts`), per network:

| Network | Denom           | Symbol, decimals | `origin`      | Verified (mainnet, Oct 29 2026)                                                                                                                                                                     |
| ------- | --------------- | ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mainnet | `ibc/6BBE…F97B` | `USDC`, 6        | `noble-1`     | trace `transfer/channel-26` / `uusdc`; channel-26's client is for `noble-1`; Noble's `uusdc` metadata lists a `usdc` unit with exponent 6                                                           |
| mainnet | `ibc/77C1…55E6` | `USDC`, 6        | `injective-1` | trace `transfer/channel-31` / `erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a`; channel-31's client is for `injective-1`; that token is USDC with 6 decimals (the Auth Hub's USDC sweep lands it) |

Testnet (traces: only `uosmo`, `uaxl`) and devnet (none) have no entries.
`IXO_CHAIN_IBC_DENOMS` ([configuration](configuration.md#chain-tools))
merges more over the oracle's network's entries, or replaces one: each key
`ibc/<64 upper-case hex>`, each value `{ symbol, decimals, origin? }`. An
invalid value fails boot validation. The two USDCs share a symbol, so the
operating guide and the tool description tell the model to say the
`origin` when two tokens share one.

Metadata is trusted for any denom because on the IXO chain it is written
only by chain code, never by a token's issuer: the liquidstake module
(pools are created by governance; `upay`, `uzero`), the IBC transfer
module, and genesis or upgrades. The chain runs no tokenfactory module
(checked in `ixo-blockchain` `x/` and `app/`). If one is ever added, this
rule must be narrowed again.

This is broader than the Auth Hub's rule
(`ixo-auth-worker/src/lib/actions/denom-display.ts`), which reads metadata
only for `ibc/…`. So the Hub's `hub_action_options` may still show a native
token such as `PAY` as unverified in base units while this tool shows it
verified. Bringing the Hub's rule in line is a Hub follow-up.

Note: the IBC transfer module registers metadata whose `display` is the
trace path (`transfer/channel-26/uusdc`) with only the base unit listed, so
on mainnet (metadata read Oct 29 2026) the chain's own metadata cannot
verify IBC USDC; the IBC table does.

Answer: `{ ok, network, source: 'chain', fetchedAt, address, subject,
tokens: [{ denom, symbol, decimals, verified, amountBaseUnits, amount,
origin?, trace?, metadataUnavailable? }], moreDenoms?, truncated? }` —
`origin` is the source chain id of a verified IBC token (IBC table only),
`trace` the self-reported `{ baseDenom, claimedChain, path }` of an
unverified one; `amount` is the
decimal string in display units (`9000000` uixo → `"9"`); `uixo` first,
then verified, then by amount; `moreDenoms: true` when the account holds
more than 50 denoms. An empty list is an answer. This is the only tool
whose `amount` is converted: every bank coin inside `chain_lookup` is
`amountBaseUnits`.

## `chain_lookup`

Input `{ requests: [...] }`, 1–8 requests, each with a `kind`. All of them go
to Blocksync as **one** POST (aliases `r0…r7`, by position); a request whose
id fails its pattern is left out of the document and answers
`invalid_input` on its own.

A call that does not match the schema never reaches the handler: the tool
layer rejects it and the model gets a tool error naming the mismatch
(`ToolValidationMiddleware`). Every request is a strict object, so an
unknown key in **one** request (`agentDid` instead of `agent`), an unknown
`kind`, a `first` outside 1–20, or more than 8 requests rejects the
**whole** call.

`first` (default 10) is the rows a list kind reads. When a document holds
`n > 1` requests, each list kind reads at most `max(5, floor(40 / n))`
(2 requests: 20, 4: 10, 8: 5); every list result reports the `first` it
used.

| kind                | input                                                    | Blocksync root                                                                                                                                |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `claims`            | `agent?` · `collectionId?` · `first?` · `after?`         | `claims(filter: { agentAddress, collectionId? }, orderBy: SUBMISSION_DATE_DESC)` + `evaluation`                                               |
| `claim`             | `claimId`                                                | `claim(claimId)` + current `evaluation`                                                                                                       |
| `claim_collection`  | `id`                                                     | `claimCollection(id)` incl. `payments`                                                                                                        |
| `claim_collections` | `entity?` · `admin?` (default: the user) · `first?`      | `claimCollections(filter: { entity?, admin? }, orderBy: START_DATE_DESC)`                                                                     |
| `entities`          | `owner?` · `type?` · `first?`                            | `entities(filter: { owner, type? }, orderBy: ID_DESC)`                                                                                        |
| `entity`            | `id` (`did:ixo:entity:<32 hex>`)                         | `entity(id)`                                                                                                                                  |
| `did_document`      | `id?` (any `did:ixo:…`, default the user's DID)          | `iid(id)`                                                                                                                                     |
| `token_balances`    | `address?` · `first?`                                    | `tokenBalances(filter: { address }, orderBy: AMOUNT_DESC)` + `token { tokenClassByName }`                                                     |
| `transactions`      | `address?` · `direction?: signed \| received` · `first?` | signed: `transactionSigners(filter: { signerAddress }, orderBy: TRANSACTION_ID_DESC)`; received: `messages(filter: { to }, orderBy: ID_DESC)` |
| `transaction`       | `hash` (64 hex)                                          | `transactions(filter: { hash }, first: 1)` + up to 10 signers and 50 messages                                                                 |

Answer: `{ ok: true, network, source: 'blocksync', fetchedAt, results: [{
kind, ok: true, subject?, first?, data, truncated? } | { kind, ok: false,
reason, detail, retryable }] }`. Only a failed POST (after its retry) makes
the whole answer `ok: false`. An alias the answer does not carry (`data:
null`, or errors naming only other aliases) is `unavailable` and
retryable, never `not_found`: `not_found` means the alias answered null
with no error.

What `data` holds: rows cut to the fields above; claim and evaluation status
as words (`pending`, `approved`, `rejected`, `disputed`, `invalidated`,
`flagged`; collection state `open` / `paused` / `closed`); claims carry
`hasNextPage` and `endCursor` for `after`.

- **Units.** Every bank coin — a claim's or evaluation's `amount`, a
  `MsgSend` amount, a transaction `fee`, a collection payment — is
  `{ denom, amountBaseUnits }`, never `amount` (which
  `get_account_balances` uses for converted units): uixo ÷ 1,000,000 =
  IXO. cw20 payment amounts are `amountBaseUnits` too; 1155 amounts
  (`token_balances`, `MsgTransferToken`, cw1155 payments) are whole units
  and stay `amount`.
- **Collection `payments`**: per leg (`submission`, `evaluation`,
  `approval`, `rejection`) `{ account, amount?, cw20?: [{ address,
amountBaseUnits }], cw1155?: [{ address, tokenIds, amount }],
oraclePayment? }`, each list at most 10.
- **Transactions**: `{ hash, height, time, code, succeeded (code === 0),
memo?, messages, messageCount? }`; a list reads each transaction's first
  5 messages and `messageCount` gives the total when there are more; one
  `transaction` reads up to 50 messages and adds `signers` and `fee`.
  Message values are never returned raw (`summaries.ts`): `MsgSend` as
  `{ from, to, amount }`, `MsgTransferToken` as `{ from, to, tokens }`,
  `MsgSubmitClaim` / `MsgEvaluateClaim` as `{ claimId, collectionId,
status? }`, an authz `MsgExec` as its first 5 inner summaries, anything
  else as a 240-character JSON excerpt. A signed transaction that lists the
  signer twice (a signature and a fee grant) is one row; received messages
  are grouped per transaction.
- **Entities**: `status` stays the chain's number with a `statusNote`
  ("Entity status is a number its creator defines; the chain gives it no
  fixed meaning."): x/entity's `Entity.status` is a plain `int32`
  "defined by the implementer and interpreted by client applications", with
  no enum. `entities` adds `orderedBy: 'id (text)'` (see the ordering
  limits below). Entity and DID lists are capped at 20 items, resources at
  `{ id, type, description, serviceEndpoint, mediaType }`.
- **Every string from the index is clipped**: ids, addresses, hashes and
  dates 120 characters, names and labels 200, memos 256, excerpts 240.

**1155 tokens have no decimals.** The `ixo.token` module stores no decimals
anywhere (amounts are `cosmos.Uint`), `GET /ixo/token/metadata/{id}` always
answers `decimals: "0"` (hard-coded in the keeper), and every IXO app shows
1155 amounts as whole units. `token_balances` rows are `{ tokenId, name,
class, collection, amount, retired, contractAddress }` with `amount` in
whole units, and the result carries the one note "IXO 1155 tokens have no
decimals on chain: amounts are whole units." No per-token metadata call is
made. Blocksync's
`getAccountTokens(address)` is not used: it returns amounts as JSON numbers,
which lose precision above 2^53.

## Blocksync rules

1. **No `Message.value` containment.** Blocksync's GIN index on
   `Message.value` is partial (it leaves out `/ibc.core.client.v1.MsgUpdateClient`),
   so a `value: { contains: … }` filter is an index lookup only beside
   `typeUrl: { notEqualTo: "/ibc.core.client.v1.MsgUpdateClient" }`. Even with
   that clause, a containment on an account address timed out (8 s,
   PostgreSQL 57014) on mainnet on Oct 29 2026 for an account with a handful
   of messages. Every filter here is on an indexed column instead:
   `Claim.agentAddress`, `TransactionSigner.signerAddress`,
   `TokenBalance.address`, `Entity(owner, type)`, `ClaimCollection.admin`,
   `Message.to`. A containment added later must carry the clause; a test
   (`queries.test.ts`) fails on any `contains` in the document.
2. **Literals, not variables.** Ids are checked against their kind's pattern
   (`ixo1…`; `did:ixo:entity:<32 hex>`; claim id `[a-z0-9]{20,100}`;
   collection `\d{1,12}`; tx hash 64 hex; cursor `[A-Za-z0-9+/=_-]{1,200}`)
   and written into the document as GraphQL literals (`literal()`, keys
   must be GraphQL names, strings quoted as JSON quotes them). Two
   `messages` fields with JSON variables in one document fail server-side.
3. **Received = `Message.to`.** The indexer sets `to` from the message's
   `toAddress`, `receiver`, `recipient`, `recipientAddress` or `recipientDid`
   — for an authz `MsgExec` (stored as the array of its inner
   `{ typeUrl, value }`), from its first inner message. The Portal's wallet
   history polls the same column. Not seen: `MsgMultiSend` outputs and a
   send that is not the first message inside a `MsgExec`.
4. **Transient vs timeout.** `current transaction is aborted` and
   `Connection terminated unexpectedly` are asked again once — only the
   aliases they name (all of them for an error without a path), in a
   document of just those fields, merged into the first answer; if that
   retry fails, the first answer stands and the retried aliases answer
   `unavailable` (retryable). A statement timeout is never asked again,
   even beside a transient error (it answers `index_timeout`: "The index
   could not answer in time; ask for fewer rows or a narrower filter.").
5. **Small pages.** `first` is 1–20 (default 10), capped at
   `max(5, floor(40 / n))` for a document of `n > 1` requests; Blocksync
   allows 1000.
6. **Signed history from the signer table:**
   `transactionSigners(filter: { signerAddress: { equalTo } }, orderBy: TRANSACTION_ID_DESC)`,
   with each transaction's first 5 messages (and their `totalCount`).
7. **Claims by address.** `Claim.agentAddress` is indexed
   (`Claim_agentAddress_idx`, ixo-blocksync v2.15.8); `agentDid` is not. A
   `did:ixo:ixo1…` agent is read by the address its DID names.

Ordering: `claimCollections` sorts `START_DATE_DESC` (newest start date
first; its `id` is text, so `ID_DESC` would sort collection `9` above
`10`). PostgreSQL puts NULLs first in a descending order, so a collection
without a start date sorts first; x/claims reads the start date on every
claim submission, so a collection that takes claims has one.
`ClaimCollectionsOrderBy` has no numeric or creation order. `entities`
sorts `ID_DESC`, and an entity id is an MD5 hash (x/entity
`MsgCreateEntity`), so the order says nothing about age: the result says
`orderedBy: 'id (text)'`. An entity's `startDate` is optional and "defined
by the implementer" (x/entity `entity.proto`), so it is not used either.

Validated against `ixo-blocksync-api` `public/graphql/schema.graphql` at
commit `e76c90d` (the file's last change; repo HEAD `375c545`), plus one
bounded live read on mainnet on Oct 29 2026 (claims, token balances,
signed transactions: all answered; see rule 1 for the containment that did
not).

## Retries, timeouts, failures

Both transports (`http.ts`): each attempt is bounded including the body
read — 8 s for REST, 11 s for Blocksync (above its 8 s statement timeout,
so the server's `statement timeout` answer arrives instead of our abort) —
never past the tool's 20 s budget; follows no redirect; reads at most
512 KiB (REST) or 1 MiB (Blocksync). One retry on HTTP 429, 502, 503, 504,
a network error or a transient GraphQL error, after the `Retry-After` the
upstream sent (delta seconds or an HTTP date, capped at 5 s) or, when it
sent none — or one that is zero, in the past or unreadable — after a
uniform 1–3 s, and only when at least 1 s of budget would be left. Never
retried: other 4xx, a 501, a timeout, a body that is not JSON or not the
expected shape, an oversized body, a statement timeout. A turn's abort is
rethrown; everything else is a result.

**Unhealthy upstreams.** A 429 or 503 marks that upstream (its base URL)
for 10 s per isolate: every other call of the isolate answers
`rate_limited` / `unavailable` (retryable) at once instead of asking it.
The call's own retry is still sent, and any answer clears the mark.

A 404 is `unavailable` (not retryable): a wrong route or gateway, never
"nothing there". Only the denom-metadata, denom-trace and channel client-state
reads take a 404 as a miss.
`BLOCKSYNC_GRAPHQL_URL` is checked once per call with `new URL()` (http or
https; the env schema only requires a string because the local harness
serves http): one `fetch` cannot use is `unavailable`, not retryable, and
no request is sent.

| `reason`        | When                                                                                                             | `retryable`                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `rate_limited`  | 429 twice, or the upstream is marked after a 429                                                                 | true                                     |
| `timeout`       | an attempt ran out of time (Blocksync: "narrow the question (fewer rows or requests)")                           | true                                     |
| `index_timeout` | Blocksync's statement timeout for that request                                                                   | false                                    |
| `unavailable`   | 5xx, 404, network, redirect, bad body, a field error, an alias the answer does not carry, no valid Blocksync URL | true for 502–504/network/transient/alias |
| `not_found`     | a by-id read answered null with no error (claim, collection, entity, DID document, transaction)                  | false                                    |
| `too_large`     | the body was over the read limit, or a request was left out to keep the answer small                             | false (ask for it on its own)            |
| `invalid_input` | a field that fails its pattern; no account for the user                                                          | false                                    |

Every failure carries `detail`, one plain sentence the model can relay.
Each failed attempt logs one `console.warn('[ixo-chain] <read> attempt N
failed: <status or error class>')`, and a call answered from an unhealthy
mark logs `<read> not attempted: …` — never a request body or an address.
The expected 404 of those reads is not logged.

## Size

An answer is at most 12,000 JSON characters. After the per-field caps
above, each `ok` result gets an equal share of what the envelope leaves,
smallest result first, a share it does not use passing to the larger ones;
within its share, a result's largest list is halved (its first rows kept)
and the result marked `truncated: true`. If the whole is still over (a
result with nothing left to halve), the **largest** remaining results are
replaced, one at a time, by `too_large`: "Left out to keep the answer
small; ask for it on its own." `get_account_balances` halves its token
list the same way.

## Known limits / follow-ups

- **Missing composite indexes.** Blocksync has no composite index for
  `Claim(agentAddress, submissionDate)`, `TransactionSigner(signerAddress,
transactionId)` or `Message(to, id)`: each read filters on the indexed
  column and sorts what it finds, so an address with a very large history
  can still hit the 8 s statement timeout (`index_timeout`). The indexes
  belong in ixo-blocksync.
- **`totalCount` is a full count.** Every list asks `totalCount`, which
  PostgreSQL computes by counting every matching row per alias, on top of
  the page.
- **On-demand by default.** The plugin is `on-demand`: the model must load
  it (or the capability router preload it) before the tools exist on a
  turn. Companion must set
  `manifestOverrides: { 'ixo-chain': { visibility: 'always' } }` in
  `createOracleWorker` to have them on every turn.
- **Schema footprint.** The `chain_lookup` JSON schema is about 2,750
  characters: ten strict per-kind variants (each with its own `required`
  and `additionalProperties: false`) are most of it. A flat schema would be
  smaller but could no longer reject a field that belongs to another kind.
