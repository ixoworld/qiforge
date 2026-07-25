---
'@ixo/oracle-runtime': minor
---

Add Codex as a first-class provider, integrated through the Codex App Server.

The bundled `codex` plugin delegates coding tasks to a user's Codex runtime over the App Server's bidirectional JSON-RPC boundary — no UI automation and no credential reuse. Two auth modes are supported and never fall back to one another: ChatGPT sign-in for subscription-backed access, and an OpenAI API key for usage-based access. `CODEX_AUTH_MODE` is required with no default, so the billing model is always an explicit operator choice.

Approvals Codex raises mid-turn block until a human answers, via an `action_call` event plus `POST /codex/approvals` or the `codex_resolve_approval` tool; unanswered approvals expire to `decline`. Sessions, credentials, `CODEX_HOME` directories and threads are scoped per tenant, and every connection transition is recorded in an auditable trail exposed at `GET /codex/transitions`.
