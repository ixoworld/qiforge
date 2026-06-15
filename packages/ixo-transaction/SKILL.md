---
name: ixo-transaction
description: Configure, validate, and render IXO blockchain transaction messages for IXO Portal signing. Use this skill when a user asks to create, update, transfer, grant, revoke, submit, evaluate, mint, retire, register, or otherwise prepare an IXO chain transaction, including slash commands like `/ixo entity create` or natural language like "create a new domain". The skill maps user intent to canonical IXO `Msg` types, collects missing parameters, validates values with TypeScript/Zod schemas, reports risks and failure modes, requires explicit confirmation before risky signing, defaults to Pandora testnet before mainnet, and outputs Portal `signxTransaction` payloads.
---

# IXO Transaction

Use this skill to turn user intent into validated IXO transaction messages for the IXO Portal signing flow. The skill prepares messages only; Portal wallet, backend routes, SignX, passkeys, Auth Hub, and broadcast handling remain responsible for signing and execution.

## Workflow

1. Identify the transaction from either slash command or natural language.
   - Slash command format is `/ixo {message-type} {message-action}`, for example `/ixo entity create`.
   - Treat `/IXO` as equivalent when the host command layer is case-insensitive.
   - Normalize common aliases and typos, including `megCreateEntity`, `msgCreateEntity`, and `createEntity` to `MsgCreateEntity`.
2. Load `references/intent-routing.md` when intent is ambiguous, when adding a new alias, or when explaining command syntax.
3. Validate all transaction parameters with the TypeScript helpers before producing a signing payload.
   - Use `npm run validate -- '<json>'` for validation and canonicalization.
   - Use `npm run render -- '<json>'` only after all required parameters are present and risk confirmation has been obtained.
4. Report risks before rendering a signing payload. Load `references/risk-policy.md` when the transaction moves funds, changes ownership, grants authority, evaluates claims, verifies entities, or targets mainnet.
5. Default to Pandora testnet before mainnet.
   - Mainnet drafts require a successful testnet receipt unless the user explicitly overrides the testnet step.
   - Record any override in the response.
6. Output the core Portal signing payload:

```json
{
  "type": "signxTransaction",
  "messages": [
    {
      "typeUrl": "/ixo.entity.v1beta1.MsgCreateEntity",
      "value": {}
    }
  ],
  "memo": "optional memo"
}
```

Only wrap the payload with `protocol: "ixo.portal.iframe.v1"` when the caller explicitly needs a full iframe `EVENT` message for `postMessage` transport.

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
- `src/render.ts`: Core Portal `signxTransaction` rendering.
- `src/iframe.ts`: Optional iframe envelope rendering.
- `src/qiforge/`: Qiforge `OraclePlugin` adapter and tool exports.

## Validation Rules

Reject the draft when:

- The slash command is not `/ixo {message-type} {message-action}`.
- The module/action pair is unsupported or query-only.
- `typeUrl` conflicts with the resolved command intent.
- A required field is absent.
- An unknown field is present.
- A DID, `ixo1` address, timestamp, oneof, integer field, or `uixo` amount has the wrong shape.
- A mainnet draft lacks both a successful testnet receipt and an explicit override.
- Rendering is requested for a risky transaction without explicit risk confirmation.

## References

- `references/intent-routing.md`: command format, aliases, and intent examples.
- `references/risk-policy.md`: risk categories and confirmation language.
- `references/ixo-message-catalog.json`: human-readable summary of supported message routes.
- `references/qiforge-plugin.md`: Qiforge registration and plugin tool surface.
