---
'@ixo/oracle-runtime-workers': minor
---

Bind scheduled task approvals to the exact inputs and occurrence. Approve or reject through a signed owner action, retain an audit receipt, and recover pending Matrix approval delivery across a restart. Model tools can inspect approval requests but cannot approve themselves or remove an existing approval gate.

Keep uncertain external writes blocked until the owner records reconciliation evidence. Sandbox discovery forwards no tool secrets; execution forwards only host-selected credential names and preserves runtime credential filtering. Deployments that relied on implicit sandbox secret forwarding must configure the required names.
