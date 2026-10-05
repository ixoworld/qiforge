# Oracle interaction lifecycle (Workers)

This contract is shared by the Workers Matrix gateway, per-user durable runs, and personal-chat SDK. The Node runtime is outside this change.

## Signals and engagement

| State                     | Reaction | Meaning                                                                     |
| ------------------------- | -------- | --------------------------------------------------------------------------- |
| `seen`                    | 👀       | Identity and existing engagement checks passed.                             |
| `accepted`                | 👍       | The request has been recorded as a durable run.                             |
| `working`                 | 👍       | The run is executing; native typing conveys room activity.                  |
| `waiting`                 | ⏸️       | Host code explicitly requires input or approval.                            |
| `completed`               | ✅       | An ordinary reply completed successfully.                                   |
| `achieved`                | 🎉       | Host code confirmed a persisted artefact or verified task outcome.          |
| `failed`                  | ⚠️       | Execution failed, delivery is unconfirmed, or a write outcome is uncertain. |
| `cancelled`, `superseded` | ⏹️       | Execution stopped or a newer request replaced it.                           |

Group intake keeps the existing mention, reply-to-oracle, and active-thread gate. It emits seen after identity and engagement checks, before the turn semaphore. A gate lookup failure retains the existing fallback execution policy but suppresses lifecycle signals because engagement could not be verified. An attachment batch uses its request's latest text event as the reaction source and retains the original event ID for ledger/reply deduplication.

`OracleConfig.interactions?: { enabled?: boolean }` defaults to enabled. For a separate gateway, `createGatewayWorker({ interactions: { enabled: false } })` disables gateway signals too. Apply the same setting to both deployments when opting out.

## Public stream and message contract

`@ixo/oracles-events/interactions` exports `OracleInteraction`, `InteractionState`, the emoji mapping, and a whitelist parser. A durable SSE frame has event `interaction` and this payload:

```ts
interface OracleInteraction {
  sessionId: string;
  requestId: string;
  runId?: string;
  oracleDid: string;
  oracleUserId: string;
  oracleName: string;
  roomId?: string;
  sourceEventId?: string; // Confirmed $event ID, never an outbox transaction token.
  threadId?: string;
  state: InteractionState;
  revision: number;
  updatedAt: string;
}
```

The SDK adds optional `requestId`, `matrixEventId`, and `interaction` to human messages. It associates the optimistic message with the request before consuming frames. Updates are applied to the originating chat instance, reject another session/oracle and old revisions, and cannot move a terminal state back to work. History includes the latest stored metadata; joining an ended run emits the latest snapshot before `done`. Legacy streams and messages remain valid.

The final interaction is emitted before the durable run buffer closes. Evidence references are private host state: they are not copied into the public stream or Matrix reaction. Progress/status cards use the gateway's encrypted event path. A native reaction contains only `m.relates_to` with `m.annotation`, the source event ID, and a standard emoji.

## Host evidence and waiting

The runtime context provides optional `interactions.setWaiting(boolean)`, `needsAttention()`, and `verifiedAchievement({ kind, reference })`. These APIs are host surfaces, not model tools. Use the exported adapters:

```ts
reportPersistedArtifact(ctx, { artifactId: persistedRecord.artifactId });
reportVerifiedTaskCompletion(ctx, {
  taskId: task.id,
  status: 'completed',
  completionReceipt: verifiedReceipt.id,
});
const answer = await withHumanInput(ctx, () => requestApproval());
```

The task adapter requires completed status and a nonempty verified receipt. The adapter caller must actually verify it; a generated claim or a generic successful tool return is insufficient. The built-in chat artefact store reports success only after persistence. Matrix turns promote to 🎉 only after the gateway confirms reply event IDs. Wallet-signing requests use explicit waiting scopes; prepared transactions that still need approval retain waiting. Uncertain write claims mark attention even if the model later produces fluent text. `work_status` now supports waiting, failed, cancelled, and superseded; error paths do not unconditionally mark Done.

## Persistence and recovery

