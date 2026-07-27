# Codex — setup

Connects an oracle to a user's OpenAI Codex runtime through the Codex App Server.

Framework internals and design rationale: [`docs/architecture/codex-provider.md`](../../../../../docs/architecture/codex-provider.md).

## Prerequisites

The `codex` CLI must be installed and on `PATH` wherever the oracle runs (override with `CODEX_APP_SERVER_COMMAND`).

## Choose an auth mode

`CODEX_AUTH_MODE` is required and has no default — the mode decides how the user's Codex usage is billed, so the runtime will not pick one for you. The plugin stays off until it is set.

**`chatgpt_subscription`** — _"Use ChatGPT sign-in for Codex subscription access."_
The user's ChatGPT plan covers Codex runtime usage. It does **not** grant direct OpenAI API access.

Sign in once per user, against that user's `CODEX_HOME`:

```bash
CODEX_HOME=<CODEX_HOME_ROOT>/<oracleDid>__<userDid> codex login
```

The tenant directory name is a sanitized `<oracleDid>::<userDid>` prefix followed by a `-` and a 16-character digest of the exact pair (the digest is what stops two different DIDs sanitizing to the same directory). Read the exact value from `GET /codex/status` — it is reported as `tenant`. `GET /codex/status` shows `requires_sign_in` until the sign-in completes.

**`api_key`** — _"Use an API key for usage-based OpenAI access."_
Turns are billed per token. The user stores an `OPENAI_API_KEY` secret in their oracle room (rename via `CODEX_API_KEY_SECRET_NAME`); the key is read from the encrypted secret store at connect time and never leaves the process. The runtime registers it with the App Server through `account/login/start` — the server does not pick a key up from its environment.

## Environment variables

| Variable                       | Default          | Purpose                                                 |
| ------------------------------ | ---------------- | ------------------------------------------------------- |
| `CODEX_AUTH_MODE`              | — (required)     | `chatgpt_subscription` or `api_key`.                    |
| `CODEX_APP_SERVER_COMMAND`     | `codex`          | Binary to spawn.                                        |
| `CODEX_APP_SERVER_ARGS`        | `app-server`     | Space-separated argv.                                   |
| `CODEX_HOME_ROOT`              | `.codex-tenants` | Parent of the per-tenant `CODEX_HOME` directories.      |
| `CODEX_WORKSPACE_ROOT`         | `process.cwd()`  | Directory Codex threads are rooted at.                  |
| `CODEX_MODEL`                  | —                | Model override. Ignored under a subscription.           |
| `CODEX_REASONING_EFFORT`       | `medium`         | `low` / `medium` / `high`.                              |
| `CODEX_SANDBOX_MODE`           | `read-only`      | `read-only` / `workspace-write` / `danger-full-access`. |
| `CODEX_APPROVAL_POLICY`        | `on-request`     | `untrusted` / `on-request` / `never`.                   |
| `CODEX_API_KEY_SECRET_NAME`    | `OPENAI_API_KEY` | Secret holding the key in `api_key` mode.               |
| `CODEX_STARTUP_TIMEOUT_MS`     | `30000`          | Handshake and thread-call timeout.                      |
| `CODEX_TURN_TIMEOUT_MS`        | `600000`         | Per-turn timeout.                                       |
| `CODEX_MAX_RECONNECT_ATTEMPTS` | `3`              | Reconnects after an App Server crash.                   |

`CODEX_SANDBOX_MODE=danger-full-access` together with `CODEX_APPROVAL_POLICY=never` is rejected at boot: that pair removes both guardrails at once.

These enum values are the App Server's own wire spellings, verified against `codex-cli 0.145.0` — anything else is rejected with `unknown variant`.

## Control plane

All routes are UCAN-authenticated and scoped to the calling user.

| Route                    | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `GET /codex/status`      | Provider descriptor, connection status, resolved capabilities.     |
| `POST /codex/connect`    | Start or re-authorize the runtime.                                 |
| `POST /codex/disconnect` | Stop it.                                                           |
| `POST /codex/auth-mode`  | Switch mode. Explicit — never inferred.                            |
| `GET /codex/transitions` | Audit trail of connection transitions.                             |
| `GET /codex/approvals`   | Approvals Codex is blocked on.                                     |
| `POST /codex/approvals`  | Answer one (`accept` / `acceptForSession` / `decline` / `cancel`). |

## Approvals

When Codex wants to run a command or change a file, the turn blocks and an `action_call` event (`codex.approval.required`) is emitted. Answer it via `POST /codex/approvals`, or let the agent relay a decision the user gave in chat via the `codex_resolve_approval` tool.

Unanswered approvals expire to `decline` after five minutes. Nothing is ever auto-approved.

## Tools

- `codex_run_task` — hand Codex a coding task; returns its output, or an actionable auth status.
- `codex_resolve_approval` — relay a user's approval decision.
