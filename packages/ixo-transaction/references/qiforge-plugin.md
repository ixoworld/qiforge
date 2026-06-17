# Qiforge Plugin Packaging

`ixo-transaction` exports a Qiforge `OraclePlugin` adapter around the deterministic TypeScript/Zod transaction helpers. The plugin prepares and validates transactions, then dispatches a frontend `sign_transaction` action for the user to sign in the Portal wallet.

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

The root `ixo-transaction` entrypoint exports runtime-neutral validators and signing-action builders. The Qiforge adapter is intentionally isolated in the `/qiforge` subpath.

## Portal frontend registration

Register the hidden signing action inside the Portal oracle UI before sending messages that can use this plugin.

```ts
import { useIxoTransactionSigningAction } from 'ixo-transaction/react';

function OraclePortalChat() {
  useIxoTransactionSigningAction();
  return <Chat />;
}
```

The hook registers the `sign_transaction` websocket action and calls the SDK-provided `transactSignX(messages, memo)` function. It uses `exposeToAgent: false`, so the raw wallet action is not advertised as an agent tool; the exposed path is the validated `sign_ixo_transaction` Qiforge tool.

## Tools

- `list_ixo_transaction_routes`: returns supported `/ixo {message-type} {message-action}` routes, required fields, and risks.
- `classify_ixo_transaction_intent`: resolves slash commands, natural-language prompts, typeUrls, and Msg names.
- `validate_ixo_transaction_draft`: validates and canonicalizes a transaction draft without dispatching wallet signing.
- `sign_ixo_transaction`: validates, risk-gates, mainnet-gates, and dispatches the `sign_transaction` frontend wallet action.

The plugin does not sign, custody keys, or broadcast. It prepares validated messages and hands them to the IXO Portal wallet action for user signing.