Each request's latest snapshot and private outcome evidence are stored in the user object. A separate pending-publication queue persists before gateway RPC; an alarm retries it even after the run ends. Confirmations remove only pending revisions that have actually been admitted by the gateway. The gateway persists desired reactions, owned event IDs, retired reactions, and pending send intent. Sending intent is stored before transport; after a lost send response, recovery confirms the same deterministic transaction before replacing the reaction. Redaction deletes only event IDs recorded by this coordinator. Duplicate annotations are adopted only when sender, emoji, and transaction identity match. Human and unrelated oracle reactions are untouched.

A source mirror may arrive after completion. Confirmed IDs bind without regressing state. Portal mirror intent survives object reset, is replayed from the alarm with stable transaction IDs and per-session ordering, and expires after seven days. Pending reactions reconcile on gateway startup and alarms. Transport errors are logged/retried and do not fail agent execution. Revisions and terminal tombstones reject late working heartbeats.

Typing is owned by the gateway, with a separate lease for each session/request within its oracle identity. Active leases renew every 20 seconds using Matrix's 30-second timeout. Completing one run leaves other room leases active. Waiting and terminal states release the lease. Persisted leases restore only their remaining lifetime, expire after 60 seconds without a producer heartbeat, and persist their release. Personal requests use the session's known room even while mirror confirmation is pending.

Reaction records and terminal typing tombstones currently follow the gateway object's lifetime; they have no separate compaction policy. Do not delete them independently of deduplication/recovery state.

## Release and staging gate

1. Merge the events contract, SDK, and Workers runtime together; resolve this changeset alongside existing pending changesets.
2. Publish and inspect the required events, SDK, Workers, and transitive package tarballs. QiForge main also introduces `@ixo/ixo-transaction`; it must be available to install the resulting runtime. Do not assume a workspace build proves registry availability.
3. Install the exact published candidates in clean Companion and Portal checkouts. Run focused tests, typechecks, lint, formatting, and both Companion Wrangler dry-run bundles.
4. Pin verified releases in Companion and Portal, then deploy the compatible gateway and oracle to Workers staging. Keep production rollout gated on the checks below.

At implementation time, registry queries returned runtime 0.13.0, SDK 1.4.0, and events 2.0.0. The configured registry lookup for the new `@ixo/ixo-transaction` returned 404. Consumer pins are intentionally unchanged until compatible releases are available; local validation used the candidate workspace packages.

### Two-client staging acceptance

Use two signed-in identities in the same staging room. Record room, oracle DID, release versions, deployment commits, and observed event IDs without credentials.

- Mention Qi from client A. Both clients observe 👀, then 👍 and native room activity. A normal response ends with ✅ and releases activity.
- Persist an artefact and follow its delivered link: both clients see 🎉 only after confirmed delivery. A successful read/tool call alone must end with ✅.
- Trigger explicit approval; both clients see ⏸️ and no typing while waiting. Resume and verify activity and the final state.
- Exercise failure, uncertain write outcome, user cancellation, and supersession; verify ⚠️ or ⏹️, accurate status copy, and no lingering typing.
- Run two users' requests concurrently; finish either first and verify activity continues for the other. Include a second oracle and human reactions on the source message.
- Send attachment batches, duplicate delivery, delayed mirror confirmation, and a rate-limited reaction. Reset a Worker and reconnect/switch SDK sessions. Verify one coordinator-owned current reaction, preserved human reactions, current history metadata, and no repeated replies.

The SDK ESM/CJS/declaration build passes; its raw TypeScript check retains six pre-existing diagnostics (confirmed against the base). Workers and Companion TypeScript checks pass. Changed-file lint and formatting pass, with three existing lint warnings in the Workers runtime context.

Focused automated suites cover these units and existing engagement/attachment/stream paths, including simulated coordinator restoration. They do not replace this live two-client verification. Staging deployment and live acceptance have not been performed in this change.

See the [Matrix reaction contract](https://spec.matrix.org/latest/client-server-api/#mreaction) and [typing contract](https://spec.matrix.org/latest/client-server-api/#typing-notifications).
