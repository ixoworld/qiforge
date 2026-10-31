---
'@ixo/oracle-runtime-workers': minor
---

Chain transaction cards: 29 more message types (`@ixo/action-protocol` 0.8.0, Hub protocol version 6). `request_chain_transaction` can now prepare staking (stake, unstake, move stake, claim rewards), a governance vote, retiring impact tokens, claim reservations and disputes, claim collection changes and permissions, creating a collection, entity accounts, updates, permissions and creation, and identity-record links. Stake amounts are given in IXO and converted with 6 decimals (a stake counts against the listed IXO balance); the owner's own DID is filled into every message that needs it. The tool is built per turn from the types the account may use (four on a level-5 Hub, all 33 on a level-6 one), and every type's rules tell the model to describe the card in plain everyday words.

Deploy after Auth Hub and the channel gateways move to protocol 0.8.0. Against an Auth Hub still on version 5 the runtime speaks version 5 (every Hub action keeps working; only the 0.6.0 chain types are offered) and asks for 6 again every 10 minutes. The chain transaction tool's capabilities read on a turn has a 3 s timeout, is not repeated within 30 s of a failure, and falls back to the last good answer; with none, the tool is not offered. A new `validators` chain lookup lists the validators someone can stake with, so a person can name one in words.
