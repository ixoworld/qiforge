---
'@ixo/ixo-transaction': minor
'@ixo/oracle-runtime-workers': minor
---

DAO DAO proposals can now hold the group actions the Portal's Create Proposal block offers whose message has one fixed shape, each written exactly as the Portal's builder writes it: staking (delegate, undelegate, redelegate, claim rewards), a network vote with the group as voter, member changes, the group's details, voting rules, who can propose (2.0.3 intake), sub-DAOs, tracked tokens and NFT collections, stored items, cw20 send / stake / mint, NFT transfer and burn, token swap fund and withdraw, permission grant and revoke, and a contract admin change.

- `@ixo/ixo-transaction`: the proposal action schema accepts the cw `bank`, `staking`, `distribution` and `wasm` (`execute` with one of the known contract messages, `update_admin`) forms beside `stargate`, plus group-only stargate `MsgVote`, `MsgGrant` and `MsgRevoke`; `buildDaoDaoGroupAction`, `daoDaoGroupActionKind`, `daoDaoGroupActionSpec`, `describeProposalAction` and `daoDaoProposalActionList` are new; the Portal encoder writes a contract message as base64 JSON. Arbitrary contract messages, migrate, instantiate, admin exec, authz exec, custom messages and `send_nft` stay refused.
- `@ixo/oracle-runtime-workers`: `create_dao_proposal` takes `groupActions` (plain fields by `type`); the group's own contracts and current settings are read on chain, and a group without the part an action needs answers `refused`. Carry-out previews read these actions back from chain proposals and word them with their risks.
