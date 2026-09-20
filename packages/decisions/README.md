# QiForge Decisions

A bounded semantic evaluation returns probabilities over declared answers. It does not approve spending, grant a capability, start an engagement, sign an IXO determination, or prove settlement. The host owns those policies and authorities.

This package is the shared implementation used by `@ixo/common`, `@ixo/oracle-runtime` and `@ixo/oracle-runtime-workers`. It depends only on Zod and Web APIs. Existing Node imports remain compatibility exports; Workers never imports the Node runtime.

- `@ixo/decisions`: definitions, validation, evaluator and turn-scoped cancellation.
- `@ixo/decisions/providers`: Cloudflare and OpenRouter Jev adapters.
- `@ixo/decisions/config`: host environment provider selection.

See the [Workers configuration and operating contract](../oracle-runtime-workers/docs/decisions.md). This new package must be published before the updated runtime packages can be installed outside the workspace.
