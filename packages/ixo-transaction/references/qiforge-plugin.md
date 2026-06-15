# Qiforge Plugin Packaging

`ixo-transaction` exports a Qiforge `OraclePlugin` adapter around the deterministic TypeScript/Zod transaction helpers.

## Install

Inside the Qiforge monorepo, add the workspace package to an oracle app with pnpm.

```bash
pnpm add ixo-transaction@workspace:* --filter <oracle-app>
```

The package declares `@ixo/oracle-runtime` as a peer dependency. Qiforge should provide the runtime version.

## Register

```ts
import { createOracleApp } from '@ixo/oracle-runtime';
import { IxoTransactionPlugin } from 'ixo-transaction/qiforge';

const app = await createOracleApp({
  config,
  plugins: [new IxoTransactionPlugin()],
});
```

The root `ixo-transaction` entrypoint exports runtime-neutral validators and renderers. The Qiforge adapter is intentionally isolated in the `/qiforge` subpath.

## Tools

- `list_ixo_transaction_routes`: returns supported `/ixo {message-type} {message-action}` routes, required fields, and risks.
- `classify_ixo_transaction_intent`: resolves slash commands, natural-language prompts, typeUrls, and Msg names.
- `validate_ixo_transaction_draft`: validates and canonicalizes a transaction draft without rendering a signing payload.
- `render_ixo_transaction_payload`: renders the core Portal `signxTransaction` payload, or the optional iframe `EVENT` wrapper when `iframe: true`.

The plugin does not sign, custody keys, or broadcast. It prepares validated messages for the IXO Portal wallet and backend routes.
