# Testing

Four layers, from milliseconds to minutes. Run the targeted layer while
iterating and the full matrix once at the end.

## Unit tests (seconds)

- `pnpm test` — runs **inside workerd** through `@cloudflare/vitest-pool-workers`
  (`vitest.config.ts`, test worker in `test/worker.ts`, bindings in
  `test/wrangler.test.jsonc`): the SQLite VFS and saver (20 MiB files,
  eviction survival, legacy-file load), the ingest pipeline, reply chains,
  the room-state codec, the task scheduler over real SQLite, the socket.io
  endpoint over real WebSockets, the shell, and the editor and flows plugin
  suites that must prove the linkedom bridge on the real runtime.
- `pnpm test:core` — plain-Node suites (`vitest.core.config.ts`): plugin
  loader, env composition, registries, middlewares, prompt composer, a full
  tool-calling turn against a fake model, the memory indexer, and the
  bundled-plugin tests that mock the MCP and Composio SDKs.
- `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` at the repo root.

The Matrix gateway has no unit tests here any more: its generic behaviour is
tested in `@ixo/matrix-bot-workers-sdk`; the oracle-specific parts are
covered by the devnet matrix below.

## Harness end-to-end (minutes, local)

From `apps/qiforge-workers-example`, against the ixo testing harness and a
real LLM:

| Script                       | Covers                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:e2e`              | Auth, streaming, tools, memory, transcript, abort, owner-copy round-trip, E2EE chat, device-stable restart, a live scheduled task fired by a DO alarm.                                                                                                                    |
| `pnpm test:e2e:vfs`          | The default owner-store path: a real VFS worker, the user's delegation carrying `ixo:filesystem/.oracles`, flush → file in the user's VFS → reload, Matrix untouched, 403 without the capability.                                                                         |
| `pnpm test:e2e:mcp`          | A real Streamable-HTTP MCP handshake from workerd with per-user UCAN headers, cross-session memory recall.                                                                                                                                                                |
| `pnpm test:e2e:legacy-large` | A ≥ 64 MB gzipped Node-era Matrix checkpoint (synthetic, saver schema, uploaded as the bot from a second device) imported on the VFS path: streamed in, flushed to the VFS, legacy copy redacted, workerd's memory growth bounded by the file, the seeded session listed. |
| `test/e2e-migration.ts`      | Node → Workers migration of a user's history including the key backup and a token rotation.                                                                                                                                                                               |
| `pnpm test:stress`           | N users concurrently, per-user isolation checks.                                                                                                                                                                                                                          |

## The devnet feature matrix (minutes, deployed worker)

`apps/qiforge-workers-example/test/devnet-features.ts` drives the deployed
worker through every feature: health, auth, models, delegation, sessions,
streaming and JSON turns, transcript, thread memory, titles, abort,
memory-engine, sandbox, skills, flows, VFS round-trip, firecrawl and
domain-indexer sub-agents, per-room secrets, the owner-store flush plus
reset/reload, E2EE Matrix ingress, scheduled tasks including a dedicated
room, HTTP and Matrix attachments with payload retention, user preferences,
the Node room-state envelope, the socket.io channel (handshake, browser tool
and AG-UI round trips, `create_page_room` with the CRDT edit replayed),
gateway restarts (catch-up, creates during a restart), the validation and
auth-boundary edge cases, cross-user isolation and the per-user rate limit.

```bash
cd apps/qiforge-workers-example
ACCOUNT_JSON=<account.json> [ORACLE_URL=https://…] pnpm exec tsx test/devnet-features.ts
# one step or a group:
STEP_FILTER='^gateway restart' ACCOUNT_JSON=… pnpm exec tsx test/devnet-features.ts
```

- Accounts live in the gitignored `test/.devnet-accounts/` (override with
  `SCRATCH_DIR`): the main user in `devnet-account.json` (or `ACCOUNT_JSON`),
  each a devnet test account (`did`, `address`, `edSigningMnemonic`,
  `matrixUserId`, `matrixPassword`, `roomId`) created with the testing
  harness's `devnet-mig-account.mjs`. Two more are read from the same
  directory: `devnet-user-2.json` as the "other user" and `devnet-user-6.json`
  as the user whose delegation lacks the file-storage capability — never
  give that one a delegation carrying `ixo:filesystem`, or a working copy.
- A full run takes 15–20 minutes; split it with `STEP_FILTER` when a shell
  or CI step has a shorter limit. Some steps depend on earlier ones in the
  same run (the edge steps need "edge: create a scratch session"; the
  cross-user step needs the scratch session) — filter groups, not single
  steps, for those.
- Failures print the assertion and, for transport errors, the underlying
  cause. A single "fetch failed" from the client machine is not a runtime
  failure; re-run the step.

## Stress (minutes, deployed worker)

The load scripts are in `test/load/` and read the accounts from
`test/.devnet-accounts/` (`stress-users.mts`; `outbox-probe.mts`; the BYO
lane end-to-end scripts; `delete-stale-devices.py` to retire the bot's stale
devices). `stress-users.mts` phases: 1 = everyone
creates sessions at once, 2 = everyone runs N turns in parallel, 2b = half
the users create sessions while the other half chat, 3 = synchronized
bursts, 4 = reads. `PHASES=2,2b TURNS=4` is the quick run; the numbers to
compare are in [load tests](load-tests.md). Watch the gateway alongside:

```bash
pnpm exec wrangler tail <gateway script> --format json > tail.jsonl
GET /matrix/status   # instanceId unchanged, sendScheduler.failed 0, rateLimited 0
```

## Reproduction objects

`test/hibernation-probe/` holds a minimal Durable Object plus its wrangler
config for checking whether an MCP round trip leaves an object resident:
deploy it with that config, call `/mcp-opt/timeout` vs `/mcp-opt/own`, and
compare `instanceId` after 45 s idle. Delete the deployed copy afterwards.
