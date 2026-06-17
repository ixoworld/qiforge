# Risk Policy

Before dispatching a wallet signing action, disclose concrete risks and get explicit confirmation from the user. A confirmation must say that the user accepts the listed risks.

## High-Risk Categories

| Category            | Examples                                       | Confirmation focus                                                                         |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Entity creation     | `/ixo entity create`                           | Entity DID is chain-derived; relayer node and owner fields must be correct.                |
| Ownership transfer  | `/ixo entity transfer`, `/ixo names transfer`  | Ownership or control changes may be irreversible.                                          |
| Entity verification | `/ixo entity update-verified`                  | Only the relayer node should verify or unverify an entity.                                 |
| DID control         | IID controllers and verification methods       | Wrong controllers or keys can lock users out or grant unwanted control.                    |
| Authz grants        | Entity account grants and claim authorizations | Grantee, expiration, message scope, and constraints must be intentional.                   |
| Claims              | Submit, evaluate, dispute, adjudicate          | Claim status and payment effects can trigger external workflows.                           |
| Tokens and credits  | Mint, transfer, retire, cancel, pause, stop    | Funds or impact credits can move or burn permanently. Amounts must be integer micro-units. |
| Bonds and staking   | Bonds, liquidstake                             | Economic positions and staking state can change. Confirm pool, validator, and amount.      |
| Mainnet             | Any mainnet wallet signing action              | Pandora testnet should succeed first unless explicitly overridden.                         |

## Required Confirmation

Dispatching a wallet signing action requires:

```json
{
  "riskConfirmation": {
    "confirmed": true,
    "acceptedRisks": ["specific risk text reviewed with the user"]
  }
}
```

For mainnet without a testnet receipt, also require:

```json
{
  "overrideMainnet": true,
  "overrideReason": "User explicitly requested mainnet without testnet execution."
}
```

## Failure Modes to Report

- Wrong `typeUrl` or unsupported Portal registry type.
- Wrong signer address or DID.
- Missing relayer node, missing entity, missing namespace, missing collection, or missing grant.
- Decimal token amounts instead of integer chain units.
- Timestamps outside the intended validity window.
- Partial entity updates that unintentionally overwrite fields.
- Any transaction that can succeed on testnet but fail on mainnet because references differ by network.
