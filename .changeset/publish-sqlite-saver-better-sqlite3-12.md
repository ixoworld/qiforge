---
'@ixo/sqlite-saver': minor
---

Move to `better-sqlite3@^12.9.0` and publish, so downstream oracles stop loading
two native SQLite addons.

The pin was corrected in the monorepo, but `@ixo/sqlite-saver` was never
republished — npm still serves `1.2.0` declaring `^11.10.0`. Because
`@ixo/oracle-runtime` depends on it via `workspace:*`, its published manifest
pins the saver exactly, so every consumer of `@ixo/oracle-runtime@1.92.0`
installed the 12.x addon for the runtime **and** the 11.x addon for the saver.

Two addons in one process means two statically linked SQLite builds and two
`Addon::Cleanup` environment hooks. `Environment::GetCurrent(isolate)` returns
`nullptr` inside V8's second-pass GC weak callbacks, so finalizing a `Statement`
from the 11.x addon aborted the process with
`RemoveEnvironmentCleanupHook: Assertion failed: (env) != nullptr`. It surfaced
most often under the credits settlement cron, whose `SqliteSaver.fromConnString`
call is the only path that creates objects inside that addon.

Publishing this release lets consumers drop the `better-sqlite3` override they
currently need as a workaround.
