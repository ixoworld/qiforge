# Intent Routing

Use this reference when mapping user intent to an IXO transaction route.

## Slash Commands

Canonical format:

```text
/ixo {message-type} {message-action}
```

Examples:

| Command                                | Canonical message                               |
| -------------------------------------- | ----------------------------------------------- |
| `/ixo entity create`                   | `/ixo.entity.v1beta1.MsgCreateEntity`           |
| `/ixo entity transfer`                 | `/ixo.entity.v1beta1.MsgTransferEntity`         |
| `/ixo iid add-linked-resource`         | `/ixo.iid.v1beta1.MsgAddLinkedResource`         |
| `/ixo claims submit`                   | `/ixo.claims.v1beta1.MsgSubmitClaim`            |
| `/ixo token retire`                    | `/ixo.token.v1beta1.MsgRetireToken`             |
| `/ixo names register`                  | `/ixo.names.v1beta1.MsgRegisterName`            |
| `/ixo smart-account add-authenticator` | `/ixo.smartaccount.v1beta1.MsgAddAuthenticator` |

Treat `/IXO` as equivalent if the host command layer is case-insensitive.

## Natural Language

Resolve common phrases deterministically:

| User phrase                           | Route                                  |
| ------------------------------------- | -------------------------------------- |
| "create a new domain"                 | `/ixo entity create`                   |
| "create an oracle entity"             | `/ixo entity create`                   |
| "transfer this domain to another DID" | `/ixo entity transfer`                 |
| "attach a linked resource"            | `/ixo iid add-linked-resource`         |
| "submit a claim"                      | `/ixo claims submit`                   |
| "evaluate a claim"                    | `/ixo claims evaluate`                 |
| "retire credits"                      | `/ixo token retire`                    |
| "register a name"                     | `/ixo names register`                  |
| "add a smart account authenticator"   | `/ixo smart-account add-authenticator` |

Normalize these aliases and typos:

- `megCreateEntity`, `msgCreateEntity`, `createEntity` -> `/ixo entity create`
- `domain` -> `entity` when used as a message type
- `did` -> `iid` when used as a message type
- `credit` or `credits` -> `token` when used as a message type
- `smartaccount` -> `smart-account`

When more than one route is plausible, ask for the slash command form instead of guessing.
