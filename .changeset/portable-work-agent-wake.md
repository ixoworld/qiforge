---
'@ixo/common': minor
'@ixo/oracle-runtime': patch
'@ixo/oracle-runtime-workers': patch
---

Add provider-neutral PortableWorkDefinition and AgentWake contracts. Task adapters in both runtimes now expose reusable definition-only work and stable notify-only wake envelopes without carrying authority, approvals, credentials, or execution state. Portable definitions reject duplicate list entries and reserved authority, credential and execution-state keys in `configurationDefaults` (exported as `PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS`, matching the Topic Protocol schema), and the Workers adapters validate their output with the schemas before returning it.
