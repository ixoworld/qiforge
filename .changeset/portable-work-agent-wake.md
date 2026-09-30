---
"@ixo/common": minor
"@ixo/oracle-runtime": patch
"@ixo/oracle-runtime-workers": patch
---

Add provider-neutral PortableWorkDefinition and AgentWake contracts. Task
adapters in both runtimes now expose reusable definition-only work and stable
notify-only wake envelopes without carrying authority, approvals, credentials,
or execution state.
