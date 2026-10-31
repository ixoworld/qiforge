---
'@ixo/oracle-runtime-workers': patch
---

Coins and impact tokens can go to a group's own address (`@ixo/action-protocol` 0.9.1): `cosmos.bank.send` `toAddress` and `ixo.token.transfer` `recipient` accept a 32-byte contract address as well as an account, at top level and inside a group proposal's actions, and the send rule tells the model to find the group's address with `chain_lookup daos` or `dao_proposals` ("Send 2 IXO to the Auth Hub drill group."). Deploy after Auth Hub is on 0.9.1: an Auth Hub on 0.9.0 refuses such a recipient with the field named.
