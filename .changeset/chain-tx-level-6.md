---
'@ixo/oracle-runtime-workers': minor
---

Chain transaction cards: 29 more message types (`@ixo/action-protocol` 0.8.0, Hub protocol version 6). `request_chain_transaction` can now prepare staking (stake, unstake, move stake, claim rewards), a governance vote, retiring impact tokens, claim reservations and disputes, claim collection changes and permissions, creating a collection, entity accounts, updates, permissions and creation, and identity-record links. Stake amounts are given in IXO and converted with 6 decimals (a stake counts against the listed IXO balance); the owner's own DID is filled into every message that needs it. The tool is built per turn from the types the account may use (four on a level-5 Hub, all 33 on a level-6 one), and every type's rules tell the model to describe the card in plain everyday words.

Needs Auth Hub on protocol 0.8.0 (it answers `?version=6`) and channel gateways on 0.8.0 before this runtime is deployed; an older Hub makes every Hub action answer that Auth Hub must be updated.
