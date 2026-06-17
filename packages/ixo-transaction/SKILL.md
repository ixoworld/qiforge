---
name: ixo-transaction
description: Configure, validate, and dispatch IXO blockchain transaction messages to the IXO Portal wallet. Use this skill when a user asks to create, update, transfer, grant, revoke, submit, evaluate, mint, retire, register, or otherwise prepare an IXO chain transaction, including slash commands like `/ixo entity create` or natural language like "create a new domain". The skill maps user intent to canonical IXO `Msg` types, collects missing parameters, validates values with TypeScript/Zod schemas, reports risks and failure modes, requires explicit confirmation before risky signing, defaults to Pandora testnet before mainnet, and dispatches a frontend `sign_transaction` action for user wallet signing.
---

# IXO Transaction

Use this skill to turn user intent into validated IXO transaction messages for the IXO Portal signing flow. The skill prepares and validates messages only; the Portal wallet, backend routes, SignX, passkeys, Auth Hub, and broadcast handling remain responsible for signing and execution.

## Workflow

1. Identify the transaction from either slash command or natural language.
   - Slash command format is `/ixo {message-type} {message-action}`, for example `/ixo entity create`.
   - Treat `/IXO` as equivalent when the host command layer is case-insensitive.
   - Normalize common aliases and typos, including `megCreateEntity`, `msgCreateEntity`, and `createEntity` to `MsgCreateEntity`.
2. Load `references/intent-routing.md` when intent is ambiguous, when adding a new alias, or when explaining command syntax.
3. Validate all transaction parameters with the TypeScript helpers before dispatching a signing action.
   - Use `npm run validate -- '<json>'` for validation and canonicalization.
   - Use `npm run render -- '<json>'` only after all required parameters are present and risk confirmation has been obtained; this emits the validated `sign_transaction` action arguments.
4. Report risks before dispatching the wallet action. Load `references/risk-policy.md` when the transaction moves funds, changes ownership, grants authority, evaluates claims, verifies entities, or targets mainnet.
5. Default to Pandora testnet before mainnet.
   - Mainnet drafts require a successful testnet receipt unless the user explicitly overrides the testnet step.
   - Record any override in the response.
6. Dispatch signing through the Qiforge/Portal AG-UI round trip:

```json
{
  "action": "sign_transaction",
  "messages": [
    {
      "typeUrl": "/ixo.entity.v1beta1.MsgCreateEntity",
      "value": {}
    }
  ],
  "memo": "optional memo"
}
```

Portal must register `useIxoTransactionSigningAction()` from `ixo-transaction/react`. This registers the `sign_transaction` wallet handler for websocket execution without advertising it as a raw agent tool.

## TypeScript Helpers

Run commands from this skill folder:

```bash
npm run validate -- '{"command":"/ixo entity create","value":{...}}'
npm run render -- '{"command":"/ixo entity create","value":{...},"riskConfirmation":{"confirmed":true,"acceptedRisks":["..."]}}'
npm test
```

Important source files:

- `src/schemas.ts`: Zod schemas and inferred TypeScript types.
- `src/catalog.ts`: Canonical message catalog for tx-capable IXO modules.
- `src/intent.ts`: Slash-command and natural-language routing.
- `src/validate.ts`: Strict transaction validation and risk/mainnet gating.
- `src/action.ts`: Canonical `sign_transaction` action args and wallet result normalization.
- `src/qiforge/`: Qiforge `OraclePlugin` adapter and tool exports.
- `src/react/`: Portal hook that registers the hidden wallet signing action.

## Validation Rules

Reject the draft when:

- The slash command is not `/ixo {message-type} {message-action}`.
- The module/action pair is unsupported or query-only.
- `typeUrl` conflicts with the resolved command intent.
- A required field is absent.
- An unknown field is present.
- A DID, `ixo1` address, timestamp, oneof, integer field, or `uixo` amount has the wrong shape.
- A mainnet draft lacks both a successful testnet receipt and an explicit override.
- Signing action dispatch is requested for a risky transaction without explicit risk confirmation.

## References

- `references/intent-routing.md`: command format, aliases, and intent examples.
- `references/risk-policy.md`: risk categories and confirmation language.
- `references/ixo-message-catalog.json`: human-readable summary of supported message routes.
- `references/qiforge-plugin.md`: Qiforge registration and plugin tool surface.
