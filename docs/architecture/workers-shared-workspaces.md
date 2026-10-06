# Shared workspace execution boundaries

The workspace is a projection of existing Domain, Project, Topic, Flow and VFS relationships. Execution stays in each requester's `UserOracleDO`. Shared rooms never carry model checkpoints, private memory or credentials. Matrix membership determines an audience; it does not grant a UCAN capability or VFS access.

## Approval and uncertain effects

Background task approvals name an exact `approvalRequest.id`, input digest and occurrence. The scheduler persists the request before sending its Matrix message. Delivery retries retain the same request and transaction ID. Edits invalidate pending and approved requests. Timestamp-only approvals from earlier versions are reissued on load. The approved request is checked again when the run ledger opens.

`resolve_task_approval` requires `approvalRequestId`; `ctx.tasks.resolveApproval` rejects a missing or stale ID. The authenticated requester's task surface supplies the actor; the model cannot substitute another principal.

An unresolved write claim retains its originating run and survives run retention. A different turn does not authorize replay. The owner inspects `GET /write-reconciliations`, then submits a signed invocation to `POST /write-reconciliations/:fingerprint` with `{ expectedRunId, evidenceRef, outcome, authorizeRetry }`. Outcomes are `applied`, `not-applied` and `unknown`. Only an explicit `not-applied` attestation with `authorizeRetry: true` releases the exact claim. Repeated evidence references are immutable and conflicts are refused. This records a human or host attestation and its evidence pointer; it does not independently verify the provider's state. Provider-internal retry behavior requires a separate control.

## Sandbox credentials and effects

Sandbox definition discovery sends no user or operator tool secrets. Execution reads only names selected by `SandboxPlugin.selectCredentials`, or the operator's comma-separated `SANDBOX_USER_SECRET_NAMES` and `SANDBOX_ORACLE_SECRET_NAMES`. The default selection is empty. Existing runtime-only model and OAuth credential filtering still applies. Selection happens at the authenticated execution boundary; credentials never appear in tool schemas, manifests or artifact receipts.

MCP annotations pass through adaptation and definition caches. `readOnlyHint: false` takes precedence over a read-looking tool name. Missing metadata remains conservative. Idempotent hints do not authorize replay of an unknown external effect.

## Release evidence

Local workerd tests exercise the real scheduler, SQLite store, approval recovery and run ledger. Their fake gateway and agent implementations are not evidence of a live Matrix, model, sandbox or VFS deployment. Release acceptance additionally requires two authenticated people, revocation, exact VFS versions, real sandbox replacement and canonical Topic publication under each reviewer's own authority.
