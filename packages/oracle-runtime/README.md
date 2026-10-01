# @ixo/oracle-runtime

> # ⚠️ DEPRECATED
>
> **This package — the Node (NestJS) runtime for QiForge oracles — is no longer
> developed.** All QiForge development and every deployed oracle use the
> Cloudflare Workers runtime:
>
> - **[`@ixo/oracle-runtime-workers`](https://www.npmjs.com/package/@ixo/oracle-runtime-workers)**
>   — source in
>   [`packages/oracle-runtime-workers`](https://github.com/ixoworld/qiforge/tree/main/packages/oracle-runtime-workers)
> - Reference Worker:
>   [`apps/qiforge-workers-example`](https://github.com/ixoworld/qiforge/tree/main/apps/qiforge-workers-example)
>
> The plugin API, wire protocol and UCAN authentication carried over, so an
> oracle written against this package ports to `createOracleWorker(...)` with
> the same plugins. See
> [`docs/node-parity.md`](https://github.com/ixoworld/qiforge/blob/main/packages/oracle-runtime-workers/docs/node-parity.md)
> for the behaviours that differ.
>
> This package stays published so existing forks keep installing and building.
> It receives no new features, no parity work and no fixes beyond what a
> security advisory forces. Do not start new oracles on it.

## What this package was

A plugin-based NestJS runtime: `createOracleApp({ config, plugins, nestModules })`
resolved the plugin set, composed the env schema, populated the registries,
bootstrapped NestJS and ran a LangGraph agent per request with per-user Matrix
checkpointing. The internal documentation that describes it lives under
[`docs/`](https://github.com/ixoworld/qiforge/tree/main/docs) in the repository
and is marked deprecated too.
