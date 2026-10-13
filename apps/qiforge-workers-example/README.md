# qiforge-workers-example

The reference QiForge oracle on Cloudflare Workers (`@ixo/oracle-runtime-workers`) and the home of every local and devnet test drill. Copy it to start a new oracle.

## Files

| Path                                                     | What it is                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                           | The oracle: `createOracleWorker({ config, plugins, routes })` with `BUNDLED_WORKERS_PLUGINS` plus the opt-in `WeatherPlugin`, `SkillsPlugin`, `FlowsPlugin` and `IxoTransactionPlugin`, and `DrillPlugin`. Exports `UserOracleDO` and `MatrixGatewayDO`. |
| `src/config.ts`                                          | `OracleConfig`: name, org, description, prompt.                                                                                                                                                                                                          |
| `src/gateway.ts`                                         | The Matrix gateway as its own Worker script (`createGatewayWorker` from `@ixo/oracle-runtime-workers/gateway`), for the two-script layout.                                                                                                               |
| `src/drill-plugin.ts`                                    | Deliberately slow and large tools for the durable-run and context-budget drills; registered only with `DRILL_TOOLS=true`.                                                                                                                                |
| `wrangler.jsonc`                                         | Single script for local development against the ixo testing harness.                                                                                                                                                                                     |
| `wrangler.devnet.jsonc`, `wrangler.gateway.devnet.jsonc` | The two-script devnet layout (oracle script + gateway script).                                                                                                                                                                                           |
| `.dev.vars.example`                                      | The secrets and local overrides `wrangler dev` reads from `.dev.vars`.                                                                                                                                                                                   |
| `test/`                                                  | Harness e2e drills (`lib/oracle.ts` boots `wrangler dev`, `lib/harness.ts` talks to the harness), the devnet feature matrix (`devnet-features.ts`) and load tests.                                                                                       |

## Scripts

```bash
pnpm dev                     # wrangler dev (wrangler.jsonc)
pnpm deploy                  # wrangler deploy (wrangler.jsonc)
pnpm deploy:devnet           # gateway script, then oracle script
pnpm deploy:devnet:gateway   # gateway script only
pnpm deploy:devnet:oracle    # oracle script only
pnpm typecheck
pnpm cf-typegen              # wrangler types

# Against the local ixo testing harness and a real LLM. Every suite but channels
# boots wrangler dev itself. STEP_FILTER='^regex' runs a subset of the steps of
# test:e2e:durable, :context, :threads, :group, :transcript, :feedback and :pod.
pnpm test:e2e                # auth, streaming, tools, owner copy, E2EE Matrix, resets, tasks
pnpm test:e2e:durable        # durable runs
pnpm test:e2e:context        # context budgets
pnpm test:e2e:threads        # Matrix threads as sessions
pnpm test:e2e:group          # Matrix group rooms
pnpm test:e2e:transcript     # transcript paging
pnpm test:e2e:vfs            # the owner copy in the VFS
pnpm test:e2e:legacy-large   # import of a large Node-era Matrix copy
pnpm test:e2e:tier           # R2 page tier
pnpm test:e2e:mcp            # the MCP plugin path (memory)
pnpm test:e2e:feedback       # anonymous response feedback
pnpm test:e2e:pod            # POD Creator
pnpm test:stress             # concurrent users
pnpm test:e2e:channels --help  # IXO Channels acceptance against a live gateway
pnpm exec tsx test/e2e-migration.ts  # Node → Workers owner-copy migration (also boots the Node oracle)
```

The channels acceptance run needs a deployed gateway, an approved test number and operator checkpoints; see [`docs/testing/channels-acceptance.md`](../../docs/testing/channels-acceptance.md).

## Read next

- [`packages/oracle-runtime-workers/README.md`](../../packages/oracle-runtime-workers/README.md) — the runtime, the deploy steps and the routes.
- [`configuration.md`](../../packages/oracle-runtime-workers/docs/configuration.md) — every variable, binding and migration.
- [`testing.md`](../../packages/oracle-runtime-workers/docs/testing.md) — what each suite proves.
- [`operations.md`](../../packages/oracle-runtime-workers/docs/operations.md) — the runbook.
