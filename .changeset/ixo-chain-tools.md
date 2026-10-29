---
'@ixo/oracle-runtime-workers': minor
---

User identity in the system prompt; new bundled `ixo-chain` read-only chain tools.

- Every system prompt, and every sub-agent prompt, now names the user's DID and their IXO account address (the suffix of a `did:ixo:ixo1…` DID, or none for a `did:key:` / `did:web:` user) and says that the oracle's own DIDs are never the user's.
- `hub_action_options` also returns `ownerAddress`, the user's IXO account address beside `ownerDid`.
- `IxoChainPlugin` (in `BUNDLED_WORKERS_PLUGINS`, on-demand, left out with `IXO_CHAIN_TOOLS=off`) adds `get_account_balances` (live bank balances from the chain REST gateway, each denom shown through the chain's own bank metadata: `uixo` as IXO, any other denom verified only when its metadata lists its display unit) and `chain_lookup` (up to 8 claim, collection, entity, DID document, 1155 token balance and transaction reads in one Blocksync request, each answering on its own). Account fields default to the user's own address; failures come back as results with a reason and whether to retry. New optional `CHAIN_REST_URL` (defaults per `NETWORK`).
