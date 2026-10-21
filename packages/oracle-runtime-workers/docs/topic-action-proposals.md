# Durable conversational topic actions

ORA-809 extends the [action proposal](action-proposals.md) flow with standard discussion draft creation and claim-access grants. Existing transfer proposals retain v1 schemas and digests. Topic proposals use v2 and the `action-proposal/v2` digest namespace.

Both `ACTION_PROPOSALS_ENABLED` and `ACTION_TOPIC_PROPOSALS_ENABLED` must be `true` to prepare a topic action, to claim one and to permit its steps. Both default to `false`; `validateEnv` refuses the topic switch without the base switch. Keep them disabled until IXO-5618 records the real end-to-end acceptance evidence. Switching them off stops new cards, claims and permits; authenticated reads, reconciliation and receipts for cards already in flight keep working. This source change does not deploy or activate a capability.

## Rules the owner object enforces

- **Two windows.** The card's 15-minute expiry bounds every attempt to start until some step has a reference recorded or is verified, a permitted-but-never-sent first step included. From then on the remaining steps may start until **one hour after the claim** (`TOPIC_EXECUTION_WINDOW_MS`), so a topic whose anchor and body were posted at minute fourteen still gets its operation and snapshot instead of being left half-created. After the window the card stays `unknown` with its partial references listed; the owner can revoke it.
- **A permit is retried, not burned.** `begin-step` for a step that is started, has no reference recorded yet and names the same executor, `deviceId` included, returns the _same_ frozen permit (same effect, same transaction id, so a repeated send from that device is a no-op at the homeserver). A failed Portal pre-check or a wallet cancel therefore does not lock the step until expiry. Another device of the same owner, or a step with a reference recorded, answers `already_started`; the step record carries `startedAt` and `executor`. The Portal sends its Matrix device id as `executor.deviceId` in the begin-step request; the runtime compares it from the journal and never echoes it, so step records and permits carry the identity-only executor every consumer's contract knows.
- **Local before remote.** Not claimed, expired, out of order, another executor, a concurrent grant, a reference already recorded: answered from the journal in milliseconds. Only a step that could actually start pays for the ten-second authority read.
- **One grant in flight per account.** A second card granting the same account the same role under the same admin (any collection) is refused with the blocking card's id (`Another grant for this account is still in progress (ap_…)`) while the other card's grant step may still be broadcast (no reference yet, inside its holder's execution window) or may still land (a reference recorded, verification not given up); a revoked card holds the lock as long as its hash may still land. Otherwise the two would overwrite each other on chain while both receipts said granted.
- **Grant expiry is the authorization's.** `MsgGrantEntityAccountAuthz` carries one expiry for every constraint in it. Merging a new constraint into an existing grant is allowed only when the requested expiry is the existing one; a grant with no expiry on chain, or another date, is refused with the date in the message. The owner either asks for the same expiry or revokes first.
- **Fingerprints cover authority, not activity.** The topic dependency digests the authority chain head and the pinned body (a new contract operation changes it); the room dependencies digest each policy event's content and the owner's membership _value_ (not avatar or display name, not event ids). Replies in the topic thread do not block a claim.
- **409 or 503.** Every fact the reads established about the card or its authority having changed (`Proposal changed`, the owner no longer a member or able to write, an NFT transferred, a collection re-bound, a history forked, a DID service edited, a plan changed, a receipt not matching, an event bound to another room, authority content the contract does not accept, …) is an `ActionProposalConflict` and a `409 { error }` the Portal shows and retries after a re-read; the message is one of the runtime's own sentences, never a schema's issue dump or a builder's internals (those go to the log). A read that failed, timed out or came back oversized or unparseable (`TopicReadUnavailable`: a DID resolver or RPC down or misconfigured, a fetch that threw, the gateway's bounds, an event not decryptable yet, the ten-second budget) is a `503 { error: 'Topic authority is unavailable' }` to retry later; the reason is logged (`[topic-actions] <id> authority unavailable: …`), never sent. Every authority read ends in `withTopicReadBudget`, which types whatever leaves it (`typedTopicError`); anything it cannot type is a bug and surfaces as a 500.
- **A rejected reference is set aside.** A grant reference the verifier _proved_ is another transaction (the bytes hash differently, another card's memo, other messages) is moved to `reference_rejected`: the step stays started with no reference, so it leaves the verification schedule and the grant lock follows its execution window; the same executor gets its permit back to sign the right transaction, `topic-reconcile` with the right hash records it (fresh verification schedule), and the rejected hash is refused again (`Step reference was rejected`). A transaction not indexed yet, or a read that failed, is just retried on the cooldown.
- **The topic store is optional at boot.** If its tables cannot be opened the object logs it and serves transfer cards, channel turns, receipts and the alarm without it; topic preparation is unavailable and every topic route answers `503`. A reference row the build can no longer parse is quarantined (`verify_attempts` at the cap, logged) by the alarm or the next channel poll instead of failing them.
- **Background reconciliation and receipts** follow the transfer cards' schedule ([action-proposals](action-proposals.md#background-verification-and-receipts)): recorded references are re-verified from the alarm with a doubling cooldown (the attempt is spent before the references are read), receipts back off and are abandoned or quarantined, finished cards are pruned after 90 days.

## Running on Workers

`@ixo/topic-protocol` builds its JSON-schema validators with Ajv, which generates code from strings; Cloudflare Workers forbid that, and `1.0.0-rc.7` compiles at module load, so a Worker bundling it fails at boot. The runtime requires a release with precompiled validators (`1.0.0-rc.8`, [topic-protocol PR 37](https://github.com/ixoworld/topic-protocol/pull/37)). `src/core/topic-protocol-runtime.test.ts` (Node project only) imports the pinned package and validates with it in a child process started with `--disallow-code-generation-from-strings`, and fails the suite on a build that would not run.

## Authority and execution

QiForge extracts a bounded candidate from current human conversation evidence and uses Decisions to evaluate that interpretation. Deterministic code validates schemas, resolves identities and reads current authority. Incomplete, unsupported or ambiguous inputs require clarification.

The owner Durable Object stores the immutable proposal, exact digest, conversation origin and effect journal. Portal obtains explicit consent and claims the proposal. Before every new effect, QiForge rechecks the pinned authority and atomically records a one-use permit. Portal executes through its existing owner Matrix account or wallet. Bot credentials are used for passive evidence reads and cannot act as the owner's signing authority.

```text
validated candidate + trusted context
  durable immutable proposal
  owner review and claim
  fresh authority check
  durable one-use step permit
  existing Portal repository or wallet
  independently verified event references or transaction hash
  durable receipt to originating conversation
```

An effect that has started never becomes pending again. A missing permit response, Matrix response, wallet response or reconciliation response preserves uncertainty. Reconciliation accepts references, verifies the frozen expected effect and unlocks only untouched later steps. A revocation tombstone prevents new effects while allowing an already-started effect to be reconciled.

## Topic creation

The first adapter creates a standard discussion draft in an existing selected room. Other kinds, custom profiles, project/task recipes, invitations, room creation, automatic acceptance, funding and program mutation are outside this adapter. They require clarification rather than silent conversion to a discussion.

The shared `@ixo/ixo-transaction/topic-create-plan` encoder uses `@ixo/topic-protocol` 1.0.0-rc.7. It freezes the canonical v4 body, resolved shape, explicit participants and roles, title, tags, temporal mode, owner identity, generated IDs, proposal marker and evaluation time. Only independently verified root/body event references are substituted into later transport envelopes. The canonical Portal repository compares these values before writing.

The journal contains `anchor`, `body`, `operation` and `snapshot` steps. Every step requires its own one-use permit and verified predecessors. Topic operations use the protocol's `m.reference` relation. Bounded history reads must include canonical operation relations and refuse incomplete or forked evidence. A successful receipt records the actual verified Matrix root, body, operation and state event IDs. It does not fabricate a transaction hash or assert that participants joined a room.

## Claim access

Access grants are chain authorizations, not Matrix membership changes. The supported topic must have a verified canonical v4 body, claim binding and explicit `worker` or `evaluator` role assignments. A worker may receive submit-claim access; an evaluator may receive evaluate-claim access. Other topic roles do not imply these permissions.

The adapter verifies authenticated topic history and pinned body integrity, then queries the configured chain for the entity/admin account, collection binding, actual CW721 NFT owner and current authorization. Unavailable, truncated, delegated or forked authority evidence requires clarification. The actual NFT owner signs the exact encoded `MsgGrantEntityAccountAuthz` messages. Same-collection constraints are replaced once, unrelated constraints are preserved, and absolute expiry, quotas, limits, evaluator deadlines and memo are frozen for review.

The `grant` step becomes successful or failed only after the configured chain confirms the matching chain ID, transaction hash, exact ordered messages and memo. An ambiguous response remains unknown and is never blindly resubmitted.

## Private review and receipts

The existing Portal route `/a/<opaque-proposal-id>` preserves login continuation and owner authentication. URLs contain no DID, CID, credentials or execution arguments. Opening a link or preview performs no action. Private proposal responses use `private, no-store`; versioned static renderer assets may use public Cloudflare caching.

Portal retains only minimal owner/proposal/digest-scoped event or hash references for recovery. Recovered references do not confer authority. Every subsequent read and operation still authenticates the owner and validates the immutable proposal.

Channel outcomes use typed v2 receipts. The gateway preserves the original sealed request, binding, run, session, proposal and digest checks before delivery. It renders the readable title and friendly URL. Runtime Matrix receipts likewise use the recorded conversation origin. Neither transport delivery nor local browser state proves action success.

## Release evidence

Local tests must cover canonical producer equality, changed identities and authority, exact grant constraints, concurrent claims and permits, restart recovery, revocation, unknown effects, forged references, bounded timeouts, delayed read reconciliation and v1 regressions. The gateway must prove restart delivery and duplicate suppression.

Local tests do not close the live release gate. Record the selected provider's real-call verification under ORA-511, exact published and deployed package revisions, encrypted Matrix creation, real owner mobile-wallet signing, WhatsApp-originated review, cross-device recovery, original-session receipts, failure recovery and cold/warm latency. Operator-reviewed screenshots and recordings are required before activation. IXO-5609 and IXO-5618 stay open until these gates pass.
