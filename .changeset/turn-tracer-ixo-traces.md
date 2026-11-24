---
'@ixo/oracle-runtime-workers': minor
---

IXO Traces turn tracer: with `TRACES_API_KEY` and a `TRACES` service binding (or `TRACES_ENDPOINT`), every agent turn is collected through LangChain's `BaseTracer` and sent once, gzipped, to IXO Traces after the reply (`ctx.waitUntil`), with a start marker when it begins. Adds `oracle_did`, `network`, `channel`, `runtime_version`, `request_id`, the served model and a fallback flag; usage comes from the same call records as `onModelCall`. Never blocks or fails a turn; failures are counted and logged without content. Off when not configured; LangSmith tracing is unchanged and independent.
