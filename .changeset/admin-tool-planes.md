---
"@ixo/oracle-runtime": minor
"@ixo/oracle-runtime-workers": minor
---

Split agent-facing tools into orchestration and explicitly delegated admin planes. Admin tools are hidden from capability discovery and model binding unless the acting principal has the tool-specific UCAN, and the same authorization is enforced again at invocation.
